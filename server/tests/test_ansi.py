"""A terminal's colours read into styled lines that the web and the app draw alike."""
from papertown import ansi


def runs(text):
    r = ansi.render(text)
    return [[(t, r["styles"][s]) for t, s in line] for line in r["lines"]], r


def test_basic_and_bright_colours_bold_and_reset():
    lines, r = runs("\x1b[31mred\x1b[0m plain \x1b[1;92mok\x1b[m")
    assert lines == [[("red", {"fg": "#cd3131"}), (" plain ", {}), ("ok", {"fg": "#23d18b", "b": True})]]
    assert r["text"] == "red plain ok" and r["theme"] == ansi.THEME and r["styles"][0] == {}


def test_256_colours_and_true_colour_in_both_forms():
    lines, _ = runs("\x1b[38;5;196ma\x1b[48;5;244mb\x1b[0;38;2;1;2;3mc\x1b[38:2::16:32:48md")
    assert lines[0][0] == ("a", {"fg": "#ff0000"})
    assert lines[0][1] == ("b", {"fg": "#ff0000", "bg": "#808080"})
    assert lines[0][2] == ("c", {"fg": "#010203"}) and lines[0][3] == ("d", {"fg": "#102030"})


def test_reverse_dim_and_hidden_resolve_to_colours():
    lines, _ = runs("\x1b[7m sel \x1b[27;2mdim\x1b[22;8mx")
    assert lines[0][0] == (" sel ", {"fg": ansi.THEME["bg"], "bg": ansi.THEME["fg"]})
    assert lines[0][1][1]["fg"] not in (ansi.THEME["fg"], None)
    assert lines[0][2] == ("x", {"fg": ansi.THEME["bg"]})


def test_a_pen_carries_over_lines_and_other_escapes_leave_no_trace():
    lines, r = runs("\x1b[32mone\ntwo\x1b]0;title\x07\x1b[?25l\x1b[2K!\x1b[0m\r")
    assert lines == [[("one", {"fg": "#0dbc79"})], [("two!", {"fg": "#0dbc79"})]]
    assert r["text"] == "one\ntwo!"


def test_trailing_spaces_stay_only_when_they_paint():
    lines, r = runs("text   \n\x1b[48;5;236m      \x1b[0m   ")
    assert lines[0] == [("text", {})]
    assert lines[1] == [("      ", {"bg": "#303030"})] and r["text"] == "text\n"


def test_the_same_style_is_listed_once():
    r = ansi.render("\x1b[33ma\x1b[0m b \x1b[33mc")
    assert len(r["styles"]) == 2 and [s for _, s in r["lines"][0]] == [1, 0, 1]


def test_sgr_writes_back_what_apply_reads():
    for body in ("1;31", "2;4;7;38;5;100;48;2;9;8;7", "3;9;97;104"):
        pen = ansi.apply(None, body)
        assert ansi.apply(None, ansi.sgr(pen)[2:-1]) == pen
    assert ansi.apply(ansi.apply(None, "1;31"), "0") is None
