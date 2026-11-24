"""Who may open the town: this machine goes straight in; other devices sign in with the access password,
or present an access key. "This machine" is a loopback request with no forwarding headers:
`tailscale serve` and other reverse proxies connect from 127.0.0.1 too, but say whom they forward for.

A password login is a random token in an HttpOnly cookie, for the browser. An access key is for apps
(the iPhone and Mac apps, scripts): made on this machine or by a signed-in browser, named for the device,
shown once, sent as `Authorization: Bearer <key>`, and revoked one by one. auth.json in the data directory
keeps only hashes:

    {"password": "scrypt$16384$8$1$<salt>$<hash>",
     "sessions": [{"id": "<sha256>", "at": ..., "seen": ..., "agent": ...}],
     "keys": [{"id": "<8 hex>", "name": "iPhone", "hash": "<sha256>", "hint": "ptk_Ab3d", "at": ..., "seen": ...}]}
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path

from .db import now, read_json, write_json
from .network import Network

COOKIE = "pt_session"
DAYS = 30
MIN_LEN = 6
LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}
FORWARDED = (b"x-forwarded-for", b"forwarded", b"x-real-ip", b"tailscale-user-login")
TRIES, WINDOW, PAUSE = 5, 600, 60  # wrong passwords in a window, then a pause
KEY_PREFIX = "ptk_"
MAX_KEYS = 50


class AuthError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status = status


def _hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${h.hex()}"


def _check(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, want = stored.split("$")
        h = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(h.hex(), want)


def _sid(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Auth:
    def __init__(self, data_dir: Path, net: Network | None = None):
        self.path = data_dir / "auth.json"
        self.net = net or Network()
        self._lock = threading.Lock()
        self._fails: dict[str, list[float]] = {}

    def days(self) -> int:
        """How long a password login lasts (network.json)."""
        return int(self.net.get()["days"])

    def _read(self) -> dict:
        return read_json(self.path, {})

    def _write(self, d: dict) -> None:
        write_json(self.path, d, mode=0o600)

    @staticmethod
    def local(scope: dict) -> bool:
        host = (scope.get("client") or ("", 0))[0]
        return host in LOOPBACK and not any(k in FORWARDED for k, _ in scope.get("headers") or [])

    @staticmethod
    def token(scope: dict) -> str | None:
        for k, v in scope.get("headers") or []:
            if k == b"cookie":
                c = SimpleCookie()
                try:
                    c.load(v.decode("latin-1"))
                except Exception:
                    return None
                return c[COOKIE].value if COOKIE in c else None
        return None

    def session(self, scope: dict) -> bool:
        tok = self.token(scope)
        if not tok:
            return False
        if not self.net.get()["password"]:
            return False
        sid, cut = _sid(tok), time.time() - self.days() * 86400
        with self._lock:
            d = self._read()
            for s in d.get("sessions") or []:
                if hmac.compare_digest(s["id"], sid) and s.get("t", 0) > cut:
                    if time.time() - s.get("seen_t", 0) > 3600:  # at most hourly, not a write per request
                        s["seen"], s["seen_t"] = now(), time.time()
                        self._write(d)
                    return True
        return False

    @staticmethod
    def bearer(scope: dict) -> str | None:
        for k, v in scope.get("headers") or []:
            if k == b"authorization":
                kind, _, value = v.decode("latin-1").partition(" ")
                if kind.lower() != "bearer":
                    return None
                return value.strip() or None
        return None

    def keyed(self, scope: dict) -> bool:
        """The request carries an access key that has not been revoked."""
        tok = self.bearer(scope)
        if not tok or not tok.startswith(KEY_PREFIX) or not self.net.get()["keys"]:
            return False
        h = _sid(tok)
        with self._lock:
            d = self._read()
            for k in d.get("keys") or []:
                if hmac.compare_digest(k["hash"], h):
                    if time.time() - k.get("seen_t", 0) > 3600:  # at most hourly
                        k["seen"], k["seen_t"] = now(), time.time()
                        self._write(d)
                    return True
        return False

    def allowed(self, scope: dict) -> bool:
        return self.local(scope) or self.session(scope) or self.keyed(scope)

    def state(self, scope: dict) -> dict:
        d = self._read()
        local, signed = self.local(scope), self.session(scope)
        keyed = not local and not signed and self.keyed(scope)
        conf = self.net.get()
        out = {"local": local, "password": bool(d.get("password")), "authed": local or signed or keyed,
               "signed_in": signed, "key": keyed, "via": "local" if local else "password" if signed else "key" if keyed else None,
               "methods": {"password": conf["password"], "keys": conf["keys"]}, "days": conf["days"]}
        if out["authed"]:
            out["sessions"] = len(d.get("sessions") or [])
            out["keys"] = len(d.get("keys") or [])
        return out

    # access keys

    def manage(self, scope: dict) -> None:
        """Keys are made and revoked on this machine or from a browser signed in with the password,
        so one leaked key cannot make more."""
        if self.local(scope) or self.session(scope):
            return
        if self.keyed(scope):
            raise AuthError(403, "访问密钥只能在运行 Papertown 的电脑上或用密码登录后管理")
        raise AuthError(401, "先登录")

    def keys(self) -> list[dict]:
        return [{k: x.get(k) for k in ("id", "name", "hint", "at", "seen")} for x in self._read().get("keys") or []]

    def create_key(self, name: str = "") -> dict:
        """A new key; its text is in the reply only, never stored."""
        tok = KEY_PREFIX + secrets.token_urlsafe(32)
        entry = {"id": secrets.token_hex(4), "name": name.strip()[:60] or "设备", "hash": _sid(tok), "hint": tok[:8],
                 "at": now(), "t": time.time(), "seen": None, "seen_t": 0}
        with self._lock:
            d = self._read()
            if len(d.get("keys") or []) >= MAX_KEYS:
                raise AuthError(400, f"访问密钥最多 {MAX_KEYS} 个，先撤销不用的")
            d["keys"] = [*(d.get("keys") or []), entry]
            self._write(d)
        return {**{k: entry[k] for k in ("id", "name", "hint", "at", "seen")}, "key": tok}

    def revoke_key(self, key_id: str) -> None:
        with self._lock:
            d = self._read()
            keep = [k for k in d.get("keys") or [] if k["id"] != key_id]
            if len(keep) == len(d.get("keys") or []):
                raise AuthError(404, "没有这个访问密钥")
            d["keys"] = keep
            self._write(d)

    def set_password(self, scope: dict, new: str, old: str | None = None) -> None:
        if len(new) < MIN_LEN:
            raise AuthError(400, f"密码至少 {MIN_LEN} 位")
        with self._lock:
            d = self._read()
            if not self.local(scope):
                if not d.get("password"):
                    raise AuthError(403, "第一次设置密码要在运行 Papertown 的这台电脑上")
                if not old or not _check(old, d["password"]):
                    raise AuthError(403, "原来的密码不对")
            d["password"] = _hash(new)
            d["changed"] = now()
            self._write(d)

    def clear_password(self, scope: dict) -> None:
        if not self.local(scope):
            raise AuthError(403, "只有在运行 Papertown 的这台电脑上才能取消密码")
        with self._lock:
            self._write({"sessions": [], "keys": self._read().get("keys") or []})  # keys are not the password's

    def _who(self, scope: dict) -> str:
        for k, v in scope.get("headers") or []:
            if k == b"x-forwarded-for":
                return v.decode("latin-1").split(",")[0].strip()
        return (scope.get("client") or ("?", 0))[0]

    def login(self, scope: dict, password: str, agent: str = "") -> str:
        who, t = self._who(scope), time.time()
        fails = [x for x in self._fails.get(who, []) if t - x < WINDOW]
        if len(fails) >= TRIES and t - fails[-1] < PAUSE:
            raise AuthError(429, f"错得太多了，{int(PAUSE - (t - fails[-1])) + 1} 秒后再试")
        if not self.net.get()["password"]:
            raise AuthError(403, "密码登录已关闭，可在运行 Papertown 的电脑上的「网络与安全」中开启")
        d = self._read()
        if not d.get("password"):
            raise AuthError(403, "还没有设置访问密码：先在运行 Papertown 的电脑上设置")
        if not _check(password, d["password"]):
            self._fails[who] = [*fails, t][-TRIES * 2:]
            raise AuthError(401, "密码不对")
        self._fails.pop(who, None)
        tok = secrets.token_urlsafe(32)
        with self._lock:
            d = self._read()
            cut = t - self.days() * 86400
            keep = [s for s in d.get("sessions") or [] if s.get("t", 0) > cut][-49:]
            d["sessions"] = [*keep, {"id": _sid(tok), "at": now(), "t": t, "seen": now(), "seen_t": t, "agent": agent[:160]}]
            self._write(d)
        return tok

    def logout(self, scope: dict) -> None:
        tok = self.token(scope)
        if not tok:
            return
        sid = _sid(tok)
        with self._lock:
            d = self._read()
            d["sessions"] = [s for s in d.get("sessions") or [] if s["id"] != sid]
            self._write(d)

    def end_sessions(self) -> None:
        with self._lock:
            d = self._read()
            d["sessions"] = []
            self._write(d)

    def logout_all(self, scope: dict) -> int:
        """Every device signs in again (this one too, when it signed in)."""
        if not self.allowed(scope):
            raise AuthError(401, "先登录")
        with self._lock:
            d = self._read()
            n = len(d.get("sessions") or [])
            d["sessions"] = []
            self._write(d)
        return n


class Gate:
    """ASGI middleware. A device whose address is outside the allowed sources (network.json) gets 403
    for everything, the page too. Otherwise the API answers 401 to a request from elsewhere without a
    login; the page and its assets are served to anyone, so it can show the sign-in."""

    OPEN = ("/api/auth/", "/api/health", "/api/bridge/")  # the bridge checks its agents' own tokens

    def __init__(self, app, auth: Auth):
        self.app = app
        self.auth = auth

    @staticmethod
    def agents_own(scope) -> bool:
        """An agent's hook or the bridge: they check the agent's own token, from wherever the agent runs."""
        path = scope["path"]
        return path.startswith("/api/bridge/") or (scope.get("method") == "POST" and path.startswith("/api/agents/")
                                                    and path.endswith("/hook") and len(path.split("/")) == 5)

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and not self.agents_own(scope) and not self.auth.net.admits(scope):
            src = self.auth.net.source(scope) or "?"
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
                return
            api = scope["path"].startswith("/api/")
            msg = f"来源 {src} 不在 Papertown 允许的范围内，可在运行 Papertown 的电脑上的「设置 › 网络与安全」中添加"
            body = json.dumps({"detail": msg}, ensure_ascii=False).encode() if api else msg.encode()
            kind = b"application/json" if api else b"text/plain; charset=utf-8"
            await send({"type": "http.response.start", "status": 403,
                        "headers": [(b"content-type", kind), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        if scope["type"] == "http" and scope["path"].startswith("/api/") and not scope["path"].startswith(self.OPEN) \
                and not self.agents_own(scope) and not self.auth.allowed(scope):
            body = json.dumps({"detail": "先登录"}, ensure_ascii=False).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
