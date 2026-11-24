"""How Papertown is reached, kept in papertown.toml (config.py):

    [server]
    host = "127.0.0.1"
    port = 31640

    [network]
    sources = ["lan", "tailscale"]
    password = true
    keys = true
    days = 30

`host` and `port` are where `papertown serve` listens; they are read when it starts, so a change waits
for the next start (--host or --port on the command line, or PAPERTOWN_HOST / PAPERTOWN_PORT, win). The rest is
read again whenever the file changes, so it holds from the next request:
`sources` are the addresses other devices may come from (a preset or an address or network), and
`password` and `keys` turn the two ways of signing in on or off. This machine always gets in.

A request through a reverse proxy on this machine (`tailscale serve`, nginx) comes from 127.0.0.1 and
names the device it forwards for; that device is its source. Such headers from elsewhere are ignored.
"""

from __future__ import annotations

import ipaddress
import os
import re
import subprocess
from pathlib import Path

from .config import DEFAULT_HOST, DEFAULT_PORT, config_path, read_config, set_config

LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}
FORWARDED = (b"x-forwarded-for", b"forwarded", b"x-real-ip", b"tailscale-user-login")
PRESETS: dict[str, list[str]] = {
    "lan": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10"],
    "tailscale": ["100.64.0.0/10", "fd7a:115c:a1e0::/48"],
    "any": ["0.0.0.0/0", "::/0"],
}
HOSTS = ("127.0.0.1", "0.0.0.0")
DAYS = (1, 7, 30, 90)
# the [network] table: default, and its line in papertown.example.toml
NETWORK_DOCS = {
    "sources": (["lan", "tailscale"], 'where other devices may come from: "lan", "tailscale", "any", or an address or network such as "203.0.113.0/24"'),
    "password": (True, "other devices' browsers may sign in with the access password"),
    "keys": (True, "the apps and scripts may connect with access keys"),
    "days": (30, "how long a password sign-in lasts: 1, 7, 30 or 90"),
}
DEFAULTS = {"host": DEFAULT_HOST, "port": DEFAULT_PORT} | {k: v[0] for k, v in NETWORK_DOCS.items()}
MAX_SOURCES = 32


class NetworkError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _nets(sources: list[str]) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    out = []
    for s in sources:
        for n in PRESETS.get(s, [s]):
            try:
                out.append(ipaddress.ip_network(n, strict=False))
            except ValueError:
                pass
    return out


def _ip(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    text = text.strip().strip('"')
    if text.startswith("["):  # [v6]:port
        text = text[1:].split("]")[0]
    elif text.count(":") == 1:  # v4:port
        text = text.split(":")[0]
    try:
        a = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return None
    return a.ipv4_mapped or a if isinstance(a, ipaddress.IPv6Address) else a


def kind(ip: str) -> str | None:
    """Which preset an address belongs to: tailscale, lan, or None (the internet)."""
    a = _ip(ip)
    if a is None:
        return None
    for name in ("tailscale", "lan"):
        if any(a in n for n in _nets([name])):
            return name
    return None


def addresses() -> list[dict]:
    """This machine's own addresses that other devices could use, best effort, loopback left out."""
    found: list[str] = []
    for cmd in (["ip", "-o", "addr", "show"], ["ifconfig"]):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        found = re.findall(r"\binet6?\s+(?:addr:)?([0-9a-fA-F:.]+)", out)
        if found:
            break
    seen, rows = set(), []
    for ip in found:
        a = _ip(ip)
        # 198.18.0.0/15 is for benchmarks; proxies (Surge, Clash) give their virtual interfaces one
        if a is None or a.is_loopback or a.is_link_local or a in ipaddress.ip_network("198.18.0.0/15") or ip in seen:
            continue
        seen.add(ip)
        rows.append({"ip": str(a), "kind": kind(str(a))})
    rows.sort(key=lambda r: ({"tailscale": 0, "lan": 1}.get(r["kind"] or "", 2), ":" in r["ip"], r["ip"]))
    return rows


class Network:
    def __init__(self, path: Path | None = None):
        self.path = path or config_path()

    def get(self) -> dict:
        conf = read_config(self.path)
        server, network = conf.get("server", {}), conf.get("network", {})
        out = dict(DEFAULTS)
        out.update({k: server[k] for k in ("host", "port") if k in server})
        out.update({k: network[k] for k in NETWORK_DOCS if k in network})
        return out

    @staticmethod
    def local(scope: dict) -> bool:
        host = (scope.get("client") or ("", 0))[0]
        return host in LOOPBACK and not any(k in FORWARDED for k, _ in scope.get("headers") or [])

    @staticmethod
    def source(scope: dict) -> str | None:
        """The device a request is from: None for this machine, "" when a proxy here does not say."""
        host = (scope.get("client") or ("", 0))[0]
        if host not in LOOPBACK:
            return host
        heads = {k: v.decode("latin-1") for k, v in scope.get("headers") or [] if k in FORWARDED}
        if not heads:
            return None
        if b"x-forwarded-for" in heads:
            return heads[b"x-forwarded-for"].split(",")[0].strip()
        if b"x-real-ip" in heads:
            return heads[b"x-real-ip"].strip()
        if b"forwarded" in heads:
            m = re.search(r'for="?([^;,"]+)', heads[b"forwarded"], re.I)
            if m:
                return m.group(1)
        return ""

    def admits(self, scope: dict, conf: dict | None = None) -> bool:
        src = self.source(scope)
        if src is None:
            return True
        conf = conf or self.get()
        if src == "":  # a proxy here that names no address: Tailscale's says who, not where
            heads = {k for k, _ in scope.get("headers") or []}
            return "any" in conf["sources"] or (b"tailscale-user-login" in heads and "tailscale" in conf["sources"])
        a = _ip(src)
        return a is not None and any(a in n for n in _nets(conf["sources"]))

    def set(self, values: dict, scope: dict) -> dict:
        conf = {**self.get(), **{k: v for k, v in values.items() if k in DEFAULTS and v is not None}}
        if conf["host"] not in HOSTS:
            raise NetworkError(400, "监听地址只能是仅本机或所有网络")
        if not isinstance(conf["port"], int) or not 1024 <= conf["port"] <= 65535:
            raise NetworkError(400, "端口要在 1024 到 65535 之间")
        if conf["days"] not in DAYS:
            raise NetworkError(400, "登录有效期只能是 1、7、30 或 90 天")
        clean: list[str] = []
        for s in conf["sources"]:
            s = str(s).strip()
            if s not in PRESETS:
                try:
                    s = str(ipaddress.ip_network(s, strict=False))
                except ValueError:
                    raise NetworkError(400, f"「{s}」不是 IP 地址或网段")
            if s not in clean:
                clean.append(s)
        if len(clean) > MAX_SOURCES:
            raise NetworkError(400, f"来源最多 {MAX_SOURCES} 条")
        conf["sources"] = clean
        conf["password"], conf["keys"] = bool(conf["password"]), bool(conf["keys"])
        if not self.local(scope):  # from another device: nothing that shuts it out
            if conf["host"] == "127.0.0.1":
                raise NetworkError(403, "改为仅本机监听要在运行 Papertown 的这台电脑上操作")
            if not conf["password"]:
                raise NetworkError(403, "关闭密码登录要在运行 Papertown 的这台电脑上操作")
            if not self.admits(scope, conf):
                raise NetworkError(403, "这样设置会拒绝你当前所在的来源，请保留它")
        set_config("server", {"host": conf["host"], "port": conf["port"]}, self.path)
        set_config("network", {k: conf[k] for k in NETWORK_DOCS}, self.path)
        return conf

    def view(self, scope: dict) -> dict:
        """The settings, where the server listens now, this machine's addresses, and the asking device."""
        conf = self.get()
        listen = os.environ.get("PAPERTOWN_LISTEN", "")
        host, _, port = listen.rpartition(":")
        src = self.source(scope)
        return {**conf, "file": str(self.path), "listening": {"host": host, "port": int(port)} if port.isdigit() else None,
                "addresses": addresses(), "presets": PRESETS,
                "you": {"local": src is None, "ip": src or None, "kind": kind(src) if src else None}}
