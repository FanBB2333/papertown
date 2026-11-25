"""Git plumbing for provenance. The work tree is input only, including when it is itself a checkout."""

from __future__ import annotations

import ast
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from contextlib import contextmanager, nullcontext
from pathlib import Path

from .db import read_json, write_json

COMMANDS = frozenset("ls-files update-index add write-tree commit-tree update-ref hash-object cat-file diff diff-tree blame log show rev-parse symbolic-ref".split())
PROJECT_READS = frozenset(("ls-files", "rev-parse", "blame", "cat-file"))
ROOTS = ("code", "paper")
PRIVATE = {".git", ".papertown"}
SKIP = PRIVATE | {"node_modules", "__pycache__", ".venv", "wandb", "checkpoints"}
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
POINTER = re.compile(rb"Papertown large file\nsize (\d+)\nblob ([a-f0-9]{40})\n\Z")
_init_lock = threading.Lock()


class ProvError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class LargeFile(bytes):
    """A size/hash pointer. Its private tree mode distinguishes it from a file containing identical bytes."""


@contextmanager
def project_index(root: Path, store: Path):
    """Even --no-optional-locks freshens sharedindex.* on read. Let Git freshen a private copy instead."""
    dot = root / ".git"
    if dot.is_file():
        prefix, _, name = dot.read_text().strip().partition(": ")
        if prefix != "gitdir":
            raise ProvError("项目的 Git 目录无效")
        dot = (root / name).resolve()
    common = dot / "commondir"
    common = (dot / common.read_text().strip()).resolve() if common.is_file() else dot
    with tempfile.TemporaryDirectory(dir=store, prefix="project-index-") as tmp:
        private = Path(tmp)
        shutil.copyfile(dot / "HEAD", private / "HEAD")
        if (dot / "index").exists():
            raw = (dot / "index").read_bytes()
            (private / "index").write_bytes(raw)
            # The link extension starts with the shared index's binary SHA-1 or SHA-256.
            for m in re.finditer(b"link", raw):
                off = m.end() + 4
                if int.from_bytes(raw[m.end():off], "big") > len(raw) - off:
                    continue
                for width in (20, 32):
                    shared = dot / ("sharedindex." + raw[off:off + width].hex())
                    if shared.is_file():
                        shutil.copyfile(shared, private / shared.name)
        yield private, common


def git(root: Path, command: str, *args: str, store: Path | None = None, branch: str = "code",
        data: bytes | None = None, optional: bool = False, date: str | None = None, project: bool = False, bulk: bool = False) -> bytes:
    """Only explicit plumbing writes to the private index, objects or refs. No inherited Git routing, helpers or hooks."""
    if command not in COMMANDS or ((project or store is None) and command not in PROJECT_READS) or branch not in ROOTS:
        raise ValueError(f"Unsupported provenance Git command: {command}")
    if store is None:
        raise ValueError("A private provenance store is required")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_ATTR_NOSYSTEM="1",
               GIT_ALLOW_PROTOCOL="", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1", GIT_TERMINAL_PROMPT="0",
               GIT_TRACE2="0", GIT_TRACE2_EVENT="0", GIT_TRACE2_PERF="0",
               GIT_AUTHOR_NAME="Papertown", GIT_COMMITTER_NAME="Papertown",
               GIT_AUTHOR_EMAIL="prov@papertown.local", GIT_COMMITTER_EMAIL="prov@papertown.local", LC_ALL="C")
    argv = ["git", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=true", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + os.devnull,
            "-c", "core.untrackedCache=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", str(root)]
    private, work = store.resolve(), root.resolve()
    if store != root and (private.is_relative_to(work) or work.is_relative_to(private)):
        raise ProvError("溯源库须位于项目根目录之外")
    if not project:
        argv += [f"--git-dir={store}", f"--work-tree={root}"]
        env["GIT_INDEX_FILE"] = str(store / f"index-{branch}")
        if bulk and command == "update-index":
            # Git's bulk check-in writes one pack instead of opening and syncing thousands of loose objects.
            argv += ["-c", "core.bigFileThreshold=1"]
        if command == "commit-tree" and date:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
    else:
        # Commit/object reads have no need for the project's working index.
        env["GIT_INDEX_FILE"] = str(store / f"unborn-{branch}")
        if command == "ls-files":
            # This read uses the user's core.excludesFile as well as .gitignore and info/exclude.
            for key in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"):
                if key in os.environ:
                    env[key] = os.environ[key]
                else:
                    del env[key]
    with project_index(root, store) if project and command == "ls-files" else nullcontext(None) as mirror:
        if mirror:
            private, common = mirror
            argv += [f"--git-dir={private}", f"--work-tree={root}"]
            env.update(GIT_COMMON_DIR=str(common), GIT_INDEX_FILE=str(private / "index"))
        run = subprocess.run([*argv, command, *args], input=data, capture_output=True, env=env)
    if run.returncode and not optional:
        raise ProvError(f"git {command}: {run.stderr.decode(errors='replace').strip()}")
    return run.stdout if not run.returncode else b""


def init(store: Path) -> None:
    # A bare repository needs no worktree, templates, hooks or user configuration.
    with _init_lock:
        if (store / "HEAD").is_file():
            return
        for sub in ("objects", "refs/heads", "info"):
            (store / sub).mkdir(parents=True, exist_ok=True)
        (store / "config").write_text("[core]\n\tbare = true\n[gc]\n\tauto = 0\n")
        (store / "info/attributes").write_text("* -filter -text -ident !working-tree-encoding !diff\n")
        (store / "HEAD").write_text("ref: refs/heads/code\n")


def safe_name(path: str) -> bool:
    return bool(path and "\0" not in path and not path.startswith("/") and
                all(p not in ("", ".", "..") and p.casefold() not in PRIVATE for p in path.split("/")))


def file_hash(path: Path, size: int) -> str:
    digest = hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def blob_id(data: bytes) -> str:
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def filename_list(paths) -> bytes:
    return b"".join(os.fsencode(p) + b"\0" for p in paths)


class Repo:
    def __init__(self, store: Path, root: Path, branch: str):
        self.store, self.root, self.branch = store, root, branch

    def git(self, command, *args, **kw):
        return git(self.root, command, *args, store=self.store, branch=self.branch, **kw)

    def project(self, command, *args, **kw):
        return self.git(command, *args, project=True, **kw)

    def candidates(self):
        if (self.root / ".git").exists():
            raw = self.project("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".")
            return {os.fsdecode(p) for p in raw.split(b"\0") if p}
        paths = set()
        for folder, dirs, names in os.walk(self.root):
            dirs[:] = [d for d in dirs if d.casefold() not in SKIP]
            rel = Path(folder).relative_to(self.root)
            paths.update(str(rel / name) for name in names)
        return paths

    def stage(self, pinned: set[str], max_bytes: int, max_files: int) -> str:
        """Git's index handles the stat fast path. Large objects have a separate stat cache for their small pointers."""
        candidates = self.candidates()
        old = {os.fsdecode(p) for p in self.git("ls-files", "-z").split(b"\0") if p}
        cache_path = self.store / f"large-{self.branch}.json"
        prev = read_json(cache_path, {})
        large, small, pointers = {}, [], []
        safe_dirs = {"": True}
        for path in [*sorted(pinned), *sorted(candidates - pinned)]:
            if not safe_name(path):
                continue
            parent = path.rpartition("/")[0]
            if parent not in safe_dirs:
                folder = self.root / parent
                safe_dirs[parent] = folder.resolve() == folder
            if not safe_dirs[parent]:
                continue
            f = self.root / path
            try:
                st = f.lstat()
            except (FileNotFoundError, NotADirectoryError):
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if len(large) + len(small) >= max_files and path not in pinned:
                break
            if st.st_size <= max_bytes:
                small.append(path)
                continue
            sig = [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode]
            cached = prev.get(path)
            if cached and sig == cached[0] and path in old:
                large[path] = cached
                continue
            pointer = f"Papertown large file\nsize {st.st_size}\nblob {file_hash(f, st.st_size)}\n".encode()
            oid = self.git("hash-object", "-w", "--stdin", data=pointer).strip().decode()
            pointers.append(b"120000 " + oid.encode() + b"\t" + os.fsencode(path) + b"\0")
            large[path] = [sig, oid]
        gone = old.difference(small, large)
        if gone:
            self.git("update-index", "--force-remove", "-z", "--stdin", data=filename_list(gone))
        if small:
            self.git("update-index", "--add", "--replace", "-z", "--stdin", data=filename_list(small), bulk=len(set(small) - old) >= 512)
        if pointers:
            self.git("update-index", "-z", "--index-info", data=b"".join(pointers))
        if large != prev:
            write_json(cache_path, large)
        return self.git("write-tree").strip().decode()

    def files(self, old: str, new: str) -> list[dict]:
        rows = self.git("diff-tree", "--no-renames", "--no-ext-diff", "--no-textconv", "-r", "--numstat", "-z", old, new)
        out = []
        for entry in rows.split(b"\0"):
            if entry:
                add, remove, path = entry.split(b"\t", 2)
                out.append({"path": os.fsdecode(path), "added": int(add) if add != b"-" else 0,
                            "removed": int(remove) if remove != b"-" else 0})
        return out

    def blobs(self, specs: list[str]) -> dict[str, bytes]:
        if not specs:
            return {}
        raw = self.git("cat-file", "--batch", "-z", data=filename_list(specs))
        out, modes, pos = {}, {}, 0
        for spec in specs:
            # With -z the request is NUL-delimited, but Git still terminates responses with LF.
            missing = os.fsencode(spec) + b" missing\n"
            if raw.startswith(missing, pos):
                pos += len(missing)
                continue
            end = raw.index(b"\n", pos)
            _, kind, size = raw[pos:end].split()
            pos = end + 1
            if kind == b"blob":
                content = raw[pos:pos + int(size)]
                if ":" in spec and POINTER.fullmatch(content):
                    commit, path = spec.split(":", 1)
                    folder, _, name = path.rpartition("/")
                    tree = commit + ":" + folder
                    if tree not in modes:
                        # Raw tree entries avoid quoting ambiguities in tabs, newlines and Unicode filenames.
                        entries = self.git("cat-file", "tree", tree)
                        at, pointers = 0, set()
                        while at < len(entries):
                            nul = entries.index(b"\0", at)
                            mode, filename = entries[at:nul].split(b" ", 1)
                            if mode == b"120000":
                                pointers.add(filename)
                            at = nul + 21
                        modes[tree] = pointers
                    if os.fsencode(name) in modes[tree]:
                        content = LargeFile(content)
                out[spec] = content
            pos += int(size) + 1
        return out


def porcelain(raw: bytes):
    """Map each final line to the originating commit, original line and author."""
    out = []
    commit, original, author, ts, path = "", 0, "", 0, ""
    for line in raw.split(b"\n"):
        if line.startswith(b"\t"):
            out.append((commit, original, author, ts, path))
        elif line.startswith(b"author "):
            author = line[7:].decode(errors="replace")
        elif line.startswith(b"author-time "):
            ts = int(line[12:])
        elif line.startswith(b"filename "):
            name = line[9:]
            path = os.fsdecode(ast.literal_eval("b" + name.decode("ascii")) if name.startswith(b'"') else name)
        elif m := re.fullmatch(rb"([a-f0-9]{40,64}) (\d+) \d+(?: \d+)?", line):
            commit, original = m[1].decode(), int(m[2])
    return out
