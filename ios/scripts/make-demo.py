"""Export a Papertown server's sample projects as the iOS app's offline demo.

Point it at a fresh server that runs only the built-in sample projects (PAPERTOWN_SAMPLES=1, its own data dir, no
leads), never at one holding your own projects: every answer is written into the app bundle.

    python3 ios/scripts/make-demo.py http://127.0.0.1:8137

Writes ios/Sources/PapertownUI/Resources/Demo/: one JSON file per answer and routes.json, which maps
"GET /api/..." to its file. Local paths in the answers are replaced by ~/papertown/...
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

base = sys.argv[1].rstrip("/")
out = Path(__file__).resolve().parent.parent / "Sources" / "PapertownUI" / "Resources" / "Demo"
out.mkdir(parents=True, exist_ok=True)
routes: dict[str, str] = {}
home: str | None = None


def get(path: str):
    try:
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError:
        return None


def scrub(value):
    """Local paths become ~/papertown/...; the data dir is wherever the server keeps its projects."""
    text = json.dumps(value, ensure_ascii=False)
    if home:
        text = text.replace(home, "~/papertown")
    text = re.sub(r'"(/(?:Users|home|private|tmp|var)/[^"]*)"', lambda m: json.dumps("~/papertown/" + m.group(1).rsplit("/", 1)[-1]), text)
    return json.loads(text)


def save(path: str, name: str):
    data = get(path)
    if data is None:
        return None
    (out / f"{name}.json").write_text(json.dumps(scrub(data), ensure_ascii=False, separators=(",", ":")))
    routes[path] = f"{name}.json"
    return data


lines = get("/api/lines") or []
for ln in lines:
    lead = (get(f"/api/agents/lead-{ln['id']}?after=0") or {}).get("agent") or {}
    cwd = lead.get("cwd") or ""
    if "/projects/" in cwd:
        home = cwd.split("/projects/")[0]
        break

for path, name in [("/api/auth/state", "auth_state"), ("/api/lines", "lines"), ("/api/cards", "cards"), ("/api/world", "world"),
                   ("/api/agents/overview", "overview"), ("/api/reports", "reports"), ("/api/assistant", "assistant"),
                   ("/api/agents/assistant?after=0", "agent-assistant"), ("/api/usage", "usage"), ("/api/gpus", "gpus"),
                   ("/api/departments", "departments"), ("/api/rag", "rag"), ("/api/jobs", "jobs"),
                   ("/api/library?q=&topic=&limit=400", "library"), ("/api/mcp", "mcp"), ("/api/skills", "skills"),
                   ("/api/health", "health")]:
    save(path, name)
for ln in lines:
    i, n = ln["id"], ln["seq"]
    for path, name in [(f"/api/lines/{i}", "line"), (f"/api/lines/{i}/card", "card"), (f"/api/lines/{i}/checks", "checks"),
                       (f"/api/lines/{i}/papers", "papers"), (f"/api/lines/{i}/data", "data"), (f"/api/lines/{i}/ws", "ws"),
                       (f"/api/lines/{i}/usage", "usage"), (f"/api/lines/{i}/lead", "lead"), (f"/api/reports?line_id={i}", "reports"),
                       (f"/api/jobs?line_id={i}", "jobs"), (f"/api/agents/lead-{i}?after=0", "agent-lead"),
                       (f"/api/lines/{i}/canvas/outline", "outline")]:
        save(path, f"{name}-{n}")
    for root in ("code", "paper"):
        tree = save(f"/api/lines/{i}/ws/{root}/tree", f"tree-{root}-{n}")
        for k, f in enumerate((tree or {}).get("files", [])[:12]):
            q = urllib.parse.quote(f["path"])
            save(f"/api/lines/{i}/ws/{root}/file?path={q}", f"file-{root}-{n}-{k}")

(out / "routes.json").write_text(json.dumps(routes, ensure_ascii=False, indent=0))
size = sum(p.stat().st_size for p in out.glob("*.json"))
print(f"{len(routes)} answers, {size // 1024} KB in {out}")
