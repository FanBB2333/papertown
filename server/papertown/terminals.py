"""Existing herdr terminals, with local read receipts and durable queued messages."""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .db import now
from .herdr import Feed, Herdr, HerdrError
from .project_dirs import owner, project_roots

if TYPE_CHECKING:
    from .town import Town

KEYS = {"enter", "esc", "up", "down", "1", "2", "3", "y", "n", "ctrl+c"}
INTERRUPT_TIMEOUT = 10


class Terminals:
    def __init__(self, town: Town):
        self.town, self.db = town, town.db
        self.client = Herdr(town.s)
        self._lock = threading.RLock()
        self._delivery = threading.RLock()
        self._raw: dict[str, dict] = {}
        self._buckets: dict[str, tuple[str, str | None, str]] = {}
        self._released: dict[str, int] = {}
        self._ok = False
        self._note = "herdr 没有运行" if self.client.enabled else "herdr 接入已关闭"
        self._installed = bool(shutil.which("herdr") or Path("/opt/homebrew/bin/herdr").is_file())
        self._halt, self._wake = threading.Event(), threading.Event()
        self._thread: threading.Thread | None = None
        self._feed: Feed | None = None

    def start(self) -> None:
        if self._thread or not self.client.enabled:
            return
        self._halt.clear()
        self._feed = Feed(self.client, self._event)
        self._thread = threading.Thread(target=self._run, daemon=True, name="herdr-watch")
        self._thread.start()

    def shutdown(self) -> None:
        self._halt.set()
        self._wake.set()
        if self._feed:
            self._feed.close()
        if self._thread:
            self._thread.join(timeout=5)
        self._thread, self._feed = None, None

    def _event(self, event: dict) -> None:
        self._wake.set()
        pane = event.get("data", {}).get("pane_id")
        with self._lock:
            ids = [k for k, a in self._raw.items() if a.get("pane_id") == pane]
        for terminal_id in ids:
            self._publish(terminal_id)
        if not pane:
            self._publish("")

    def _run(self) -> None:
        while not self._halt.is_set():
            self._wake.clear()
            self.refresh()
            self._wake.wait(10)

    def status(self) -> dict:
        with self._lock:
            return {"ok": self._ok, "note": self._note, "live": bool(self._feed and self._feed.live)}

    def info(self) -> dict:
        with self._lock:
            return self.status() | {"socket": str(self.client.path), "count": len(self._raw),
                                    "installed": self._installed, "enabled": self.client.enabled}

    def _publish(self, terminal_id: str) -> None:
        self.town.bus.publish("terminal", id=f"herdr:{terminal_id}" if terminal_id else "")

    def refresh(self) -> None:
        # Socket I/O only takes the delivery lock. Overview reads never wait for a host request.
        with self._delivery:
            try:
                rows = self.client.agents()
                raw = {a["terminal_id"]: a for a in rows}
                ok, note = True, ""
            except HerdrError as e:
                raw, ok, note = {}, False, str(e)
            with self._lock:
                old, status_changed = self._raw, (self._ok, self._note) != (ok, note)
                self._raw, self._ok, self._note = raw, ok, note
                changed = {k for k in old.keys() | raw.keys() if old.get(k) != raw.get(k)}
                for k in changed:
                    if k in raw:
                        self._public(raw[k])
                    else:
                        self._buckets.pop(k, None)
            if self._feed:
                self._feed.follow({a["pane_id"] for a in raw.values()})
            for k in changed:
                self._publish(k)
            if status_changed:
                self._publish("")
            for a in raw.values():
                terminal_id = a["terminal_id"]
                if a.get("agent_status") not in ("idle", "done"):
                    self._released.pop(terminal_id, None)
                    continue
                token = a.get("completion_seq") or 0
                row = self.db.one("select * from terminal_queue where terminal_id = ? and state = 'queued' order by id limit 1", terminal_id)
                if row and self._released.get(terminal_id) != token:
                    self._released[terminal_id] = token
                    try:
                        self._send_queue(row, settled=True)
                    except HerdrError:
                        pass  # Keep the message visible for an explicit retry.

    def _require(self, id: str) -> dict:
        with self._lock:
            a = self._raw.get(id.removeprefix("herdr:")) if id.startswith("herdr:") else None
            if not a:
                raise HerdrError(self._note if not self._ok else "没有这个终端会话")
            return a.copy()

    def _current(self, id: str, timeout: float | None = None) -> dict:
        a = self._require(id)
        # agent.* accepts pane IDs, not terminal IDs. Reject a reused pane before sending input.
        fresh = self.client.get(a["pane_id"], timeout)
        if fresh["terminal_id"] != a["terminal_id"]:
            raise HerdrError("终端会话已变更，请重新选择")
        with self._lock:
            before = self._public(a)
            self._raw[a["terminal_id"]] = fresh
            changed = self._public(fresh) != before
        # Screen revisions alone must not make a detail read trigger another immediate read.
        if changed:
            self._publish(a["terminal_id"])
        return fresh

    def _public(self, a: dict) -> dict:
        terminal_id, status = a["terminal_id"], a.get("agent_status")
        seq = a.get("completion_seq") or 0
        seen = self.db.val("select seq from terminal_seen where terminal_id = ?", terminal_id) or 0
        unread = status in ("idle", "done") and seq > seen
        bucket, why = "idle", None
        if status == "blocked":
            bucket, why = "needs", "terminal"
        elif status == "working":
            bucket = "working"
        elif unread:
            bucket, why = "review", "finished"
        elif status == "unknown":
            why = "unknown"
        before = self._buckets.get(terminal_id)
        since = before[2] if before and before[:2] == (bucket, why) else now()
        self._buckets[terminal_id] = (bucket, why, since)
        queued = self.db.val("select count(*) from terminal_queue where terminal_id = ? and state in ('queued', 'sending', 'failed')", terminal_id)
        title = a.get("title") or a.get("terminal_title_stripped") or ""
        watch = {"bucket": bucket, "why": why, "since": since, "turn": since if bucket == "working" else None,
                 "doing": {"kind": "title", "text": title} if title else None,
                 "queued": queued, "unread": unread, "permissions": [], "asks": []}
        return {"id": f"herdr:{terminal_id}", "terminal_id": terminal_id, "pane_id": a["pane_id"],
                "workspace_id": a.get("workspace_id"), "tab_id": a.get("tab_id"), "name": a.get("name"),
                "kind": a.get("agent") or a.get("display_agent"), "title": title,
                "agent_session": a.get("agent_session"),
                "cwd": a.get("foreground_cwd") or a.get("cwd"), "watch": watch}

    def all(self) -> list[dict]:
        with self._lock:
            return [self._public(a) for a in self._raw.values()]

    def grouped(self, lines: list[dict], agents: list[dict]) -> tuple[dict[str, list[dict]], list[dict]]:
        roots = project_roots(self.town, lines, agents)
        groups: dict[str, list[dict]] = {line["id"]: [] for line in lines}
        others = []
        for terminal in self.all():
            lid = owner(terminal["cwd"], roots)
            (groups[lid] if lid else others).append(terminal)
        return groups, others

    def detail(self, id: str) -> dict:
        with self._delivery:
            a = self._require(id)
            fresh = self._current(id)
            text = self.client.read(fresh["pane_id"])
            with self._lock:
                terminal = self._public(fresh)
            queued = self.db.q("select * from terminal_queue where terminal_id = ? and state in ('queued', 'sending', 'failed') order by id", a["terminal_id"])
            return {"terminal": terminal, "text": text, "queued": queued}

    def seen(self, id: str) -> dict:
        with self._lock:
            a = self._require(id)
            seq = a.get("completion_seq") or 0
            previous = self.db.val("select seq from terminal_seen where terminal_id = ?", a["terminal_id"])
            if previous is None or seq > previous:
                self.db.x("insert into terminal_seen values (?, ?, ?) on conflict(terminal_id) do update set seq = excluded.seq, at = excluded.at",
                          a["terminal_id"], seq, now())
                self._publish(a["terminal_id"])
            return self._public(a)

    def keys(self, id: str, keys: list[str]) -> dict:
        if not keys or any(k not in KEYS for k in keys):
            raise HerdrError("仅支持 Enter、Esc、↑、↓、1、2、3、y、n 和 Ctrl+C")
        with self._delivery:
            a = self._current(id)
            result = self.client.keys(a["pane_id"], keys)
            self._publish(a["terminal_id"])
            self._wake.set()
            return result

    def say(self, id: str, text: str, mode: str | None = None) -> dict:
        text = text.strip()
        if not text:
            raise HerdrError("请输入消息")
        if mode not in (None, "steer", "queue", "interrupt"):
            raise HerdrError("没有这种发送方式")
        with self._delivery:
            a = self._require(id)
            terminal_id = a["terminal_id"]
            if mode == "queue":
                row_id = self.db.insert("terminal_queue", {"terminal_id": terminal_id, "text": text, "created_at": now(), "state": "queued"})
                row = self.db.one("select * from terminal_queue where id = ?", row_id)
                self._publish(terminal_id)
                self.seen(id)
                self._wake.set()
                return row
            a = self._current(id)
            if mode == "interrupt":
                self.client.keys(a["pane_id"], ["esc"])
                self._publish(terminal_id)
                self._wake.set()
                deadline = time.monotonic() + INTERRUPT_TIMEOUT
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or self._halt.is_set():
                        raise HerdrError("终端里的 agent 尚未停止，消息未发送")
                    fresh = self._current(id, timeout=min(self.client.timeout, remaining))
                    if fresh.get("agent_status") != "working":
                        a = fresh
                        break
                    if self._halt.wait(min(0.1, max(0, deadline - time.monotonic()))) or time.monotonic() >= deadline:
                        raise HerdrError("终端里的 agent 尚未停止，消息未发送")
            result = self.client.prompt(a["pane_id"], text)
            self.seen(id)
            self._publish(terminal_id)
            self._wake.set()
            return result

    def _send_queue(self, row: dict, settled: bool = False) -> dict:
        a = self._current(f"herdr:{row['terminal_id']}")
        if settled and a.get("agent_status") not in ("idle", "done"):
            return row
        # Persist the in-flight state before writing. A lost reply must never cause automatic resubmission.
        self.db.update("terminal_queue", {"id": row["id"]}, state="sending")
        try:
            self.client.prompt(a["pane_id"], row["text"])
        except HerdrError as e:
            state = "queued" if e.code == "agent_blocked" else "failed"
            self.db.update("terminal_queue", {"id": row["id"]}, state=state)
            raise
        else:
            self.db.update("terminal_queue", {"id": row["id"]}, state="sent")
        finally:
            self._publish(row["terminal_id"])
        return row | {"state": "sent"}

    def queue(self, id: str, queue_id: int, what: str) -> dict:
        with self._delivery:
            a = self._require(id)
            row = self.db.one("select * from terminal_queue where id = ? and terminal_id = ? and state in ('queued', 'sending', 'failed')", queue_id, a["terminal_id"])
            if not row:
                raise HerdrError("没有这条排队消息")
            if what == "now":
                if a.get("agent_status") in ("idle", "done"):
                    self._released[a["terminal_id"]] = a.get("completion_seq") or 0
                result = self._send_queue(row)
                self.seen(id)
                self._wake.set()
                return result
            if what != "drop":
                raise HerdrError("没有这种排队操作")
            self.db.update("terminal_queue", {"id": queue_id}, state="dropped")
            self._publish(a["terminal_id"])
            return row | {"state": "dropped"}
