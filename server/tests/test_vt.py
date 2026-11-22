"""The background terminals' screen: the escape sequences agent CLIs draw with, read back as text."""
from papertown.vt import Screen


def screen(data, cols=20, rows=5):
    replies = []
    s = Screen(cols, rows, reply=replies.append)
    s.feed(data.encode() if isinstance(data, str) else data)
    return s, replies


def rows(s):
    return s.text().split('\n')


def test_text_moves_and_erases():
    s, _ = screen('hello\r\nworld\x1b[1;3HX\x1b[2;1H\x1b[K\x1b[3;5Hend')
    assert rows(s)[:3] == ['heXlo', '', '    end']
    s.feed(b'\x1b[2J\x1b[H\x1b[5Ctop')
    assert rows(s)[0] == '     top' and s.text().strip() == 'top'


def test_wrapped_rows_join_like_capture_pane():
    s, _ = screen('a' * 25 + '\r\nnext', cols=10)
    assert rows(s)[:2] == ['a' * 25, 'next']


def test_wide_characters_take_two_cells():
    s, _ = screen('中文ab\x1b[1;3H字', cols=10)
    assert rows(s)[0] == '中字ab'
    s.feed('\x1b[2;10H中'.encode())  # no room in the last column: it wraps, and the two rows read as one
    assert rows(s)[1] == ' ' * 10 + '中'


def test_split_utf8_across_reads():
    s, _ = screen(b'\xe4\xb8')
    s.feed(b'\xad\xe2\x9d\xaf ok')
    assert rows(s)[0] == '中❯ ok'


def test_scroll_region_and_history():
    s, _ = screen('\r\n'.join(f'line{i}' for i in range(8)), rows=4)
    assert rows(s) == ['line4', 'line5', 'line6', 'line7']
    assert [h for h, _ in s.history] == ['line0', 'line1', 'line2', 'line3']
    # A region above an inline viewport, the way Codex inserts history over its composer.
    s.feed(b'\x1b[1;2r\x1b[2;1H\r\nnew\x1b[r')
    assert rows(s) == ['line5', 'new', 'line6', 'line7']


def test_insert_delete_lines_and_chars():
    s, _ = screen('one\r\ntwo\r\nthree\x1b[2;1H\x1b[L')
    assert rows(s)[:4] == ['one', '', 'two', 'three']
    s.feed(b'\x1b[1;1H\x1b[M\x1b[2;1H\x1b[2P')
    assert rows(s)[:3] == ['', 'o', 'three']
    s.feed(b'\x1b[3;1H\x1b[2@xy')
    assert rows(s)[2] == 'xythree'


def test_alternate_screen_restores_the_main_one():
    s, _ = screen('main\x1b[?1049h\x1b[Hfull screen')
    assert rows(s)[0] == 'full screen'
    s.feed(b'\x1b[?1049l')
    assert rows(s)[0] == 'main'


def test_answers_the_queries_a_cli_sends_at_start():
    s, replies = screen('ab\x1b[6n\x1b[c\x1b[>c\x1b[18t\x1b]11;?\x07\x1b[?u\x1b[?2004h\x1b[?2004$p')
    assert replies[0] == '\x1b[1;3R'
    assert replies[1] == '\x1b[?62;22c' and replies[2].startswith('\x1b[>')
    assert replies[3] == '\x1b[8;5;20t'
    assert replies[4].startswith('\x1b]11;rgb:')
    assert replies[5] == '\x1b[?2004;1$y'  # the keyboard-protocol query got no answer of its own
    assert 2004 in s.modes


def test_strings_and_styles_leave_no_trace():
    s, _ = screen('\x1b]0;title\x07\x1b[1;31mred\x1b[0m \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\x1bP+q544e\x1b\\ end')
    assert rows(s)[0] == 'red link end' and s.title == 'title'


def test_synchronized_output_reads_the_last_whole_frame():
    s, _ = screen('frame one')
    s.feed(b'\x1b[?2026h\x1b[2J\x1b[Hhalf')
    assert rows(s)[0] == 'frame one'
    s.feed(b' done\x1b[?2026l')
    assert rows(s)[0] == 'half done'
