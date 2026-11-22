import asyncio
import json

import pytest
from textual.widgets import DataTable

from papertown.tui.app import Main, Papertown
from papertown.tui.client import Api
from papertown.tui.edthemes import Prefs, role_for
from papertown.tui.texlex import BibtexLexer, LatexLexer
from papertown.tui.views.ide import EdTextArea, Editor, FileTree, Ide, LookPicker
from papertown.tui.widgets import Confirm

from .test_linked import git_repo, linked_settings
from .test_tui import serving, until


def roles(lexer, text: str) -> list[tuple[str | None, str]]:
    toks = list(lexer.get_tokens_unprocessed(text))
    assert "".join(v for _, _, v in toks) == text
    return [(role_for(t), v) for _, t, v in toks if v.strip()]


def test_tex_and_bib_are_read_as_the_page_reads_them():
    r = dict((v, k) for k, v in roles(LatexLexer(), "\\section{Method} % idea\nso $f(x)=\\alpha x^2$ \\cite{he2016}\n"))
    assert (r["\\section"], r["Method"], r["% idea"]) == ("macro", "head", "com")
    assert (r["$"], r["f"], r["\\alpha"], r["2"], r["he2016"]) == ("mathDelim", "math", "mathCmd", "num", "label")
    r = dict((v, k) for k, v in roles(BibtexLexer(), "@article{he2016,\n  title = {Deep {Res} Nets},\n  month = jan,\n}\n"))
    assert (r["@article"], r["he2016"], r["title"], r["{Deep {Res} Nets}"], r["jan"]) == ("kw", "label", "prop", "str", "var")


def test_prefs_keep_only_what_they_know(tmp_path):
    p = tmp_path / "tui.json"
    Prefs(theme="papertown-paper", ed_theme="nord", ed_icons="badges", focus=True).save(p)
    assert Prefs.load(p) == Prefs(theme="papertown-paper", ed_theme="nord", ed_icons="badges", focus=True)
    p.write_text(json.dumps({"theme": "neon", "ed_theme": "nope", "ed_icons": 3}))
    assert Prefs.load(p) == Prefs()


@pytest.fixture
def linked(tmp_path, monkeypatch):
    code, paper = tmp_path / "proj-code", tmp_path / "proj-paper"
    git_repo(code, {"README.md": "# Proj\n", "src/run.py": "def run():\n    return 1\n"})
    git_repo(paper, {"main.tex": "\\section{Intro}\nWe show $x^2$.\n", "refs.bib": "@article{a,\n  title = {T},\n}\n"})
    s = linked_settings(tmp_path, code, paper, lead_resident=False)
    with serving(s, monkeypatch) as url:
        yield url, code, s.data_dir


def test_tui_reads_edits_and_colours_a_projects_files(linked):
    url, code, data_dir = linked

    async def go():
        app = Papertown(Api(url), start_server=False, events=False)
        async with app.run_test(size=(170, 46)) as pilot:
            await until(pilot, lambda: isinstance(app.screen, Main) and any(ln.get("linked") for ln in app.lines))
            pj = app.current
            table = app.screen.query_one("#pj-table", DataTable)
            lid = next(ln["id"] for ln in app.lines if ln.get("linked"))
            await until(pilot, lambda: lid in [k.value for k in table.rows])
            table.focus()
            table.move_cursor(row=table.get_row_index(lid))
            await pilot.press("right_square_bracket", "right_square_bracket")
            ide = app.screen.query_one("#code", Ide)
            tree = ide.query_one(FileTree)
            await until(pilot, lambda: "src/run.py" in [k.value for k in tree.rows])
            assert [k.value for k in tree.rows] == ["d:src", "src/run.py", "README.md"]
            assert app.screen.query_one("#pj-left").has_class("slim")

            tree.focus()
            tree.move_cursor(row=0)
            await pilot.press("left")
            assert [k.value for k in tree.rows] == ["d:src", "README.md"]
            await pilot.press("right", "down", "enter")
            await until(pilot, lambda: ide.opened == "src/run.py" and ide.viewer.has_focus)

            await pilot.press("E")
            await until(pilot, lambda: isinstance(app.screen, Editor))
            ta = app.screen.query_one(EdTextArea)
            assert {name for line in ta._highlights.values() for _, _, name in line} >= {"kw", "fn"}
            ta.text = "def run():\n    return 2\n"
            await pilot.press("ctrl+s")
            await until(pilot, lambda: (code / "src/run.py").read_text() == "def run():\n    return 2\n")
            assert isinstance(app.screen, Editor)
            ta.insert("# not kept\n", (0, 0))
            await pilot.press("escape")
            await until(pilot, lambda: isinstance(app.screen, Confirm))
            await pilot.press("q")
            await pilot.pause(0.3)
            assert isinstance(app.screen, Confirm)
            await pilot.press("y")
            await until(pilot, lambda: isinstance(app.screen, Main))
            assert (code / "src/run.py").read_text() == "def run():\n    return 2\n"
            await until(pilot, lambda: "M" in str(tree.get_cell("src/run.py", "mark")))

            await pilot.press("T")
            await until(pilot, lambda: isinstance(app.screen, LookPicker))
            await pilot.press("down")
            await until(pilot, lambda: app.prefs.ed_theme != "paper")
            await pilot.press("escape")
            await until(pilot, lambda: isinstance(app.screen, Main) and app.prefs.ed_theme == "paper")
            await pilot.press("T", "down", "enter")
            await until(pilot, lambda: isinstance(app.screen, Main))
            chosen = app.prefs.ed_theme
            assert chosen != "paper" and ide.has_class(f"ed-{app.ed.key}")
            assert json.loads((data_dir / "tui.json").read_text())["ed_theme"] == chosen

            await pilot.press("z")
            assert not app.screen.query_one("#pj-left").display and app.prefs.focus
            await pilot.press("z")
            assert pj.query_one("#pj-left").display
            await pilot.press("q")

    asyncio.run(go())
