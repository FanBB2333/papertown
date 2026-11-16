"""Papertown's API by files, for agents in a sandbox without network: when HTTP is blocked, `pt`
writes the request as a file in q/ beside itself and the server answers it in a/. Only reads and
the agent's own bridge go through.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .town import Town

OPEN = urllib.request.build_opener(urllib.request.ProxyHandler({})).open  # to this server itself, never through a proxy


class Relay:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._watch, daemon=True, name="relay")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._thread = None

    def _dirs(self) -> list[tuple[str, Path]]:
        """Each agent that may write requests, with the folder it writes them in."""
        rows = self.town.db.q("select id, role, line_id from agents where id = 'assistant' or runtime = 'paseo'")
        return [(a["id"], self.town.agents.pt(a).parent / "q") for a in rows]

    def _watch(self) -> None:
        dirs, seen = [], 0.0
        while not self._halt.wait(0.3):
            if time.time() - seen > 3:
                try:
                    dirs, seen = self._dirs(), time.time()
                except Exception:  # noqa: BLE001 - a busy database is asked again on the next turn
                    pass
            for agent_id, q in dirs:
                try:
                    found = sorted(q.glob("*.json")) if q.is_dir() else []
                except OSError:
                    continue
                for f in found:
                    threading.Thread(target=self._relay, args=(agent_id, f), daemon=True).start()

    def _relay(self, agent_id: str, f: Path) -> None:
        """Send on one request `pt` left as a file, and write the answer beside it."""
        try:
            req = json.loads(f.read_text(encoding="utf-8"))
            f.unlink()
        except (OSError, json.JSONDecodeError):
            return
        method, path, body = str(req.get("method") or "GET"), str(req.get("path") or ""), req.get("body")
        if not path.startswith("/api/") or method not in ("GET", "POST") or method == "POST" and not path.startswith(f"/api/bridge/{agent_id}/"):
            out = {"status": 400, "body": {"detail": f"不能经过这里转发：{method} {path}"}}
        else:
            out = self._fetch(method, path, body, str(req.get("token") or ""))
        ans = f.parent.parent / "a" / f.name
        try:
            tmp = ans.with_suffix(".tmp")
            tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
            tmp.replace(ans)
        except OSError:
            pass

    def _fetch(self, method: str, path: str, body: object, token: str) -> dict:
        req = urllib.request.Request(self.s.url.rstrip("/") + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "x-papertown-token": token})
        try:
            with OPEN(req, timeout=60) as r:
                return {"status": r.status, "body": json.load(r)}
        except urllib.error.HTTPError as e:
            try:
                return {"status": e.code, "body": json.load(e)}
            except (json.JSONDecodeError, ValueError):
                return {"status": e.code, "body": {"detail": str(e)}}
        except (OSError, ValueError) as e:
            return {"status": 502, "body": {"detail": f"Papertown 没有回应：{e}"}}
