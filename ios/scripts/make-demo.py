"""Export a Papertown server's sample projects as the iOS app's offline demo.

Point it at a fresh server that runs only the built-in sample projects (PAPERTOWN_SAMPLES=1, its own data dir, no
leads), never at one holding your own projects: every answer is written into the app bundle.

    uv run --frozen --project server ios/scripts/make-demo.py http://127.0.0.1:<sample-port>

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


def get(path: str, *, record_error: bool = False):
    try:
        with urllib.request.urlopen(base + path, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as error:
        if record_error:
            return {"_http_error": error.code, "body": json.load(error)}
        return None


def scrub(value):
    """Local paths become ~/papertown/...; the data dir is wherever the server keeps its projects."""
    text = json.dumps(value, ensure_ascii=False)
    if home:
        text = text.replace(home, "~/papertown")
    text = re.sub(r'"(/(?:Users|home|private|tmp|var)/[^"]*)"', lambda m: json.dumps("~/papertown/" + m.group(1).rsplit("/", 1)[-1]), text)
    return json.loads(text)


def save(path: str, name: str, *, record_error: bool = False):
    data = get(path, record_error=record_error)
    if data is None:
        return None
    (out / f"{name}.json").write_text(json.dumps(scrub(data), ensure_ascii=False, separators=(",", ":")))
    routes[path] = f"{name}.json"
    return data


lines = get("/api/lines") or []
if not lines or not all(line.get("sample") for line in lines):
    raise SystemExit("Export requires a server containing only sample projects.")
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
                   ("/api/agents/runtime", "runtime"), ("/api/usage/settings", "usage-settings"),
                   ("/api/herdr", "herdr"), ("/api/backends", "backends"), ("/api/auth/keys", "access-keys"),
                   ("/api/health", "health"), ("/api/papers/fresh", "fresh"), ("/api/skim?fresh=1", "skim"),
                   ("/api/skim/resolve", "skim_resolve"), ("/api/bounds", "bounds"), ("/api/trace?limit=80", "trace")]:
    save(path, name)
for path, name in (("/api/paseo", "paseo"), ("/api/paseo?fresh=1", "paseo-fresh"), ("/api/paseo/conversations", "paseo-conversations")):
    save(path, name, record_error=True)
for role in ("lead", "coder", "writer"):
    save(f"/api/agents?role={role}", f"roster-{role}")
for ln in lines:
    i, n = ln["id"], ln["seq"]
    for path, name in [(f"/api/lines/{i}", "line"), (f"/api/lines/{i}/card", "card"), (f"/api/lines/{i}/checks", "checks"),
                       (f"/api/lines/{i}/papers", "papers"), (f"/api/lines/{i}/data", "data"), (f"/api/lines/{i}/ws", "ws"),
                       (f"/api/lines/{i}/usage", "usage"), (f"/api/lines/{i}/lead", "lead"), (f"/api/reports?line_id={i}", "reports"),
                       (f"/api/jobs?line_id={i}", "jobs"), (f"/api/agents/lead-{i}?after=0", "agent-lead"),
                       (f"/api/lines/{i}/canvas/outline", "outline"), (f"/api/lines/{i}/canvas", "canvas"),
                       (f"/api/lines/{i}/memory", "memory"), (f"/api/lines/{i}/memory/scan", "memory-scan"), (f"/api/lines/{i}/pages", "pages"), (f"/api/bounds?line_id={i}", "bounds")]:
        save(path, f"{name}-{n}")
    for root in ("code", "paper"):
        tree = save(f"/api/lines/{i}/ws/{root}/tree", f"tree-{root}-{n}")
        for k, f in enumerate((tree or {}).get("files", [])[:12]):
            q = urllib.parse.quote(f["path"])
            save(f"/api/lines/{i}/ws/{root}/file?path={q}", f"file-{root}-{n}-{k}")

    prefix = f"/api/lines/{i}"
    memory = get(f"{prefix}/memory") or {}
    for k, item in enumerate(memory.get("items", [])):
        save(f"{prefix}/memory/{item['id']}", f"memory-item-{n}-{k}")
    for k, page in enumerate((get(f"{prefix}/pages") or {}).get("pages", [])):
        view = f"{prefix}/pages/{page['id']}/view"
        for look in ("", "light", "dark"):
            path = view + (f"?look={look}" if look else "")
            with urllib.request.urlopen(base + path, timeout=30) as response:
                body = {"html": response.read().decode(), "policy": response.headers.get("Content-Security-Policy", "").replace(base, "https://demo.papertown.invalid")}
            name = f"page-{n}-{k}-{look or 'paper'}.json"
            (out / name).write_text(json.dumps(body, ensure_ascii=False))
            routes[path] = name
    decided = save(f"{prefix}/decided", f"decided-{n}") or {}
    for d in decided.get("decisions", []):
        detail = f"{prefix}/decided/{d['id']}"
        if save(detail, f"decided-{n}-d{d['n']}") is not None:
            routes[f"{prefix}/decided/D{d['n']}"] = routes[detail]

    tree = save(f"{prefix}/prov", f"prov-{n}") or {}
    node_ids = list(tree.get("nodes", {}))
    known_nodes = set(node_ids)
    agents = set()
    for k, node_id in enumerate(node_ids):
        node = save(f"{prefix}/prov/nodes/{node_id}", f"prov-node-{n}-{k}") or {}
        if agent := (node.get("made") or {}).get("agent"):
            agents.add(agent)
        # Earlier registrations can be linked from a detail without appearing in the current tree.
        for ref in (node.get("history") or []) + (node.get("used") or []) + (node.get("src") or []):
            child = ref.get("id") if isinstance(ref, dict) else ref
            if child and child not in known_nodes:
                node_ids.append(child)
                known_nodes.add(child)
    for k, f in enumerate(tree.get("files", [])):
        q = urllib.parse.urlencode({"root": "paper", "path": f["path"]}, quote_via=urllib.parse.quote)
        save(f"{prefix}/prov/blame?{q}", f"prov-blame-{n}-{k}")
    ops_path = f"{prefix}/prov/ops"
    page_path = f"{ops_path}?limit=50"
    seen = set()
    while (page := save(page_path, f"prov-ops-{n}-{len(seen)}")) is not None:
        if not seen:
            routes[ops_path] = routes[page_path]
        new = [op for op in page if op["id"] not in seen]
        for op in new:
            save(f"{ops_path}/{op['id']}", f"prov-op-{n}-{len(seen)}")
            seen.add(op["id"])
            if op.get("agent"):
                agents.add(op["agent"])
        if not new or len(page) < 50:
            break
        page_path = ops_path + "?" + urllib.parse.urlencode({"before": page[-1]["id"], "limit": 50})
    for name in ("lead", "coder", "writer"):
        if name == "lead" or f"{name}-{i}" in agents:
            save(f"/api/agents/{name}-{i}/conversations", f"conversations-{name}-{n}", record_error=True)
    for agent in sorted(agents):
        path = "/api/agents/" + urllib.parse.quote(agent, safe="") + "?after=0"
        if path not in routes:
            save(path, f"agent-{agent.removesuffix('-' + i)}-{n}")
    jobs = get(f"/api/jobs?line_id={i}") or {}
    for k, job in enumerate(jobs.get("jobs", [])):
        save(f"/api/jobs/{job['id']}", f"job-{n}-{k}")

(out / "routes.json").write_text(json.dumps(routes, ensure_ascii=False, indent=0))
size = sum(p.stat().st_size for p in out.glob("*.json"))
print(f"{len(routes)} answers, {size // 1024} KB in {out}")
