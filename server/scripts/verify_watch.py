"""Opt-in live test of watching and steering: real agents in Paseo go through the standard flow in watch_flow.json.

Run from server/, with the Paseo daemon already running (this script never starts it):

    .venv/bin/python scripts/verify_watch.py --agent claude:claude-sonnet-5-5:low \\
        --agent codex:gpt-6-luna:low --agent antigravity:gemini-3.8-flash-low [--steps interrupt,stop] [--clean]

Each agent is a coder in a temporary Papertown project. Its first turn reads the project brief, then the steps send
their task, wait until the agent runs a command, and send the step's messages through Papertown's API: steer, queue,
withdraw, send now, interrupt and stop. Permission requests are allowed as they come. The expected results are in
watch_flow.json. The report goes to <temporary dir>/report.json and the exit status is 1 when a step fails.
The Paseo projects it creates are kept unless --clean is given.
"""
import argparse
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
import uvicorn

from papertown.api import create_app
from papertown.config import Settings
from papertown.paseo import APP_CLI

FLOW = json.loads((Path(__file__).with_name("watch_flow.json")).read_text())
HEAD = "联调测试，不要修改任何文件，也不要解释。"


class Run:
    """One agent going through the flow."""

    def __init__(self, url: str, spec: str, steps: list[dict], timeout: int, hatching):
        provider, model, thinking = (spec.split(":") + [None, None])[:3]
        self.provider, self.model, self.thinking = provider, model or None, thinking or None
        self.c = httpx.Client(base_url=url, timeout=120)
        self.steps, self.timeout, self.t0, self.hatching = steps, timeout, time.monotonic(), hatching
        self.n = uuid.uuid4().hex[:6].upper()
        self.results, self.log, self.permitted, self.last = {}, [], set(), None
        self.id = self.ext = self.line = None

    # --- plumbing

    def now(self) -> float:
        return round(time.monotonic() - self.t0, 1)

    def note(self, **kw):
        self.log.append({"t": self.now(), **kw})
        print(f"[{self.now():6.1f}] {self.provider:11s} " + " ".join(f"{k}={v}" for k, v in kw.items()), flush=True)

    def call(self, method: str, path: str, data=None):
        r = self.c.request(method, path, json=data)
        if r.status_code >= 400:
            raise RuntimeError(f"{path}: {r.status_code} {r.text[:200]}")
        return r.json()

    def fill(self, text: str) -> str:
        return text.replace("{n}", self.n).replace("{long}", FLOW["long"])

    def poll(self) -> dict:
        """One look at the agent as the page sees it. Note a change of bucket and allow what it asks for."""
        a = self.call("GET", f"/api/agents/{self.id}")["agent"]
        w = a["watch"]
        if (w["bucket"], w["why"]) != self.last:
            self.last = (w["bucket"], w["why"])
            self.note(bucket=w["bucket"], why=w["why"], doing=((w["doing"] or {}).get("text") or "")[:60].replace("\n", " "))
        for p in w["permissions"]:
            if p["id"] not in self.permitted:
                self.permitted.add(p["id"])
                self.note(permit=p["name"], arg=(p["arg"] or "")[:60])
                self.call("POST", f"/api/agents/{self.id}/permit", {"request_id": p["id"], "allow": True})
        return a

    def until(self, pred, timeout: float, what: str) -> dict:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            a = self.poll()
            if pred(a):
                return a
            time.sleep(1)
        raise TimeoutError(f"{what} ({timeout:.0f} s, last state {self.last})")

    @staticmethod
    def settled(a: dict) -> bool:
        return a["watch"]["bucket"] in ("review", "idle", "failed") and not a["watch"]["permissions"]

    def conversation(self, marker: str) -> list[dict]:
        """The conversation from the last message of ours that contains `marker`."""
        items = self.call("GET", f"/api/agents/{self.id}/timeline")["items"]
        at = max((i for i, x in enumerate(items) if x["kind"] == "user" and marker in (x.get("text") or "")), default=0)
        return items[at:]

    def replies(self, marker: str) -> list[str]:
        return [x.get("text") or "" for x in self.conversation(marker) if x["kind"] == "assistant"]

    def wait_reply(self, text: str, marker: str, timeout: float) -> float | None:
        """Seconds until a reply containing `text` arrived, or None once the agent settled without one."""
        start, end = time.monotonic(), time.monotonic() + timeout
        while time.monotonic() < end:
            a = self.poll()
            if self.settled(a):
                grace = time.monotonic() + 5  # the last piece of a reply can follow the idle status
                while time.monotonic() < grace:
                    if any(text in r for r in self.replies(marker)):
                        return round(time.monotonic() - start, 1)
                    time.sleep(1)
                return None
            time.sleep(1)
        raise TimeoutError(f"no settled reply ({timeout:.0f} s)")

    def busy(self):
        """Wait until it works and runs a command, so a message reaches a running turn."""
        self.until(lambda a: a["watch"]["bucket"] == "working", 120, "it did not start working")
        self.until(lambda a: (a["watch"]["doing"] or {}).get("kind") == "tool" and "sleep" in a["watch"]["doing"]["text"], 90, "it did not run the command")

    def quiet(self):
        """Leave it idle and read between steps."""
        try:
            if self.poll()["watch"]["bucket"] in ("working", "needs"):
                self.call("POST", f"/api/agents/{self.id}/abort")
            self.until(self.settled, 120, "it did not settle")
            self.call("POST", f"/api/agents/{self.id}/seen")
        except Exception as e:
            self.note(quiet_error=str(e)[:120])

    # --- the flow

    def first(self, step: dict) -> dict:
        e = step["expect"]
        a = self.until(self.settled, self.timeout, "the first turn did not finish")
        before = a["watch"]
        after = self.call("POST", f"/api/agents/{self.id}/seen")["watch"]
        got = {"settled": before["bucket"], "why": before["why"], "after_seen": after["bucket"]}
        return {"ok": got == {k: e[k] for k in got}, **got}

    def run_step(self, step: dict) -> dict:
        e, task = step["expect"], HEAD + self.fill(step["task"])
        marker = task[len(HEAD):len(HEAD) + 24]
        self.call("POST", f"/api/agents/{self.id}/say", {"text": task})
        self.busy()
        out, sent, events = {}, time.monotonic(), []
        for m in step["send"]:
            if m.get("stop"):
                sent = time.monotonic()
                self.call("POST", f"/api/agents/{self.id}/abort")
                continue
            ev = self.call("POST", f"/api/agents/{self.id}/say", {"text": self.fill(m["text"]), "mode": m["mode"]})
            events.append(ev)
            if "queued" in e:
                out.setdefault("queued", []).append(self.poll()["watch"]["queued"])
            if m.get("then"):
                ev = self.call("POST", f"/api/agents/{self.id}/queue/{ev['id']}", {"what": m["then"]})
                events[-1] = ev if m["then"] == "now" else events[-1]
                if "queued" in e:  # the count after each message and after each follow-up on it
                    out["queued"].append(self.poll()["watch"]["queued"])
        sent_at = time.monotonic() - sent
        checks = {}
        if "event" in e:
            got = {k: events[0]["data"].get(k) for k in e["event"]}
            out["event"] = got
            checks["event"] = got == e["event"]
        if "queued" in e:
            checks["queued"] = out["queued"] == e["queued"]
        if "reply" in e:
            seconds = self.wait_reply(self.fill(e["reply"]), marker, self.timeout)
            out["seconds"] = seconds
            checks["reply"] = seconds is not None and seconds <= e.get("within", self.timeout)
        if "replies_in_order" in e:
            want = [self.fill(x) for x in e["replies_in_order"]]
            self.wait_reply(want[-1], marker, self.timeout)
            rs = self.replies(marker)
            at = [next((i for i, r in enumerate(rs) if w in r), -1) for w in want]
            out["order"] = at
            checks["order"] = all(i >= 0 for i in at) and at == sorted(at)
        if "settled_within" in e:
            self.until(self.settled, e["settled_within"], "it kept working after the stop")
            out["seconds"] = round(time.monotonic() - sent - sent_at, 1)
            time.sleep(6)
            checks["stopped"] = self.settled(self.poll())
        if "never" in e:
            bad = self.fill(e["never"])
            # everything after the step's own task message, which names the marker it must not produce
            seen = [x.get("text") or "" for x in self.conversation(marker)[1:] if x["kind"] in ("assistant", "user")]
            checks["never"] = not any(bad in t for t in seen)
        tools = [x for x in self.conversation(marker) if x["kind"] == "tool"]
        out["tools"] = [f"{(x.get('arg') or x.get('name') or '')[:30]}:{x.get('status')}" for x in tools][:8]
        return {"ok": all(checks.values()), "checks": checks, **out}

    def run(self):
        try:
            lid = self.call("POST", "/api/ideas", {"text": f"实时监控与介入联调（{self.provider}）；不做研究，不修改代码，不运行实验"})["id"]
            while self.hatching(lid):  # the offline pipeline sets the project up first
                time.sleep(.3)
            a = self.call("POST", "/api/agents", {"line_id": lid, "role": "coder"})
            a = self.call("POST", f"/api/agents/{a['id']}/start", {"runtime": "paseo", "provider": self.provider, "model": self.model, "thinking": self.thinking})
            self.id, self.ext, self.line = a["id"], a["ext_id"], lid
            self.note(started=self.ext, model=a["model"])
            for step in self.steps:
                self.note(step=step["key"])
                try:
                    self.results[step["key"]] = self.first(step) if step["key"] == "first" else self.run_step(step)
                except Exception as e:
                    self.results[step["key"]] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
                self.note(result=step["key"], ok=self.results[step["key"]]["ok"])
                self.quiet()
        except Exception as e:
            self.results["setup"] = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
            self.note(setup_error=str(e)[:200])


def main():
    args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    args.add_argument("--agent", action="append", required=True, help="provider[:model[:thinking]], repeatable")
    args.add_argument("--steps", help="comma-separated step keys; the first turn always runs")
    args.add_argument("--timeout", type=int, default=300, help="seconds a turn may take")
    args.add_argument("--clean", action="store_true", help="delete the Paseo projects this run created")
    opts = args.parse_args()
    status = subprocess.run([APP_CLI, "daemon", "status"], capture_output=True, text=True).stdout
    if "localDaemon: running" not in status:
        sys.exit("The Paseo daemon is not running. Open Paseo (or start its daemon yourself) and run this again.")
    wanted = set(opts.steps.split(",")) | {"first"} if opts.steps else None
    steps = [s for s in FLOW["steps"] if not wanted or s["key"] in wanted]
    root = Path(tempfile.mkdtemp(prefix="papertown-live-watch-"))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    no = lambda name: str(root / f"no-{name}")
    settings = Settings(provider="mock", data_dir=root / "data", samples=False, arxiv_port=False, compile_tex=False,
                        paseo_bin=APP_CLI, paseo_watch=0, lead_tick=3600, url=f"http://127.0.0.1:{port}",
                        nvidb_bin=no("nvidb"), skim_bin=no("skim"), pi_bin=no("pi"), claude_home=no("claude"), codex_home=no("codex"))
    app = create_app(settings)
    town = app.state.town
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(.05)
    print(f"Watching at {settings.url}/agents", flush=True)
    runs = [Run(settings.url, spec, steps, opts.timeout, town.pipeline.running) for spec in opts.agent]
    threads = [threading.Thread(target=r.run, daemon=True) for r in runs]
    for t in threads:
        t.start()
        time.sleep(2)
    for t in threads:
        t.join()
    feed = town.agents._feed
    # Usage statistics give an agent's sessions to its project by the session id Paseo reports.
    for r in runs:
        sessions = town.db.q("select session_id from agent_sessions where agent_id = ?", r.id) if r.id else []
        r.results["session"] = {"ok": bool(sessions), "sessions": len(sessions)}
    report = {"feed_live": bool(feed and feed.live), "flow": [s["key"] for s in steps], "runs": [
        {"agent": f"{r.provider}:{r.model or ''}", "paseo_agent": r.ext, "results": r.results, "permissions_allowed": len(r.permitted), "log": r.log}
        for r in runs]}
    projects = [p for p in (town.db.val("select paseo_project from lines where id = ?", r.line) for r in runs if r.line) if p]
    report["paseo_projects"] = projects
    (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    server.should_exit = True
    thread.join(timeout=5)
    if opts.clean:
        for p in projects:
            town.agents.paseo._cli("project", "delete", p)
    print(f"\nlive feed: {report['feed_live']}")
    failed = False
    for r in report["runs"]:
        line = " ".join(f"{k}={'ok' if v['ok'] else 'FAIL'}" for k, v in r["results"].items())
        failed |= not all(v["ok"] for v in r["results"].values())
        print(f"{r['agent']:40s} {line}")
    print(("Deleted" if opts.clean else "Kept") + " Paseo projects: " + (", ".join(projects) or "none"))
    print(f"Report: {root / 'report.json'}", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
