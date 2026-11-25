"""Read immutable snapshot heads to verify registrations and group paper lines by section and operation."""

from __future__ import annotations

import difflib
import json
import re
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from .linked import _arg, _braced, plain
from .prov_git import EMPTY_TREE, POINTER, ROOTS, LargeFile, ProvError, blob_id, file_hash, porcelain, safe_name

FLOAT = re.compile(r"\\(begin|end)\{(table\*?|figure\*?)\}|\\label\s*\{([^}]+)\}")
SECTION = re.compile(r"\\(?:subsection|section)\*?\s*(?:\[[^\]]*\]\s*)?\{")
NUMBER = re.compile(r"(?<![A-Za-z0-9_.])[-+]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?(?![A-Za-z0-9_])")
COMMENT = re.compile(r"(?<!\\)%.*")


def floats(lines):
    current = None
    for i, line in enumerate(lines, 1):
        for m in FLOAT.finditer(COMMENT.sub("", line)):
            if m[1] == "begin":
                current = {"start": i, "type": m[2], "labels": []}
            elif current and m[3]:
                current["labels"].append(m[3])
            elif current and m[1] == "end" and m[2] == current["type"]:
                yield current | {"end": i}
                current = None


def text_of(raw):
    if raw is None or isinstance(raw, LargeFile) or b"\0" in raw:
        return None
    try:
        return raw.decode()
    except UnicodeDecodeError:
        return None


def display(raw):
    if raw is None:
        return None
    if isinstance(raw, LargeFile):
        m = POINTER.fullmatch(raw)
        return f"{m[1].decode()} bytes · {m[2].decode()}"
    text = text_of(raw)
    return text if text is not None else f"{len(raw)} bytes · {blob_id(raw)}"


def passage(row, raw):
    span = row["span"]
    start, end = span["start"], span["end"]
    if raw is None:
        return "missing", None, start, end
    text = text_of(raw)
    if text is None:
        return "changed", display(raw), start, end
    lines = text.splitlines()
    old = span["text"]
    current = "\n".join(lines[start - 1:end])
    if end <= len(lines) and current == old:
        return "ok", current, start, end
    full = "\n" + "\n".join(lines) + "\n"
    offset = full.find("\n" + old + "\n")
    if offset >= 0:
        line = full.count("\n", 0, offset) + 1
        return "moved", old, line, line + end - start
    if "#" in row["location"]:
        label = row["location"].split("#", 1)[1]
        for f in floats(lines):
            if label in f["labels"]:
                start, end = f["start"], f["end"]
                current = "\n".join(lines[start - 1:end])
                break
    return "changed", current, start, end


def decimal_tokens(text):
    # Ignore identifiers and citations. A label containing a year is not evidence for a reported metric.
    text = re.sub(r"\\(?:label|(?:[a-zA-Z]*cite[a-zA-Z]*)|ref|eqref|autoref|cref)\*?\{[^}]*\}", "", text)
    for m in NUMBER.finditer(text):
        try:
            n = Decimal(m[0])
            if len(m[0]) < 100 and abs(n.adjusted()) < 300:
                yield m[0], n
        except InvalidOperation:
            continue


class Analysis:
    def __init__(self, prov, lid, roots, heads):
        self.prov, self.lid, self.heads = prov, lid, heads
        self.rows = {r["id"]: r for r in prov.db.q("select * from prov where line_id = ? order by created_at", lid)}
        self.ops = {r["id"]: r for r in prov.db.q("select * from prov_ops where line_id = ?", lid)}
        self.nodes, self.current, self.spans, self.raw = {}, {}, {}, {}
        self._blames, self._job_stats, self._texts = {}, {}, {}
        self.used, self.run_nodes = defaultdict(list), defaultdict(list)
        self.unregistered = []
        papers = []
        for root in roots:
            if not heads[root]:
                continue
            oid = heads[root]["id"]
            repo = prov.repo(lid, root)
            paths = {r["path"] for r in self.rows.values() if r["root"] == root}
            if root == "paper":
                names = repo.git("diff-tree", "--no-renames", "--name-only", "-r", "-z", EMPTY_TREE, oid)
                papers = [p.decode(errors="surrogateescape") for p in names.split(b"\0") if p.lower().endswith(b".tex")]
                paths.update(papers)
            data = repo.blobs([oid + ":" + p for p in paths])
            self.raw.update({(root, p): data.get(oid + ":" + p) for p in paths})
        for r in self.rows.values():
            self._node(r)
        self._numbers()
        files = [self._paper(p) for p in papers]
        anchored = {nid for f in files for s in f["sections"] for nid in s["nodes"]}
        used_in_paper = defaultdict(set)
        for nid in anchored:
            for src in self.descendants(nid):
                used_in_paper[src].add(nid)
        active = [r for r in self.rows.values() if not r["replaced_by"]]
        unused = {r["id"] for r in active} - anchored - used_in_paper.keys()
        loose = [r["id"] for r in active if r["id"] in unused and not unused.intersection(self.used[r["id"]])]
        for r in self.rows.values():
            j = r["made"]["job"]
            if j and r["kind"] == "result":
                self.run_nodes[j["id"]].append({k: self.nodes[r["id"]][k] for k in ("id", "tag", "path", "state")} |
                                               {"used": len(used_in_paper[r["id"]])})
        numbers = [n for r in active for n in self.nodes[r["id"]]["numbers"]]
        total = sum(f.pop("_floats") for f in files)
        self.view = {"files": files, "nodes": self.nodes, "loose": loose, "stats": {
            "floats": {"total": total, "tagged": total - len(self.unregistered)},
            "numbers": {"total": len(numbers), "ok": sum(n["ok"] for n in numbers)},
            "changed": sum(self.nodes[r["id"]]["state"] == "changed" for r in active), "ops": len(self.ops)}}

    @staticmethod
    def _stat(p):
        try:
            st = p.lstat()
            return (st.st_ino, st.st_ctime_ns, st.st_mtime_ns, st.st_size)
        except OSError:
            return None

    def job_files_current(self):
        return all(self._stat(p) == st for p, st in self._job_stats.items())

    def _virtual(self, r):
        path = r["path"]
        if path.startswith("jobs/"):
            p = self.prov.s.jobs_dir / r["made"]["job"]["id"] / "result.json"
            st = self._job_stats[p] = self._stat(p)
            if st is None or not p.is_file() or p.is_symlink() or p.parent.is_symlink():
                return None
            try:
                if st[-1] > self.prov.s.prov_file_bytes:
                    return LargeFile(f"Papertown large file\nsize {st[-1]}\nblob {file_hash(p, st[-1])}\n".encode())
                return p.read_bytes()
            except OSError:
                return None
        if path.startswith("it_"):
            item = self.prov.db.one("select body from items where line_id = ? and id = ?", self.lid, path)
            return json.dumps(item["body"], ensure_ascii=False, indent=2).encode() if item else None
        if path.startswith("job:") and r["stored"]:
            result = self.prov.db.one("select result from jobs where line_id = ? and id = ?", self.lid, path[4:])
            return json.dumps(result["result"], ensure_ascii=False, indent=2).encode() if result and result["result"] is not None else None
        return path.encode()

    def _node(self, r):
        nid = r["id"]
        raw = self.raw.get((r["root"], r["path"])) if r["root"] else self._virtual(r)
        if r["span"]:
            state, current, start, end = passage(r, raw)
            self.spans[nid] = (start, end)
        else:
            pointer = POINTER.fullmatch(raw) if isinstance(raw, LargeFile) else None
            state = "missing" if raw is None else "ok" if (pointer[2].decode() if pointer else blob_id(raw)) == r["blob"] else "changed"
            current = display(raw)
        self.current[nid] = current
        self._texts[nid] = current if text_of(raw) is not None else None
        gaps = []
        job = r["made"]["job"]
        if r["kind"] == "result":
            if not job:
                gaps.append("来历未登记")
            elif not job.get("op"):
                gaps.append("缺少代码版本")
            if r["path"].startswith("job:") and not r["stored"]:
                gaps.append("未登记结果文件")
        if r["kind"] in ("artifact", "passage") and not r["src"]:
            gaps.append("未登记来源")
        if r["kind"] == "artifact" and not r["made"]["how"]:
            gaps.append("未登记做法")
        public = {k: r[k] for k in ("id", "tag", "kind", "title", "root", "path", "span", "blob", "op", "made", "src", "note", "created_at")}
        self.nodes[nid] = public | {"state": state, "gaps": gaps, "numbers": []}
        for src in r["src"]:
            self.used[src].append(nid)

    def descendants(self, nid):
        stack = list(reversed(self.nodes[nid]["src"]))
        seen = set()
        while stack:
            child = stack.pop()
            if child not in seen and child in self.nodes:
                yield child
                seen.add(child)
                stack.extend(reversed(self.nodes[child]["src"]))

    def _numbers(self):
        tokens = {}
        for nid, node in self.nodes.items():
            if not node["span"] or not node["src"]:
                continue
            sources = {}
            for src in self.descendants(nid):
                s = self.nodes[src]
                if s["kind"] == "source" or s["path"].startswith("job:") and not self.rows[src]["stored"]:
                    continue
                if src not in tokens:
                    if self._texts[src] is None:
                        tokens[src] = []
                    elif s["path"].startswith("it_"):
                        item = self.prov.db.one("select body from items where line_id = ? and id = ?", self.lid, s["path"])
                        tokens[src] = [Decimal(str(n)) for row in (item or {}).get("body", {}).get("rows", []) for n in row["values"]]
                    else:
                        tokens[src] = [n for _, n in decimal_tokens(self._texts[src])]
                for v in tokens[src]:
                    sources.setdefault(v, s["path"])
            rounded = {}
            for word, value in decimal_tokens(COMMENT.sub("", node["span"]["text"])):
                exponent = value.as_tuple().exponent
                if exponent not in rounded:
                    lookup = rounded[exponent] = {}
                    quantum = Decimal(1).scaleb(exponent)
                    for v, path in sources.items():
                        for scale in (v, v.scaleb(2)):
                            try:
                                lookup.setdefault(scale.quantize(quantum, rounding=ROUND_HALF_UP), path)
                            except InvalidOperation:
                                continue
                where = rounded[exponent].get(value)
                node["numbers"].append({"text": word, "ok": where is not None, "where": where})

    def _paper(self, path):
        raw = self.raw["paper", path]
        text = text_of(raw) or ""
        lines = text.splitlines()
        names, positions = [], []
        cleaned = "\n".join(COMMENT.sub("", line) for line in lines)
        breaks = [m.start() for m in re.finditer("\n", cleaned)]
        for m in SECTION.finditer(cleaned):
            line = bisect_right(breaks, m.start()) + 1
            names.append(plain(_braced(cleaned, m.end() - 1)[0]))
            positions.append(line)
        if not positions or positions[0] > 1:
            positions.insert(0, 1)
            names.insert(0, path)
        sections = [{"title": title, "line": line, "nodes": [], "rest": []} for title, line in zip(names, positions)]
        assigned, sourced = set(), set()
        for nid, (a, b) in sorted(self.spans.items(), key=lambda v: v[1]):
            r = self.rows[nid]
            if r["path"] == path and not r["replaced_by"]:
                sections[bisect_right(positions, a) - 1]["nodes"].append(nid)
                extent = range(a, min(b, len(lines)) + 1)
                assigned.update(extent)
                if r["src"]:
                    sourced.update(extent)
        rest = [Counter() for _ in sections]
        for group in self.blame("paper", path) if lines else ():
            for i in range(group["start"], group["end"] + 1):
                if i not in assigned:
                    rest[bisect_right(positions, i) - 1][group["who"]] += 1
        for section, counts in zip(sections, rest):
            section["rest"] = [{"who": who, "lines": n} for who, n in counts.items()]
        figures = list(floats(lines))
        for f in figures:
            if sourced.isdisjoint(range(f["start"], f["end"] + 1)):
                self.unregistered.append({"path": path, **f})
        return {"path": path, "title": plain(_arg(cleaned, "title") or path), "sections": sections, "_floats": len(figures)}

    def _original(self, repo, op, path):
        # Align the private baseline against the project's committed file. Uncommitted baseline lines have no author.
        head = op["project_head"]
        if not head or not (repo.root / ".git").exists():
            return {}
        real = porcelain(repo.project("blame", "--no-textconv", "--line-porcelain", head, "--", path, optional=True))
        if not real:
            return {}
        base = repo.git("cat-file", "blob", op["id"] + ":" + path, optional=True).splitlines()
        original = repo.project("cat-file", "blob", head + ":" + path, optional=True).splitlines()
        blocks = [(0, 0, len(base))] if base == original else difflib.SequenceMatcher(None, original, base, autojunk=False).get_matching_blocks()
        return {b + i + 1: real[a + i] for a, b, length in blocks for i in range(length) if a + i < len(real)}

    def blame(self, root, path):
        if root not in ROOTS or not safe_name(path):
            raise ProvError("项目文件路径无效")
        if (root, path) in self._blames:
            return self._blames[root, path]
        head = self.heads[root]
        if not head:
            return []
        repo = self.prov.repo(self.lid, root)
        if (root, path) not in self.raw:
            key = head["id"] + ":" + path
            self.raw[root, path] = repo.blobs([key]).get(key)
        if text_of(self.raw[root, path]) is None:
            return []
        lines = porcelain(repo.git("blame", "--no-textconv", "--line-porcelain", head["id"], "--", path, optional=True))
        assigned = {}
        for nid, (a, b) in self.spans.items():
            r = self.rows[nid]
            if r["root"] == root and r["path"] == path and not r["replaced_by"]:
                assigned.update(dict.fromkeys(range(a, min(len(lines), b) + 1), nid))
        original, groups, previous = {}, [], None
        for i, (oid, line, _, _, filename) in enumerate(lines, 1):
            op = self.ops[oid]
            row = {"op": oid, "who": op["who"], "role": op["role"], "at": op["ts"], "node": assigned.get(i)}
            if op["project_head"]:
                key = oid, filename
                if key not in original:
                    original[key] = self._original(repo, op, filename)
                if credit := original[key].get(line):
                    commit, _, author, ts, _ = credit
                    row.update(commit=commit, author=author, date=datetime.fromtimestamp(ts, timezone.utc).isoformat())
            if row == previous:
                groups[-1]["end"] = i
            else:
                groups.append(row | {"start": i, "end": i})
                previous = row
        self._blames[root, path] = groups
        return groups

    def detail(self, ref):
        r = next((r for r in self.rows.values() if ref in (r["id"], r["tag"])), None)
        if not r:
            raise ProvError("本项目未找到这条溯源记录", 404)
        nid = r["id"]
        if r["span"]:
            then = r["span"]["text"]
        elif r["root"]:
            repo = self.prov.repo(self.lid, r["root"])
            key = r["op"] + ":" + r["path"]
            then = display(repo.blobs([key]).get(key))
        elif r["stored"]:
            repo = self.prov.repo(self.lid, "code")
            raw = repo.blobs([r["stored"]]).get(r["stored"])
            then = display(LargeFile(raw) if raw is not None and r["blob"] != r["stored"] else raw)
        else:
            then = self.current[nid]
        current = self.current[nid]
        diff = "\n".join(difflib.unified_diff((then or "").splitlines(), (current or "").splitlines(),
                                               fromfile=r["path"], tofile=r["path"], lineterm=""))
        def link(ref):
            return {k: self.nodes[ref][k] for k in ("id", "tag", "title")}
        older = {v["replaced_by"]: v["id"] for v in self.rows.values() if v["replaced_by"]}
        history = []
        old = older.get(nid)
        while old:
            history.append(link(old))
            old = older.get(old)
        newer = r["replaced_by"]
        while newer:
            history.append(link(newer))
            newer = self.rows[newer]["replaced_by"]
        return self.nodes[nid] | {"now": current, "then": then, "diff": diff,
                                  "used": [link(v) for v in self.used[nid]], "history": history}
