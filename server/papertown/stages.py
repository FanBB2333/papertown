"""One function per stage of a paper's life, each building an AgentTask for the worker on duty.
Offline answers only rearrange retrieval hits, script outputs and the simulated results, and say so.
"""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

from .agent import AgentTask, run_agent
from .library import expand, phrases, tokens
from .llm import ToolSpec
from .tools import arr, n, obj, s

if TYPE_CHECKING:
    from .town import Town

PERSONAS = [("方法派", "methodologist"), ("实验派", "empiricist"), ("读者派", "reader")]


def _hits(v) -> list[dict]:
    return v.get("hits", []) if isinstance(v, dict) else []


def _verdict_args(sc: dict) -> dict:
    return {"candidates": [{"id": h["paper_id"], "title": h["title"], "similarity": h["similarity"]} for h in sc["hits"]],
            "method": sc["method"]}


def _arxiv_query(text: str) -> str:
    return " ".join(f'"{p}"' if " " in p else p for p in phrases(text)[:4])


REPORT = ToolSpec("submit_report", "提交撞车报告。", obj(
    ["verdict", "gap"],
    verdict=s("结论，照抄 verdict.py 的输出", enum=["可孵化", "需调整", "已被做过"]),
    similar=arr("最相近的工作（最多 3 篇）", obj(["paper_id", "title"], paper_id=s("如 arxiv:2401.01234"), title=s("标题"),
                                                similarity={"type": "number"}, note=s("它做了什么、和 idea 差在哪"))),
    gap=s("还没被覆盖的部分"),
    suggestions=arr("调整建议"),
    summary=s("一句话总结"),
))


def hatch(town: "Town", line: dict, worker: dict) -> tuple[dict, object]:
    idea = line["idea"]
    q = expand(idea) or idea

    def scored(r: dict) -> dict:
        ids = [h["arxiv_id"] for h in _hits(r.get("library_search")) + _hits(r.get("arxiv_search"))]
        return town.library.rescore(idea, ids)

    def args(key: str, r: dict):
        if key == "library_search":
            return {"query": q, "top_k": 8}
        if key == "arxiv_search":
            return {"query": _arxiv_query(idea), "max_results": 8}
        if key == "genealogy_expand":
            ids = [h["paper_id"] for h in scored(r)["hits"][:3]]
            return {"paper_ids": ids, "depth": 1} if ids else None
        if key == "run_script:verdict.py":
            return _verdict_args(scored(r))
        return None

    def payload(r: dict) -> dict:
        v = r.get("run_script:verdict.py") or {}
        sc = scored(r)
        hits = {h["paper_id"]: h for h in sc["hits"]}
        top = [hits[c["id"]] for c in v.get("ranked", []) if c["id"] in hits][:3]
        covered = {t for h in top for t in h["matched"]}
        missing = [t for t in sc["terms"] if t not in covered]
        similar = [{"paper_id": h["paper_id"], "title": h["title"], "similarity": h["similarity"],
                    "note": f"共用关键词：{', '.join(h['matched'][:5]) or '无'} · {h['year']} 年，{h['authors']}"} for h in top]
        verdict = v.get("verdict", "可孵化")
        summary = v.get("summary", verdict)
        gap = (f"最相近的工作里没有出现：{', '.join(missing[:6])}。" if missing else "关键词都被已有工作覆盖了，差异要从问题设定或验证方式上找。")
        sugg = {"已被做过": ["换一个没被验证过的任务或场景", "把已有方法当 baseline，找它的失败案例作为切入点"],
                "需调整": [f"围绕「{', '.join(missing[:3]) or '验证设定'}」收窄问题", "先精读最相近的两篇，确认差异是本质的"],
                "可孵化": ["立项时把最相近的工作列为 baseline", "尽早确定评测设定，避免和相近工作比不到一起"]}[verdict]
        return {"verdict": verdict, "similar": similar, "gap": gap, "suggestions": sugg,
                "summary": f"{summary}。离线模式：说明由检索结果拼成，没有经过模型理解。" if town.s.offline else summary}

    prompt = f"新 idea（来自市政厅）：\n{idea}\n\n预算：${line['budget']:.2f}\n请查重并写撞车报告。"
    task = AgentTask(worker=worker, stage="hatch", building="孵化场", prompt=prompt, finish=REPORT, payload=payload, args=args,
                     line_id=line["id"], required=["verdict", "gap"], budget=line["budget"] * 0.15)
    res = run_agent(town, task)
    report = dict(res.payload)
    # the verdict comes from verdict.py on candidates re-scored against the whole idea, not from the model
    sc = scored(res.results)
    final = town.skills.run_script("novelty-check", "verdict.py", _verdict_args(sc))
    if report.get("verdict") != final["verdict"]:
        report["verdict_note"] = f"结论以 verdict.py 为准（agent 给的是「{report.get('verdict')}」）"
    report["verdict"] = final["verdict"]
    known = {h["paper_id"]: h for h in sc["hits"]}
    for sim in report.get("similar") or []:
        h = known.get(sim.get("paper_id"))
        if h:
            sim["similarity"], sim["url"], sim["year"] = h["similarity"], h["url"], h["year"]
    report["sources"] = {"library": len(_hits(res.results.get("library_search"))), "arxiv": len(_hits(res.results.get("arxiv_search"))),
                         "method": sc["method"]}
    report["candidates"] = sc["hits"][:8]
    return report, res


DRAFT = ToolSpec("submit_draft", "提交方法草案。", obj(
    ["title", "problem", "mechanism", "baselines", "metrics"],
    title=s("英文题目"), problem=s("问题定义"), mechanism=arr("2～4 条核心机制"),
    baselines=arr("对比对象", obj(["name", "source"], name=s("名字"), source=s("仓库路径或 arXiv id"))),
    datasets=arr("评测任务或数据集"), metrics=arr("评价指标"), risks=arr("风险"),
))


def _metrics(snippets: list[str]) -> list[str]:
    for t in snippets:
        m = re.search(r"Metrics?:\s*([^.]+)\.", t)
        if m:
            parts = [p.strip() for p in re.split(r",|\band\b", m.group(1)) if p.strip()]
            return [p[:1].upper() + p[1:] + " (%)" for p in parts][:3]
    return ["Main metric (%)", "Secondary metric (%)"]


def method(town: "Town", line: dict, worker: dict, report: dict) -> tuple[dict, object]:
    idea, gap = line["idea"], report.get("gap", "")
    q = expand(f"{idea} {gap}")

    def args(key: str, r: dict):
        if key == "library_search":
            return {"query": q, "top_k": 6}
        if key == "repo_search":
            return {"query": f"{expand(idea)} baseline benchmark metrics"}
        return None

    def payload(r: dict) -> dict:
        repo_hits = _hits(r.get("repo_search"))
        ph = phrases(idea)
        title = " · ".join(p if p.isupper() else p.title() for p in ph[:4]) or "Untitled"
        baselines = [{"name": h["repo"].split("/")[-1] if h["path"].lower().startswith("readme")
                      else h["path"].split("/")[-1].removesuffix(".py").replace("_", " ").title(), "source": f"{h['repo']}/{h['path']}"}
                     for h in repo_hits if "baseline" in h["path"]][:2]
        baselines += [{"name": sim["title"].split(":")[0][:40], "source": sim["paper_id"]}
                      for sim in (report.get("similar") or [])[: max(0, 3 - len(baselines))]]
        missing = [p for p in ph if not any(t in gap for t in tokens(p))] or ph
        return {"title": f"{title} (Offline Draft)",
                "problem": f"Idea（原文）：{idea}。目标是解决撞车报告里的空白点：{gap}",
                "mechanism": [f"针对 {p} 设计专门的模块（离线模板，需要人来写具体机制）" for p in (missing[:3] or ["the core problem"])],
                "baselines": baselines, "datasets": [h["repo"] for h in repo_hits[:2]] or ["待定"],
                "metrics": _metrics([h["snippet"] for h in repo_hits]),
                "risks": ["离线模式下草案由检索结果拼成，机制部分需要真正的模型或人来写"] if town.s.offline else []}

    sims = "\n".join(f"- {x['title']}（{x.get('paper_id')}，相似度 {x.get('similarity')}）" for x in report.get("similar") or [])
    prompt = (f"idea：{idea}\n\n撞车报告结论：{report.get('verdict')}\n最相近的工作：\n{sims or '（无）'}\n空白点：{gap}\n"
              f"建议：{'；'.join(report.get('suggestions') or [])}\n\n请写方法草案。")
    task = AgentTask(worker=worker, stage="method", building="造纸厂", prompt=prompt, finish=DRAFT, payload=payload, args=args,
                     line_id=line["id"], required=["title", "problem", "mechanism", "baselines", "metrics"],
                     budget=line["budget"] * 0.22)
    res = run_agent(town, task)
    return dict(res.payload), res


RESULTS = ToolSpec("submit_results", "提交实验结果分析。", obj(
    ["job_id", "analysis"], job_id=s("gpu_submit 返回的任务 id"), analysis=s("结果分析"), concerns=arr("不足或疑点")))


def experiment(town: "Town", line: dict, worker: dict, draft: dict) -> tuple[dict, object]:
    names = [b["name"] for b in draft.get("baselines") or []][:3] or ["Baseline"]
    config = {"method": "Ours", "baselines": names, "metrics": (draft.get("metrics") or ["Main metric (%)"])[:3], "seeds": 3}

    def args(key: str, r: dict):
        if key == "gpu_status":
            return {}
        if key == "gpu_submit":
            st = r.get("gpu_status") or {}
            free = st.get("gpus", 1) - st.get("busy", 0)
            return {"name": "main", "config": config, "gpus": 2 if free >= 2 else 1}
        if key == "gpu_wait":
            job = r.get("gpu_submit") or {}
            return {"job_id": job["job_id"]} if job.get("job_id") else None
        return None

    def payload(r: dict) -> dict:
        res = (r.get("gpu_wait") or {}).get("result") or {}
        job_id = (r.get("gpu_submit") or {}).get("job_id", "")
        if not res:
            return {"job_id": job_id, "analysis": "任务没有完成，没有结果。", "concerns": ["实验没有跑完"]}
        rows, metrics = res["rows"], res["metrics"]
        ours, base = rows[-1], rows[:-1]
        wins = [m for k, m in enumerate(metrics) if ours["values"][k] > max(b["values"][k] for b in base)]
        lead = "以下是模拟电厂的模拟结果，不是真实实验。" if res.get("simulated") else ""
        gains = "；".join(f"{m} {ours['values'][k]} vs {max(b['values'][k] for b in base)}" for k, m in enumerate(metrics))
        return {"job_id": job_id,
                "analysis": f"{lead}{res['seeds']} 个种子取平均。Ours 在 {len(wins)}/{len(metrics)} 项指标上超过最好的 baseline：{gains}。",
                "concerns": [f"{m} 没有超过 baseline" for m in metrics if m not in wins] + ["需要补消融实验"]}

    prompt = (f"方法草案：{draft.get('title')}\n机制：{'；'.join(draft.get('mechanism') or [])}\n"
              f"baseline：{', '.join(names)}\n指标：{', '.join(config['metrics'])}\n\n请提交主实验并分析结果。")
    task = AgentTask(worker=worker, stage="exp", building="实验农场", prompt=prompt, finish=RESULTS, payload=payload, args=args,
                     line_id=line["id"], required=["job_id", "analysis"], budget=line["budget"] * 0.12)
    res = run_agent(town, task)
    job = town.plant.jobs.get(res.payload.get("job_id", ""))
    if not job:
        job = town.plant.submit(line["id"], "main", config, 1)
        town.trace("TOOL", "power.submit(main)", "实验员没有提交，由流水线代为提交", 0, line_id=line["id"])
    job = town.plant.wait(job.id)
    table = dict(job.result or {}, job_id=job.id, analysis=res.payload.get("analysis", ""), concerns=res.payload.get("concerns", []))
    return table, res


PAPER = ToolSpec("submit_paper", "提交这一版初稿的说明（正文已通过 press_typeset 排版）。",
                 obj(["summary"], summary=s("这一版写了什么、还缺什么")))


def write(town: "Town", line: dict, worker: dict, report: dict, draft: dict, table: dict, feedback: list[str]) -> tuple[dict, object]:
    lib = town.library
    cite_ids = [x["paper_id"] for x in report.get("similar") or []]
    cite_ids += [c["paper_id"] for c in report.get("candidates") or [] if c["paper_id"] not in cite_ids][: max(0, 8 - len(cite_ids))]
    keys = {i: lib.bibkey(i.removeprefix("arxiv:")) for i in cite_ids}

    def cite(ids: list[str]) -> str:
        return "\\cite{" + ",".join(keys[i] for i in ids) + "}" if ids else ""

    def sections(papers: list[dict]) -> dict:
        by = {f"arxiv:{p['arxiv_id']}": p for p in papers}
        close = [i for i in cite_ids[:3] if i in by]
        rel = " ".join(f"{by[i]['title']}~{cite([i])} is closely related to our setting." for i in close)
        more = [i for i in cite_ids[3:] if i in by]
        rel2 = (" Other relevant lines of work include " + ", ".join(f"{by[i]['title']}~{cite([i])}" for i in more) + ".") if more else ""
        mech = "\n".join(f"\\subsection{{Component {k + 1}}}\nThis component addresses: {m}." for k, m in enumerate(draft.get("mechanism") or []))
        res_note = "The numbers in Table~\\ref{tab:main} come from a simulated run and are placeholders." if table.get("simulated") else ""
        return {
            "abstract": f"{draft.get('title')}. We target a gap left by prior work. This draft was assembled offline from retrieved papers, "
                        f"the method outline and a {'simulated ' if table.get('simulated') else ''}experiment; every section needs rewriting by an author.",
            "introduction": "Prior work leaves an open problem." + (f" Closest to us are {cite(cite_ids[:3])}." if cite_ids else "") + "\n"
                            "\\begin{itemize}\n" + "\n".join(f"\\item {m}" for m in draft.get("mechanism") or []) + "\n\\end{itemize}",
            "related_work": rel + rel2,
            "method": mech,
            "experiments": f"We compare against {', '.join(b['name'] for b in draft.get('baselines') or [])} on "
                           f"{', '.join(draft.get('metrics') or [])}. {res_note}",
            "conclusion": "This offline draft fixes the structure of the paper; the claims above are placeholders until the method is written and real experiments are run.",
        }

    def args(key: str, r: dict):
        if key == "paper_get":
            return {"ids": cite_ids} if cite_ids else None
        if key == "press_typeset":
            got = r.get("paper_get")
            papers = got.get("papers", []) if isinstance(got, dict) else []
            secs = sections(papers or lib.get(cite_ids))
            return {"title": draft.get("title", "Untitled"), "abstract": secs.pop("abstract"), "sections": secs, "cite_ids": cite_ids}
        return None

    def payload(r: dict) -> dict:
        t = r.get("press_typeset") or {}
        return {"summary": f"离线模板排版：{t.get('summary', '未排版')}，引用 {t.get('cited', 0)} 篇。"}

    keylist = "\n".join(f"- {keys[i]}  {x['title']}" for i in cite_ids for x in (report.get("candidates") or []) + (report.get("similar") or [])
                        if x.get("paper_id") == i)
    keylist = "\n".join(dict.fromkeys(keylist.splitlines()))
    prompt = (f"方法草案：\n{draft}\n\n实验结果分析：{table.get('analysis', '')}\n"
              f"结果表{'（模拟数据）' if table.get('simulated') else ''}由印刷厂自动插入。\n\n可引用的论文（bib key  标题）：\n{keylist}\n"
              + ("\n上一版的审稿意见，这一版要逐条回应：\n" + "\n".join(f"- {f}" for f in feedback) if feedback else "")
              + "\n\n请写初稿并排版。")
    task = AgentTask(worker=worker, stage="write", building="印刷厂", prompt=prompt, finish=PAPER, payload=payload, args=args,
                     line_id=line["id"], required=["summary"], budget=line["budget"] * 0.30)
    res = run_agent(town, task)
    tex = town.db.one("select * from items where line_id = ? and kind = 'tex' order by created_at desc, rowid desc limit 1", line["id"])
    if not tex:  # the model never typeset: use the template so the line can go on
        a = args("press_typeset", {})
        info = town.press.typeset(line["id"], a["title"], a["abstract"], a["sections"], a["cite_ids"], table)
        tex = town.save_item(line["id"], "tex", "write", "press", a["title"], {**a, "typeset": info})
    return dict(tex["body"], summary=res.payload.get("summary", "")), res


REVIEW = ToolSpec("submit_review", "提交审稿意见。", obj(
    ["overall", "decision"],
    scores=obj(["novelty", "soundness", "clarity"], novelty=n("1-10"), soundness=n("1-10"), clarity=n("1-10")),
    overall=n("1-10 总分"), strengths=arr("优点"), weaknesses=arr("问题，指向具体位置"),
    decision=s("accept 或 revise", enum=["accept", "revise"]),
))


def format_check(town: "Town", line: dict, tex: dict) -> dict:
    info = tex.get("typeset") or {}
    args = {"tex": town.press.read(line["id"]), "pages": info.get("pages"), "page_limit": 9, "cited": info.get("cited", 0)}
    if not info.get("compiled") and not town.press.compile_tex:
        args["pages"] = max(1, info.get("words", 0) // 550)  # no TeX installed: estimate from length
    t0 = time.monotonic()
    out = town.skills.run_script("anonymity-check", "check.py", args)
    town.trace("SCRIPT", "anonymity-check/scripts/check.py", out.get("summary", ""), int((time.monotonic() - t0) * 1000), line_id=line["id"])
    return out


def review(town: "Town", line: dict, worker: dict, k: int, report: dict, table: dict, fmt: dict) -> tuple[dict, object]:
    persona, persona_en = PERSONAS[k % len(PERSONAS)]
    closest = max([x.get("similarity") or 0 for x in report.get("similar") or []], default=0)

    def args(key: str, r: dict):
        return {"name": "main.tex"} if key == "press_read" else None

    def payload(r: dict) -> dict:
        blocking = [i for i in fmt.get("issues", []) if i["blocking"]]
        novelty = max(3, min(9, round(8 - 4 * closest)))
        soundness = 4 if table.get("simulated") else 6
        clarity = 5 if town.s.offline else 6
        weak = [f"格式：{i['detail']}" for i in fmt.get("issues", [])]
        if persona_en == "methodologist":
            weak.append(f"Method：和最相近的工作「{(report.get('similar') or [{}])[0].get('title', '—')}」的区别需要单独一段讨论")
        if persona_en == "empiricist":
            weak += ["Experiments：结果来自模拟电厂，需要真实实验" if table.get("simulated") else "Experiments：缺少消融实验",
                     *[f"Experiments：{c}" for c in table.get("concerns", [])[:2]]]
        if persona_en == "reader" and town.s.offline:
            weak.append("全文：正文是离线模板，需要作者重写")
        extra = [kk.split(":", 1)[1] for kk in r if kk.startswith("load_skill:") and kk != "load_skill:paper-review"]
        own = {"read_reference:references/personas.md", "read_reference:references/rubric.md"}
        refs = [v for kk, v in r.items() if kk.startswith("read_reference:") and kk not in own and isinstance(v, str)]
        items = [ln[2:].strip() for ref in refs for ln in ref.splitlines() if ln.startswith("- ")][:3]
        for name in extra:
            weak += [f"{name}：请写明{x}" for x in items] or [f"{name}：已检查"]
        overall = max(1, round((novelty + soundness + clarity) / 3) - (1 if blocking else 0))
        return {"scores": {"novelty": novelty, "soundness": soundness, "clarity": clarity}, "overall": overall,
                "strengths": ["结构完整，各节齐全"] + (["引用了检索到的相近工作"] if (fmt.get("issues") is not None and not any(i["rule"] == "引用" for i in fmt["issues"])) else []),
                "weaknesses": weak, "decision": "accept" if overall >= 5 and not blocking else "revise"}

    issues = "\n".join(f"- {'[硬伤] ' if i['blocking'] else ''}{i['rule']}：{i['detail']}" for i in fmt.get("issues", [])) or "（无）"
    prompt = (f"你的审稿视角：{persona}（{persona_en}）。\n格式检查结果：\n{issues}\n"
              f"实验数据：{'模拟电厂的模拟结果' if table.get('simulated') else '真实实验'}。\n请审这篇初稿。")
    task = AgentTask(worker=worker, stage="review", building="质检所", prompt=prompt, finish=REVIEW, payload=payload, args=args,
                     line_id=line["id"], persona=f"你是{persona}审稿人。", required=["overall", "decision"],
                     budget=line["budget"] * 0.26 / 2)
    res = run_agent(town, task)
    out = dict(res.payload, worker=worker["id"], persona=persona, extra_skills=[x for x in res.skills if x != "paper-review"])
    return out, res


REPLY = ToolSpec("reply", "回复用户。", obj(["text"], text=s("回复内容，中文")))


def ask(town: "Town", worker: dict, building: dict, question: str, line: dict | None, context: str) -> tuple[dict, object]:
    """A building's worker answers the user."""

    def payload(r: dict) -> dict:
        items = r.get("line_items") or []
        last = items[-1] if isinstance(items, list) and items else None
        state = f"最近的产出是「{last['title']}」（{last['stage']}）。" if last else ""
        return {"text": f"这里是{town.world.name(building)}，{context}{state}离线模式下我只能报告状态，接入模型后可以回答具体问题。"}

    plan = [("", "line_items")] if line else []
    task = AgentTask(worker=worker, stage="ask", building=town.world.name(building),
                     prompt=f"当前状态：{context}\n\n用户的问题：{question}", finish=REPLY, payload=payload,
                     args=lambda key, r: {} if key == "line_items" else None, line_id=line["id"] if line else None,
                     skills=[], plan=plan, extra_tools=["library_search", "line_items", "repo_search"], required=["text"], max_steps=8)
    res = run_agent(town, task)
    return res.payload, res
