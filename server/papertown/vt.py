"""A small terminal screen for Papertown's own background terminals.

Enough of xterm for the agent CLIs' inline and full-screen interfaces: cursor movement, erasing, insert and delete,
scroll regions, the alternate screen, wide characters, and answers to the queries a CLI sends while it starts (cursor
position, device attributes, window size, colours). Colours and text attributes are dropped: Papertown reads the
screen as text, the way `tmux capture-pane -p -J` prints it.
"""
from __future__ import annotations

import codecs
import time
import unicodedata
from collections import deque
from typing import Callable

INTERMEDIATE = ' !"#$%&\'()*+,-./'
TRACKED = {1, 6, 7, 25, 47, 1047, 1048, 1049, 2004}  # private modes a DECRQM query gets a real answer for


def width(ch: str) -> int:
    if unicodedata.combining(ch) or unicodedata.category(ch) in ('Mn', 'Me', 'Cf') or 0xFE00 <= ord(ch) <= 0xFE0F:
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


class Buffer:
    def __init__(self, cols: int, rows: int):
        self.lines = [[' '] * cols for _ in range(rows)]
        self.wrapped = [False] * rows  # the row continues on the next one (an automatic wrap, not a line break)


class Screen:
    def __init__(self, cols: int = 160, rows: int = 48, reply: Callable[[str], None] | None = None, history: int = 5000):
        self.cols, self.rows = cols, rows
        self.reply = reply or (lambda s: None)
        self.history: deque[tuple[str, bool]] = deque(maxlen=history)
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.reset()

    def reset(self) -> None:
        self.main = Buffer(self.cols, self.rows)
        self.buf = self.main
        self.x = self.y = 0
        self.wrapnext = False
        self.top, self.bottom = 0, self.rows - 1
        self.saved: tuple[int, int] | None = None
        self.modes = {7, 25}
        self.title = ''
        self.state, self.seq, self.last = 'ground', '', ''
        self.frozen: tuple[str, float] | None = None

    # input

    def feed(self, data: bytes) -> None:
        for ch in self.decoder.decode(data):
            self.char(ch)

    def char(self, ch: str) -> None:
        s = self.state
        if s == 'ground':
            if ch == '\x1b':
                self.state, self.seq = 'esc', ''
            elif ch < ' ' or ch == '\x7f':
                self.control(ch)
            elif not '\x80' <= ch < '\xa0':
                self.put(ch)
        elif s == 'esc':
            self.escape(ch)
        elif s == 'csi':
            if '@' <= ch <= '~':
                self.state = 'ground'
                self.csi(self.seq, ch)
            elif ch == '\x1b':
                self.state, self.seq = 'esc', ''
            elif ch < ' ':
                self.control(ch)
            elif len(self.seq) < 64:
                self.seq += ch
            else:
                self.state = 'ground'
        elif s in ('osc', 'str'):
            if ch == '\x07':
                self.end_string()
            elif ch == '\x1b':
                self.state = s + '-esc'
            elif len(self.seq) < 4096:
                self.seq += ch
        elif s in ('osc-esc', 'str-esc'):
            self.end_string()
            if ch != '\\':  # an escape that is not a string terminator ends the string and starts anew
                self.state, self.seq = 'esc', ''
                self.escape(ch)
        else:  # a character set designation: one more character
            self.state = 'ground'

    def end_string(self) -> None:
        osc, self.state = self.state.startswith('osc'), 'ground'
        if not osc:
            return
        code, _, value = self.seq.partition(';')
        if code in ('0', '2'):
            self.title = value[:200]
        elif code in ('10', '11', '12') and value == '?':
            rgb = 'ffff/ffff/ffff' if code == '11' else '0000/0000/0000'
            self.reply(f'\x1b]{code};rgb:{rgb}\x1b\\')

    def control(self, ch: str) -> None:
        if ch == '\r':
            self.x, self.wrapnext = 0, False
        elif ch in '\n\x0b\x0c':
            self.index()
        elif ch == '\b':
            self.x, self.wrapnext = max(0, self.x - 1), False
        elif ch == '\t':
            self.x, self.wrapnext = min(self.cols - 1, (self.x // 8 + 1) * 8), False

    def escape(self, ch: str) -> None:
        self.state = 'ground'
        if ch == '[':
            self.state, self.seq = 'csi', ''
        elif ch == ']':
            self.state, self.seq = 'osc', ''
        elif ch in 'P_^X':
            self.state, self.seq = 'str', ''
        elif ch in '()*+-./#% ':
            self.state = 'charset'
        elif ch == '7':
            self.save()
        elif ch == '8':
            self.restore()
        elif ch == 'D':
            self.index()
        elif ch == 'E':
            self.x = 0
            self.index()
        elif ch == 'M':
            self.reverse_index()
        elif ch == 'c':
            self.reset()
        elif ch == '\x1b':
            self.state = 'esc'

    # printing and moving

    def put(self, ch: str) -> None:
        w = width(ch)
        line = self.buf.lines[self.y]
        if w == 0:  # a combining mark or joiner belongs to the character before it
            x = self.x if self.wrapnext else self.x - 1
            if x >= 0:
                if line[x] == '' and x > 0:
                    x -= 1
                line[x] += ch
            return
        if self.wrapnext and 7 in self.modes:
            self.buf.wrapped[self.y] = True
            self.x = 0
            self.index()
            line = self.buf.lines[self.y]
        self.wrapnext = False
        if w == 2 and self.x == self.cols - 1:
            if 7 not in self.modes:
                return
            self.clear_cell(line, self.x)
            line[self.x] = ' '
            self.buf.wrapped[self.y] = True
            self.x = 0
            self.index()
            line = self.buf.lines[self.y]
        self.clear_cell(line, self.x)
        line[self.x] = ch
        if w == 2:
            self.clear_cell(line, self.x + 1)
            line[self.x + 1] = ''
        self.last = ch
        self.x += w
        if self.x >= self.cols:
            self.x, self.wrapnext = self.cols - 1, True

    def clear_cell(self, line: list[str], x: int) -> None:
        """Writing over half of a wide character blanks its other half."""
        if line[x] == '' and x > 0:
            line[x - 1] = ' '
        elif x + 1 < self.cols and line[x + 1] == '':
            line[x + 1] = ' '

    def index(self) -> None:
        self.wrapnext = False
        if self.y == self.bottom:
            self.scroll_up(1)
        elif self.y < self.rows - 1:
            self.y += 1

    def reverse_index(self) -> None:
        self.wrapnext = False
        if self.y == self.top:
            self.scroll_down(1)
        elif self.y > 0:
            self.y -= 1

    def scroll_up(self, n: int, top: int | None = None) -> None:
        t, b, buf = self.top if top is None else top, self.bottom, self.buf
        for _ in range(min(n, b - t + 1)):
            line, wrapped = buf.lines.pop(t), buf.wrapped.pop(t)
            if t == 0 and buf is self.main:
                self.history.append((''.join(line) if wrapped else ''.join(line).rstrip(), wrapped))
            buf.lines.insert(b, [' '] * self.cols)
            buf.wrapped.insert(b, False)

    def scroll_down(self, n: int, top: int | None = None) -> None:
        t, b, buf = self.top if top is None else top, self.bottom, self.buf
        for _ in range(min(n, b - t + 1)):
            buf.lines.pop(b)
            buf.wrapped.pop(b)
            buf.lines.insert(t, [' '] * self.cols)
            buf.wrapped.insert(t, False)

    def save(self) -> None:
        self.saved = (self.x, self.y)

    def restore(self) -> None:
        if self.saved:
            self.x, self.y = min(self.saved[0], self.cols - 1), min(self.saved[1], self.rows - 1)
        self.wrapnext = False

    def erase(self, y: int, start: int, end: int) -> None:
        line = self.buf.lines[y]
        if start > 0 and line[start] == '':
            line[start - 1] = ' '
        if end < self.cols and line[end] == '':
            line[end] = ' '
        line[start:end] = [' '] * (end - start)
        if end >= self.cols:
            self.buf.wrapped[y] = False

    # control sequences

    def csi(self, seq: str, final: str) -> None:
        prefix = seq[:1] if seq[:1] in '?><=' else ''
        body, inter = seq[len(prefix):], ''
        while body and body[-1] in INTERMEDIATE:
            inter, body = body[-1] + inter, body[:-1]
        try:
            params = [int(p) if p else 0 for p in body.replace(':', ';').split(';')] if body else []
        except ValueError:
            return
        arg = params[0] if params else 0
        n = arg or 1
        if prefix == '?':
            if final in 'hl' and not inter:
                for m in params:
                    self.mode(m, final == 'h')
            elif final == 'p' and inter == '$':
                self.reply(f'\x1b[?{arg};{(1 if arg in self.modes else 2) if arg in TRACKED else 0}$y')
            elif final == 'n' and arg == 6:
                self.reply(f'\x1b[?{self.y + 1};{self.x + 1}R')
            elif final in 'JK':
                self.csi(body, final)
            return
        if prefix == '>':
            if final == 'c':
                self.reply('\x1b[>1;10;0c')
            elif final == 'q':
                self.reply('\x1bP>|Papertown\x1b\\')
            return
        if prefix:  # '<' and '=': keyboard protocols this terminal does not speak, so they get no answer
            return
        if inter:
            if inter == '$' and final == 'p':
                self.reply(f'\x1b[{arg};0$y')
            elif inter == '!' and final == 'p':  # soft reset
                self.top, self.bottom, self.wrapnext = 0, self.rows - 1, False
                self.modes = (self.modes - {1, 6, 2004}) | {7, 25}
            return
        self.cursor_or_edit(final, params, arg, n)

    def cursor_or_edit(self, final: str, params: list[int], arg: int, n: int) -> None:
        f, rows, cols = final, self.rows, self.cols
        if f in 'ABCDEFGHf`ade':
            self.wrapnext = False
        if f == 'A' or f == 'F':
            self.y = max(self.top if self.y >= self.top else 0, self.y - n)
        elif f == 'B' or f == 'E' or f == 'e':
            self.y = min(self.bottom if self.y <= self.bottom else rows - 1, self.y + n)
        elif f == 'C' or f == 'a':
            self.x = min(cols - 1, self.x + n)
        elif f == 'D':
            self.x = max(0, self.x - n)
        elif f == 'G' or f == '`':
            self.x = min(cols - 1, n - 1)
        elif f == 'H' or f == 'f':
            origin = self.top if 6 in self.modes else 0
            self.y = min(rows - 1, origin + (params[0] if params and params[0] else 1) - 1)
            self.x = min(cols - 1, (params[1] if len(params) > 1 and params[1] else 1) - 1)
        elif f == 'd':
            self.y = min(rows - 1, n - 1)
        if f in 'EF':
            self.x = 0
        if f == 'J':
            if arg == 0:
                self.erase(self.y, self.x, cols)
                for y in range(self.y + 1, rows):
                    self.erase(y, 0, cols)
            elif arg == 1:
                for y in range(self.y):
                    self.erase(y, 0, cols)
                self.erase(self.y, 0, self.x + 1)
            elif arg == 2:
                for y in range(rows):
                    self.erase(y, 0, cols)
            elif arg == 3:
                self.history.clear()
        elif f == 'K':
            start, end = {0: (self.x, cols), 1: (0, self.x + 1)}.get(arg, (0, cols))
            self.erase(self.y, start, end)
        elif f == 'X':
            self.erase(self.y, self.x, min(cols, self.x + n))
        elif f == 'P':
            line = self.buf.lines[self.y]
            n = min(n, cols - self.x)
            self.erase(self.y, self.x, self.x + n)
            del line[self.x:self.x + n]
            line.extend([' '] * n)
        elif f == '@':
            line = self.buf.lines[self.y]
            n = min(n, cols - self.x)
            if line[self.x] == '' and self.x > 0:
                line[self.x - 1] = ' '
            line[self.x:self.x] = [' '] * n
            del line[cols:]
            if width(line[-1][:1] or ' ') == 2:  # its right half was pushed off the row
                line[-1] = ' '
        elif f == 'L' or f == 'M':
            if self.top <= self.y <= self.bottom:
                (self.scroll_down if f == 'L' else self.scroll_up)(n, top=self.y)
                self.x, self.wrapnext = 0, False
        elif f == 'S':
            self.scroll_up(n)
        elif f == 'T' and len(params) <= 1:
            self.scroll_down(n)
        elif f == 'r':
            top = (params[0] if params and params[0] else 1) - 1
            bottom = (params[1] if len(params) > 1 and params[1] else rows) - 1
            if top < bottom < rows:
                self.top, self.bottom = top, bottom
                self.x, self.y, self.wrapnext = 0, top if 6 in self.modes else 0, False
        elif f == 's' and not params:
            self.save()
        elif f == 'u' and not params:
            self.restore()
        elif f == 'n':
            if arg == 6:
                origin = self.top if 6 in self.modes else 0
                self.reply(f'\x1b[{self.y - origin + 1};{self.x + 1}R')
            elif arg == 5:
                self.reply('\x1b[0n')
        elif f == 'c' and arg == 0:
            self.reply('\x1b[?62;22c')
        elif f == 't':
            answer = {18: f'8;{rows};{cols}', 19: f'9;{rows};{cols}', 14: f'4;{rows * 20};{cols * 10}', 16: '6;20;10'}.get(arg)
            if answer:
                self.reply(f'\x1b[{answer}t')
        elif f == 'b' and self.last:
            for _ in range(min(n, rows * cols)):
                self.put(self.last)
        elif f == 'I':
            self.x = min(cols - 1, (self.x // 8 + n) * 8)
        elif f == 'Z':
            self.x = max(0, ((self.x - 1) // 8 - n + 1) * 8)

    def mode(self, m: int, on: bool) -> None:
        if m in (47, 1047, 1049):
            if on and self.buf is self.main:
                if m == 1049:
                    self.save()
                self.buf = Buffer(self.cols, self.rows)
            elif not on and self.buf is not self.main:
                self.buf = self.main
                if m == 1049:
                    self.restore()
        elif m == 1048:
            (self.save if on else self.restore)()
        elif m == 2026:  # synchronized output: a read in the middle of a frame sees the frame before it
            self.frozen = (self.text(), time.monotonic()) if on else None
        if on:
            self.modes.add(m)
        else:
            self.modes.discard(m)

    # output

    def text(self) -> str:
        """The visible screen, rows joined where they only wrapped, trailing spaces dropped."""
        if self.frozen and time.monotonic() - self.frozen[1] < 1:
            return self.frozen[0]
        out, cur = [], ''
        for cells, wrapped in zip(self.buf.lines, self.buf.wrapped):
            row = ''.join(cells)
            if wrapped:
                cur += row
            else:
                out.append((cur + row).rstrip())
                cur = ''
        if cur:
            out.append(cur.rstrip())
        return '\n'.join(out)
