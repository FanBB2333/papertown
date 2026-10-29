"""Tool registry shared by every agent. Each call is traced with its kind, which is what
the trace panel and the status page count (RAG / MCP / SKILL / GRAPH / LLM ...).

API names use underscores (provider tool names cannot contain dots); the trace shows
the dotted label, e.g. library_search -> library.search.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

from .llm import ToolSpec
from .skills import SkillError

if TYPE_CHECKING:
    from .town import Town

MAX_RESULT_CHARS = 9000


@dataclass
class ToolCtx:
    town: "Town"
    run_id: str | None = None
    line_id: str | None = None
    stage: str | None = None
    worker: dict | None = None
    loaded: set[str] = field(default_factory=set)


class ToolError(Exception):
    pass


@dataclass
class Tool:
    name: str
    label: str
    kind: str
    description: str
    schema: dict
    fn: Callable[[ToolCtx, dict], Any]
    summarize: Callable[[Any], str] | None = None
    arg: str | None = None  # which argument to show in the trace label


def obj(required: list[str] | None = None, **props: dict) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


def s(desc: str, **kw: Any) -> dict:
    return {"type": "string", "description": desc, **kw}


def n(desc: str, **kw: Any) -> dict:
    return {"type": "integer", "description": desc, **kw}


def arr(desc: str, items: dict | None = None) -> dict:
    return {"type": "array", "description": desc, "items": items or {"type": "string"}}


def short(v: Any, k: int = 40) -> str:
    t = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return t if len(t) <= k else t[: k - 1] + "…"


def _count(v: Any) -> str:
    if isinstance(v, list):
        return f"{len(v)} 条"
    if isinstance(v, dict) and "summary" in v:
        return str(v["summary"])
    return "完成"


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def remove(self, name: str) -> None:
        self._tools.pop(name, None)

    def has(self, name: str) -> bool:
        return name in self._tools

    def get(self, name: str) -> Tool:
        return self._tools[name]

    def names(self) -> list[str]:
        return list(self._tools)

    def spec(self, name: str) -> ToolSpec:
        t = self._tools[name]
        return ToolSpec(t.name, t.description, t.schema)

    def label(self, name: str, args: dict) -> str:
        t = self._tools.get(name)
        if not t:
            return name
        if name == "read_reference":
            return f"{args.get('skill', '')}/{args.get('path', '')}"
        if name == "run_script":
            return f"{args.get('skill', '')}/scripts/{args.get('script', '')}"
        if name == "load_skill":
            return f"{args.get('name', '')}/SKILL.md"
        a = args.get(t.arg) if t.arg else None
        return f"{t.label}({short(a)})" if a not in (None, "") else t.label

    def call(self, ctx: ToolCtx, name: str, args: dict) -> tuple[str, Any, bool]:
        """Run a tool for an agent. Returns (content for the model, value, is_error)."""
        t = self._tools.get(name)
        t0 = time.monotonic()
        if not t:
            return f"没有 {name} 这个工具", None, True
        try:
            value = t.fn(ctx, args)
            err = False
            summary = (t.summarize or _count)(value)
        except (ToolError, SkillError, KeyError, ValueError, TypeError) as e:
            value, err, summary = None, True, f"出错：{e}"
        except Exception as e:  # network, subprocess timeouts ... reported to the model, not raised
            value, err, summary = None, True, f"出错：{type(e).__name__} {e}"
        ms = int((time.monotonic() - t0) * 1000)
        ctx.town.trace(t.kind, self.label(name, args), summary, ms, run_id=ctx.run_id, line_id=ctx.line_id)
        if err:
            return summary, None, True
        content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        if len(content) > MAX_RESULT_CHARS:
            content = content[:MAX_RESULT_CHARS] + "\n…（结果过长，已截断）"
        return content, value, False


# ---------- skill tools: progressive disclosure ----------

def _load_skill(ctx: ToolCtx, a: dict) -> str:
    sk = ctx.town.skills.get(a["name"])
    ctx.loaded.add(sk.name)
    extra = [f"references: {', '.join(sk.files('references'))}" if sk.files("references") else "",
             f"scripts: {', '.join(sk.files('scripts'))}" if sk.files("scripts") else ""]
    return "\n".join([sk.body, *[x for x in extra if x]])


def _need_loaded(ctx: ToolCtx, name: str) -> None:
    if name not in ctx.loaded:
        raise ToolError(f"先调用 load_skill 加载 {name}，再读取它的文件")


def _read_reference(ctx: ToolCtx, a: dict) -> str:
    _need_loaded(ctx, a["skill"])
    return ctx.town.skills.reference(a["skill"], a.get("path", ""))


def _run_script(ctx: ToolCtx, a: dict) -> Any:
    _need_loaded(ctx, a["skill"])
    return ctx.town.skills.run_script(a["skill"], a["script"], a.get("args") or {})


def register_skill_tools(reg: ToolRegistry) -> None:
    reg.add(Tool("load_skill", "load_skill", "SKILL", "读取一个 skill 的完整说明（SKILL.md 正文），以及它附带的 references 和 scripts 列表。",
                 obj(["name"], name=s("skill 名称")), _load_skill, lambda v: "加载 SKILL.md"))
    reg.add(Tool("read_reference", "read_reference", "SKILL", "读取已加载 skill 的参考文件，例如 references/rubric.md。",
                 obj(["skill", "path"], skill=s("skill 名称"), path=s("相对 skill 目录的路径")), _read_reference,
                 lambda v: "按需读取"))
    reg.add(Tool("run_script", "run_script", "SCRIPT", "运行已加载 skill 自带的脚本；args 作为 JSON 传给脚本，返回脚本输出的 JSON。确定性的计算交给脚本，不要自己估。",
                 obj(["skill", "script"], skill=s("skill 名称"), script=s("scripts/ 下的文件名"),
                     args={"type": "object", "description": "传给脚本的参数"}),
                 _run_script, lambda v: str(v.get("summary", "完成")) if isinstance(v, dict) else "完成"))
