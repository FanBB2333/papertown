"""Pages the project's agents write for you in HTML (`pt publish`), kept as written. They are
shown in a sandbox: an origin of their own with no network (the Content-Security-Policy of /view), where
only the town's font may load from Papertown.

    data/projects/<project>/pages/index.json    what each page is: title, kind, who, when
    data/projects/<project>/pages/<id>.html
"""

from __future__ import annotations

import html as _html
import re
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from .db import now, read_json, write_json

if TYPE_CHECKING:
    from .town import Town

KINDS = {"report": "汇报", "explain": "讲解", "answer": "回答"}
WRITTEN = ("report", "explain")  # answer: a lead's answer to one of the questions there used to be, with its id in `question`
MAX = 3_000_000  # characters: a page carries its pictures in it
KEEP = 200


def csp(origin: str = "") -> str:
    """The sandbox: scripts in an origin of their own, links opening in a new tab, nothing fetched
    but the town's font from Papertown (`origin`)."""
    own = f" {origin}" if origin else ""
    return ("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src 'unsafe-inline'; "
            f"style-src 'unsafe-inline'{own}; img-src data: blob:; media-src data: blob:; font-src data:{own}; form-action 'none'")


# Put before a page's own head: the town's --pt-* variables, compact defaults, and a script that reports its height
# and opens data-pt-file / data-pt-job / data-pt-page links in Papertown.
HEAD = """<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank">
<style>
:root { --pt-bg: #f4eee2; --pt-panel: #fcf8f0; --pt-panel2: #f3ecdf; --pt-ink: #2f261d; --pt-muted: #857560; --pt-line: rgba(84, 62, 40, .2);
  --pt-brand: #c2663f; --pt-ok: #6b9160; --pt-warn: #c38b2e; --pt-bad: #b9543f;
  --pt-font: "LXGW WenKai Screen", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
  --pt-head: "LXGW WenKai Screen", "Songti SC", STSong, serif; --pt-mono: "SF Mono", Menlo, Consolas, monospace; }
html { background: var(--pt-bg); color: var(--pt-ink); font: 15px/1.6 var(--pt-font); -webkit-text-size-adjust: 100%; }
body { box-sizing: border-box; max-width: 880px; margin: 0 auto; padding: 18px clamp(14px, 3vw, 28px) 20px; }
h1, h2, h3 { margin: 18px 0 6px; font-family: var(--pt-head); font-weight: 400; line-height: 1.35; }
h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
body > :first-child { margin-top: 0; }
p, ul, ol, table, pre { margin: 0 0 8px; }
ul, ol { padding-left: 1.3em; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 12px 4px 0; border-bottom: 1px solid var(--pt-line); text-align: left; font-weight: 400; }
thead th { font-size: 13px; color: var(--pt-muted); }
code, pre { font-family: var(--pt-mono); font-size: .9em; }
pre { overflow-x: auto; }
a { color: var(--pt-brand); }
img, svg, video, canvas { max-width: 100%; }
[data-pt-file], [data-pt-job], [data-pt-page] { cursor: pointer; }
</style>
<script>(() => {
  if (parent === window) return;
  const post = m => parent.postMessage(Object.assign({ pt: 1 }, m), '*');
  const tall = () => { const b = document.body; if (!b) return; const s = getComputedStyle(b);
    post({ h: Math.ceil(b.getBoundingClientRect().height + parseFloat(s.marginTop) + parseFloat(s.marginBottom)) }); };
  addEventListener('load', tall);
  addEventListener('DOMContentLoaded', () => { tall(); new ResizeObserver(tall).observe(document.body); });
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('[data-pt-file],[data-pt-job],[data-pt-page],a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    if (a.matches('a[href^="#"]')) { const t = document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); if (t) t.scrollIntoView({ behavior: 'smooth' }); return; }
    post({ open: { file: a.dataset.ptFile, job: a.dataset.ptJob, page: a.dataset.ptPage } });
  });
  document.addEventListener('keydown', e => { if (['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.target.closest('input,textarea,select,[contenteditable]')) post({ key: e.key }); });
})();</script>
"""


class PageError(Exception):
    pass


def title_of(html: str) -> str:
    for pat in (r"<title[^>]*>(.*?)</title>", r"<h1[^>]*>(.*?)</h1>"):
        m = re.search(pat, html, re.I | re.S)
        if m:
            t = " ".join(_html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).split())
            if t:
                return t
    return ""


# --pt-* variables for the app's looks other than paper, whose are HEAD's defaults
_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", Roboto, Arial, sans-serif'
LOOKS = {
    "light": f"--pt-bg: #fafafa; --pt-panel: #fff; --pt-panel2: #f5f5f5; --pt-ink: #171717; --pt-muted: #737373; --pt-line: #e5e5e5; "
             f"--pt-brand: #0a6cff; --pt-ok: #059669; --pt-warn: #d97706; --pt-bad: #dc2626; --pt-font: {_SANS}; --pt-head: {_SANS};",
    "dark": f"--pt-bg: #111; --pt-panel: #1a1a1a; --pt-panel2: #222; --pt-ink: #f5f5f5; --pt-muted: #a3a3a3; --pt-line: #333; "
            f"--pt-brand: #5a9bff; --pt-ok: #34d399; --pt-warn: #fbbf24; --pt-bad: #f87171; --pt-font: {_SANS}; --pt-head: {_SANS};",
}


def render(html: str, fonts: str = "", look: str = "") -> str:
    """The page as shown: the app's look (paper, with its font's stylesheet `fonts`, or one of LOOKS)
    and the script to the page around it, before its own head."""
    if look in LOOKS:
        head = HEAD + f"<style>:root {{ {LOOKS[look]} }} h1, h2, h3 {{ font-weight: 600; }}</style>"
    else:
        head = HEAD + (f'<link rel="stylesheet" href="{_html.escape(fonts)}">' if fonts else "")
    m = re.search(r"<head(\s[^>]*)?>", html, re.I)
    if m:
        return html[:m.end()] + head + html[m.end():]
    m = re.search(r"<html(\s[^>]*)?>", html, re.I)
    if m:
        return html[:m.end()] + "<head>" + head + "</head>" + html[m.end():]
    return "<!doctype html><html><head>" + head + "</head><body>" + html + "</body></html>"


class Pages:
    def __init__(self, town: Town):
        self.town = town
        self._lock = threading.Lock()

    def _dir(self, line_id: str) -> Path:
        return self.town.s.projects_dir / line_id / "pages"

    def all(self, line_id: str) -> list[dict]:
        return read_json((self._dir(line_id) / "index.json"), [])

    def _save(self, line_id: str, rows: list[dict]) -> None:
        p = self._dir(line_id) / "index.json"
        write_json(p, rows)

    def get(self, line_id: str, pid: str) -> dict:
        meta = next((p for p in self.all(line_id) if p["id"] == pid), None)
        if not meta:
            raise PageError("没有这个页面")
        return meta

    def html(self, line_id: str, pid: str) -> str:
        self.get(line_id, pid)
        try:
            return (self._dir(line_id) / f"{pid}.html").read_text(encoding="utf-8")
        except OSError as e:
            raise PageError("没有这个页面") from e

    def publish(self, line_id: str, html: str, title: str = "", kind: str = "explain", by: str = "", agent: str = "") -> dict:
        if self.town.db.val("select seq from lines where id = ?", line_id) is None:
            raise PageError("没有这个项目")
        html = html.strip()
        if not html:
            raise PageError("页面是空的")
        if len(html) > MAX:
            raise PageError(f"页面太大了：最多 {MAX // 1_000_000} MB，图换成 SVG 或压小一点")
        if kind not in WRITTEN:
            raise PageError(f"kind 只能是 {'、'.join(WRITTEN)}")
        title = " ".join((title or title_of(html) or "没有标题的页面").split())[:120]
        d = self._dir(line_id)
        with self._lock:
            d.mkdir(parents=True, exist_ok=True)
            rows = self.all(line_id)
            n = max((p["n"] for p in rows), default=0) + 1
            meta = {"id": f"p{n}", "n": n, "title": title, "kind": kind, "by": by, "agent": agent, "at": now(), "size": len(html)}
            (d / f"{meta['id']}.html").write_text(html, encoding="utf-8")
            rows.append(meta)
            for old in rows[:-KEEP]:
                (d / f"{old['id']}.html").unlink(missing_ok=True)
            self._save(line_id, rows[-KEEP:])
        self.town.bus.publish("page", line_id=line_id, page=meta)
        self.town.trace("页面", f"{KINDS[kind]}：{title[:40]}", by, 0, line_id=line_id)
        return meta

    def remove(self, line_id: str, pid: str) -> None:
        with self._lock:
            rows = self.all(line_id)
            if not any(p["id"] == pid for p in rows):
                raise PageError("没有这个页面")
            self._save(line_id, [p for p in rows if p["id"] != pid])
            (self._dir(line_id) / f"{pid}.html").unlink(missing_ok=True)
        self.town.bus.publish("page", line_id=line_id, page={"id": pid, "removed": True})
