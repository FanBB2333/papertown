"""The Paseo model the console's assistant and the projects' leads start on (kept in data/paseo.json,
else PAPERTOWN_ASSISTANT_MODEL / PAPERTOWN_LEAD_MODEL), and the models Paseo newly offers as news.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from .db import now, read_json, write_json
from .paseo import PaseoError

if TYPE_CHECKING:
    from .town import Town

ROLES = ("assistant", "lead")
NEWS_MAX = 30


class ModelError(Exception):
    pass


class PaseoModels:
    def __init__(self, town: "Town"):
        self.town = town
        self.s = town.s
        self._path = self.s.data_dir / "paseo.json"
        self._lock = threading.Lock()
        self._halt = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def paseo(self):
        return self.town.agents.paseo

    def _read(self) -> dict:
        return read_json(self._path, {})

    def _write(self, d: dict) -> None:
        write_json(self._path, d)

    def _publish(self) -> None:
        self.town.bus.publish("paseo_models", defaults=self.defaults(), news=self.news())

    def runtime(self) -> str:
        value = self._read().get("runtime", self.s.agent_runtime)
        return value if value in ("paseo", "herdr", "tmux") else "paseo"

    def set_runtime(self, runtime: str) -> dict:
        if runtime not in ("paseo", "herdr", "tmux"):
            raise ModelError("默认运行方式只能是 Paseo、herdr 或 tmux")
        with self._lock:
            self._write(self._read() | {"runtime": runtime})
        self._publish()
        return {"runtime": runtime}

    def default(self, role: str) -> dict:
        """The provider, model and thinking an agent of this role starts with when none is picked."""
        d = (self._read().get("defaults") or {}).get(role)
        if isinstance(d, dict) and d.get("provider"):
            return {"provider": d["provider"], "model": d.get("model") or None, "thinking": d.get("thinking") or None}
        return self.s.paseo_default(role)

    def defaults(self) -> dict:
        saved = self._read().get("defaults") or {}
        return {r: self.default(r) | {"set": bool((saved.get(r) or {}).get("provider"))} for r in ROLES}

    def set_default(self, role: str, provider: str | None, model: str | None = None, thinking: str | None = None) -> dict:
        """Choose what an agent of this role starts with, from what Paseo lists; no provider goes back to the environment's."""
        if role not in ROLES:
            raise ModelError(f"只有 {'、'.join(ROLES)} 有默认模型")
        provider, model, thinking = (provider or "").strip(), (model or "").strip() or None, (thinking or "").strip() or None
        if provider:
            try:
                rows = self.paseo.providers()
            except PaseoError as e:
                raise ModelError(f"读不到 Paseo 的模型列表，没法核对：{e}") from e
            p = next((x for x in rows if x["id"] == provider), None)
            if not p:
                raise ModelError(f"Paseo 里没有可用的供应商 {provider}")
            m = next((x for x in p["models"] if x["id"] == model), None)
            if model and not m:
                raise ModelError(f"{p['label']} 里没有模型 {model}")
            if thinking and m and m["thinking"] and thinking not in m["thinking"]:
                raise ModelError(f"{m['name']} 的思考强度只有 {'、'.join(m['thinking'])}")
        with self._lock:
            d = self._read()
            ds = d.setdefault("defaults", {})
            if provider:
                ds[role] = {"provider": provider, "model": model, "thinking": thinking}
            else:
                ds.pop(role, None)
            self._write(d)
        self._publish()
        return self.defaults()

    def news(self) -> list[dict]:
        return self._read().get("news") or []

    def learn(self, providers: list[dict]) -> list[dict]:
        """Take in a reading of Paseo's list; models new since the last one, from a provider already known, are kept as news."""
        added = []
        with self._lock:
            d = self._read()
            first = "seen" not in d
            seen, known = set(d.get("seen") or []), set(d.get("providers") or [])
            for p in providers:
                for m in p["models"]:
                    key = f"{p['id']}/{m['id']}"
                    if key in seen:
                        continue
                    seen.add(key)
                    if not first and p["id"] in known:
                        added.append({"key": key, "provider": p["id"], "label": p["label"], "model": m["id"], "name": m["name"],
                                      "thinking": m["thinking"], "default_thinking": m["default_thinking"], "at": now()})
                if p["models"]:  # a provider that listed nothing (still loading, timed out) is learned next time
                    known.add(p["id"])
            if first or added or len(seen) != len(d.get("seen") or []) or known != set(d.get("providers") or []):
                d |= {"seen": sorted(seen), "providers": sorted(known), "news": ((d.get("news") or []) + added)[-NEWS_MAX:]}
                self._write(d)
        if added:
            self._publish()
        return added

    def dismiss(self, keys: list[str] | None = None) -> list[dict]:
        """Put news away once you have seen it: the ones named, or all of it."""
        with self._lock:
            d = self._read()
            d["news"] = [n for n in d.get("news") or [] if keys is not None and n.get("key") not in keys]
            self._write(d)
        self._publish()
        return d["news"]

    def check(self) -> list[dict]:
        """Read Paseo's list afresh and learn from it; nothing when Paseo is not there."""
        if not self.paseo.status(fresh=True)["ok"]:
            return []
        return self.learn(self.paseo.providers(fresh=True))

    def start(self) -> None:
        if self._thread or not self.s.paseo_watch or not self.paseo.bin:
            return
        self._halt.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="paseo-models")
        self._thread.start()

    def stop(self) -> None:
        self._halt.set()
        self._thread = None

    def _loop(self) -> None:
        wait = 15
        while not self._halt.wait(wait):
            wait = self.s.paseo_watch
            try:
                self.check()
            except Exception as e:  # noqa: BLE001 - the watcher must outlive any one bad reading; the trace says what it was
                self.town.trace("PASEO", "模型列表读取失败", f"{type(e).__name__}: {e}")
