"""The print shop: assembles a paper's TeX from sections, builds refs.bib from the library,
and compiles it when latexmk is installed. A compile error is a paper jam: the log tail
goes back to the writer.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import zipfile
from pathlib import Path

from .library import Library

SECTIONS = [("introduction", "Introduction"), ("related_work", "Related Work"), ("method", "Method"),
            ("experiments", "Experiments"), ("conclusion", "Conclusion")]

PREAMBLE = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{hyperref}
\title{%(title)s}
\author{Anonymous Authors}
\date{}
\begin{document}
\maketitle
"""

UNICODE = {"\u2013": "--", "\u2014": "---", "\u2018": "`", "\u2019": "'", "\u201c": "``", "\u201d": "''",
           "\u2026": "...", "\u00d7": r"$\times$", "\u2192": r"$\rightarrow$", "\u2264": r"$\le$", "\u2265": r"$\ge$"}


def tex_escape(text: str) -> str:
    """For plain strings (titles, table cells). Section bodies are LaTeX already."""
    text = re.sub(r"([&%#_$])", r"\\\1", text)
    return text.replace("~", r"\textasciitilde{}").replace("^", r"\textasciicircum{}")


def clean_body(text: str) -> str:
    for k, v in UNICODE.items():
        text = text.replace(k, v)
    # pdflatex cannot set CJK without extra packages; drop it rather than jam
    text = re.sub(r"[\u3000-\u9fff\uff00-\uffef]+", "", text)
    # a bare % or & in prose would comment out or break the line
    text = re.sub(r"(?<!\\)%", r"\\%", text)
    if "\\begin{tabular}" not in text:
        text = re.sub(r"(?<!\\)&", r"\\&", text)
    return text


def results_table(table: dict | None) -> str:
    if not table or not table.get("rows"):
        return ""
    metrics = table["metrics"]
    head = " & ".join(["Method", *map(tex_escape, metrics)]) + r" \\"
    best = [max(r["values"][k] for r in table["rows"]) for k in range(len(metrics))]
    lines = []
    for r in table["rows"]:
        cells = [rf"\textbf{{{v}}}" if v == best[k] else str(v) for k, v in enumerate(r["values"])]
        lines.append(" & ".join([tex_escape(r["method"]), *cells]) + r" \\")
    note = " Numbers come from a simulated run and are placeholders until real experiments finish." if table.get("simulated") else ""
    return ("\\begin{table}[t]\n\\centering\n\\begin{tabular}{l" + "c" * len(metrics) + "}\n\\toprule\n" + head + "\n\\midrule\n"
            + "\n".join(lines) + "\n\\bottomrule\n\\end{tabular}\n\\caption{Main results (mean over "
            + str(table.get("seeds", 3)) + " seeds)." + note + "}\n\\label{tab:main}\n\\end{table}\n")


class Press:
    def __init__(self, root: Path, library: Library, compile_tex: bool = True):
        self.root = root
        self.library = library
        self.compile_tex = compile_tex and shutil.which("latexmk") is not None

    def dir(self, line_id: str) -> Path:
        d = self.root / line_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def typeset(self, line_id: str, title: str, abstract: str, sections: dict, cite_ids: list[str],
                table: dict | None = None) -> dict:
        d = self.dir(line_id)
        papers = self.library.get(cite_ids)
        keys = {self.library.bibkey(p["arxiv_id"]) for p in papers}
        (d / "refs.bib").write_text("\n".join(self.library.bibtex(p) for p in papers), encoding="utf-8")

        body = [PREAMBLE % {"title": tex_escape(title)}, "\\begin{abstract}\n" + clean_body(abstract) + "\n\\end{abstract}\n"]
        for key, name in SECTIONS:
            text = clean_body(sections.get(key, "").strip())
            if key == "experiments":
                text = text + "\n\n" + results_table(table)
            if text.strip():
                body.append(f"\\section{{{name}}}\n{text}\n")
        body.append("\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n")
        tex = "\n".join(body)
        # citations the library cannot resolve would print as [?]; drop them
        tex = re.sub(r"\\cite[tp]?\{([^}]*)\}", lambda m: self._cite(m.group(1), keys), tex)
        (d / "main.tex").write_text(tex, encoding="utf-8")

        out = {"dir": str(d), "files": ["main.tex", "refs.bib"], "cited": len(keys), "words": len(re.findall(r"[A-Za-z]+", tex)),
               "compiled": False, "pages": None, "log": ""}
        if self.compile_tex:
            out.update(self.compile(d))
        out["summary"] = (f"PDF {out['pages']} 页" if out["compiled"] else ("编译失败（卡纸）" if self.compile_tex else "已排版，未编译"))
        return out

    @staticmethod
    def _cite(inner: str, keys: set[str]) -> str:
        ok = [k.strip() for k in inner.split(",") if k.strip() in keys]
        return f"\\cite{{{','.join(ok)}}}" if ok else ""

    def compile(self, d: Path) -> dict:
        try:
            r = subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
                               cwd=d, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            return {"compiled": False, "log": "latexmk 超时"}
        log = (d / "main.log").read_text(errors="ignore") if (d / "main.log").exists() else r.stdout
        m = re.search(r"Output written on main\.pdf \((\d+) page", log)
        ok = r.returncode == 0 and (d / "main.pdf").exists()
        errors = "\n".join(l for l in log.splitlines() if l.startswith("!"))[:1200]
        return {"compiled": ok, "pages": int(m.group(1)) if m else None, "log": errors if not ok else "",
                "files": ["main.tex", "refs.bib"] + (["main.pdf"] if ok else [])}

    def read(self, line_id: str, name: str = "main.tex") -> str:
        p = self.dir(line_id) / name
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def package(self, line_id: str) -> Path:
        d = self.dir(line_id)
        z = d / "paper.zip"
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as f:
            for name in ("main.tex", "refs.bib", "main.pdf"):
                if (d / name).exists():
                    f.write(d / name, name)
        return z
