"""Visible terminal dialogs and optimistic, digest-checked keyboard answers."""
import hashlib
import json
import re

CURSOR = '❯›>▸●◉→'
BORDER = re.compile(r'^[\s\u2500-\u257f]+$')
SIDES = '│┃┆┇┊┋╎╏║'  # an empty row of a boxed dialog is a blank line, not a rule
FOOTER = re.compile(r'\b(?:enter|esc)\b|↑|↓', re.I)
HINT_START = re.compile(r'^(?:press\s+)?(?:enter\b|esc\b|↑|↓)', re.I)
OPTION = re.compile(r'^(\s*)([' + CURSOR + r']\s*)?(?:(\d+)[.)]\s+)?(\S.*)$')


class PromptError(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail
        super().__init__(detail)


def parse(text):
    lines = []
    for raw in text.splitlines():
        raw = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', raw).expandtabs(4)
        rule = bool(raw.strip() and BORDER.fullmatch(raw)) and any(c not in SIDES and not c.isspace() for c in raw)
        # Preserve label columns, including the cursor's two-column slot.
        raw = re.sub(r'^[ \t]*[\u2500-\u257f]+', '', raw)
        raw = re.sub(r'[\u2500-\u257f]+\s*$', '', raw).rstrip()
        lines.append((raw, rule))
    nonempty = [i for i, (line, rule) in enumerate(lines) if line.strip() or rule]
    if not nonempty:
        return None
    first = nonempty[-40] if len(nonempty) > 40 else 0

    def option(i):
        line, rule = lines[i]
        match = OPTION.fullmatch(line)
        if rule or not match:
            return None
        indent, cursor, number, label = match.groups()
        return {'label': label, 'cursor': bool(cursor), 'number': number,
                'column': len(indent) + len(cursor or '')}

    blocks = []
    i = first
    while i < len(lines):
        row = option(i)
        if row and row['number'] == '1':
            rows, end = [row], i + 1
            while end < len(lines):
                other = option(end)
                if not other or other['number'] != str(len(rows) + 1):
                    break
                rows.append(other)
                end += 1
            if len(rows) >= 2 and sum(r['cursor'] for r in rows) <= 1:
                blocks.append((i, end, rows))
            i = end
        else:
            i += 1
    for i in range(first, len(lines)):
        row = option(i)
        if not row or not row['cursor'] or row['number']:
            continue
        def plain(j):
            other = option(j)
            return (other if other and not other['cursor'] and not other['number']
                    and other['column'] == row['column'] and not HINT_START.search(other['label']) else None)
        start, end, rows = i, i + 1, [row]
        while start > first and (other := plain(start - 1)):
            rows.insert(0, other)
            start -= 1
        while end < len(lines) and (other := plain(end)):
            rows.append(other)
            end += 1
        if len(rows) >= 2:
            blocks.append((start, end, rows))
    blocks = [b for b in blocks if sum(bool(line.strip()) or rule for line, rule in lines[b[1]:]) <= 3
              and not any(line.strip() in CURSOR for line, _ in lines[b[1]:] if line.strip())]
    if not blocks:
        return None
    start, end, rows = max(blocks, key=lambda b: b[1])
    body, gaps = [], 0
    for line, rule in reversed(lines[first:start]):
        if rule:
            break
        if not line.strip():
            gaps += 1
            if gaps >= 2:
                break
            continue
        gaps = 0
        body.insert(0, line.strip())
        if len(body) == 12:
            break
    # the question being asked: a line that ends with one, else the first one inside a line
    title = next((line for line in reversed(body) if line.endswith(('?', '？'))), None)
    if title is None:
        title = next((m[0] for line in body if (m := re.match(r'.*?[?？]', line))), body[0] if body else '')
    title = title[:200]
    body = [line[:240] for line in body]
    cursor = next((n for n, row in enumerate(rows) if row['cursor']), 0)
    options = [{'index': n, 'label': row['label'], 'current': n == cursor, 'key': row['number']} for n, row in enumerate(rows)]
    following = next((line.strip() for line, _ in lines[end:] if line.strip()), '')
    digest = hashlib.sha256(json.dumps([title, body, [r['label'] for r in rows]], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:16]
    return {'digest': digest, 'title': title, 'body': body, 'options': options,
            'hint': following if FOOTER.search(following) else ''}


def answer(prompt, digest, option):
    if not prompt or prompt['digest'] != digest:
        raise PromptError(409, '终端画面已变化，请重新查看。')
    if isinstance(option, bool) or not isinstance(option, int) or not 0 <= option < len(prompt['options']):
        raise PromptError(400, '所选选项超出有效范围。')
    key = prompt['options'][option]['key']
    if key and len(key) == 1 and key in '123456789':
        return [key]
    current = next(i for i, row in enumerate(prompt['options']) if row['current'])
    return ['down' if option > current else 'up'] * abs(option - current) + ['enter']
