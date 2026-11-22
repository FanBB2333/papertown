"""Who may open the town: this machine goes straight in; other devices need the access password,
which is set from this machine. "This machine" is a loopback request with no forwarding headers:
`tailscale serve` and other reverse proxies connect from 127.0.0.1 too, but say whom they forward for.

A login is a random token in an HttpOnly cookie; auth.json in the data directory keeps its hash and
the password's scrypt hash:

    {"password": "scrypt$16384$8$1$<salt>$<hash>", "sessions": [{"id": "<sha256>", "at": ..., "seen": ..., "agent": ...}]}
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

COOKIE = "pt_session"
DAYS = 30
MIN_LEN = 6
LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}
FORWARDED = (b"x-forwarded-for", b"forwarded", b"x-real-ip", b"tailscale-user-login")
TRIES, WINDOW, PAUSE = 5, 600, 60  # wrong passwords in a window, then a pause


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
    def __init__(self, data_dir: Path):
        self.path = data_dir / "auth.json"
        self._lock = threading.Lock()
        self._fails: dict[str, list[float]] = {}

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
        sid, cut = _sid(tok), time.time() - DAYS * 86400
        with self._lock:
            d = self._read()
            for s in d.get("sessions") or []:
                if hmac.compare_digest(s["id"], sid) and s.get("t", 0) > cut:
                    if time.time() - s.get("seen_t", 0) > 3600:  # at most hourly, not a write per request
                        s["seen"], s["seen_t"] = now(), time.time()
                        self._write(d)
                    return True
        return False

    def allowed(self, scope: dict) -> bool:
        return self.local(scope) or self.session(scope)

    def state(self, scope: dict) -> dict:
        d = self._read()
        local, signed = self.local(scope), self.session(scope)
        out = {"local": local, "password": bool(d.get("password")), "authed": local or signed, "signed_in": signed}
        if out["authed"]:
            out["sessions"] = len(d.get("sessions") or [])
        return out

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
            self._write({"sessions": []})

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
            cut = t - DAYS * 86400
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
    """ASGI middleware: the API answers 401 to a request from elsewhere without a login; the page
    and its assets are served to anyone, so it can show the sign-in."""

    OPEN = ("/api/auth/", "/api/health", "/api/bridge/")  # the bridge checks its agents' own tokens

    def __init__(self, app, auth: Auth):
        self.app = app
        self.auth = auth

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/api/") and not scope["path"].startswith(self.OPEN) \
                and not (scope["method"] == "POST" and scope["path"].startswith("/api/agents/")
                         and scope["path"].endswith("/hook") and len(scope["path"].split("/")) == 5) \
                and not self.auth.allowed(scope):
            body = json.dumps({"detail": "先登录"}, ensure_ascii=False).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
