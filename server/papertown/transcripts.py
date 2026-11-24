"""Request-local CLI transcripts. Only discovered paths are cached, never conversation text."""
from __future__ import annotations

import json
import os
import re
import shlex
import stat
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_BYTES = 4 * 1024 * 1024
SESSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{7,127}\Z')
MISSING = '尚未找到这段会话的记录。'
UNESTABLISHED = '会话尚未建立，稍后会显示对话。'
DISABLED = '对话记录读取已关闭。'
NO_TERMINAL = '这个终端会话没有可读取的对话记录。'
INTERRUPTED = '这一轮已被打断。'
# what Claude Code records as the user's turn but the user never typed: slash commands and their output, notices
HARNESS = re.compile(r'\s*<(?:command-(?:name|message|args)|local-command-\w+|task-notification|system-reminder|bash-(?:input|stdout|stderr))>')
_paths: dict[tuple[str, str], tuple[Path | None, float]] = {}


def cap(text, limit=20000):
    text = text.encode('utf-8', errors='replace').decode('utf-8')
    return text if len(text) <= limit else text[:limit - 1] + '…'


def argument(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return cap(' '.join(value.split()), 160)


def timestamp(value):
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
    raise ValueError('invalid timestamp')


def safe(path, home):
    try:
        relative = path.relative_to(home)
        current = home
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                return False
        return path.resolve().is_relative_to(home) and path.is_file()
    except (OSError, ValueError, RuntimeError):
        return False


def locate(home, provider, sid, started):
    if provider == 'claude':
        return next((p for p in (home / 'projects').glob(f'*/{sid}.jsonl') if safe(p, home)), None)
    if provider == 'antigravity':
        folder = home / 'brain' / sid / '.system_generated/logs'
        return next((p for name in ('transcript_full.jsonl', 'transcript.jsonl')
                     if safe(p := folder / name, home)), None)
    key = (str(home), sid)
    cached = _paths.get(key)
    if cached and (cached[0] is not None or time.monotonic() - cached[1] < 5):
        return cached[0]
    root = home / 'sessions'
    try:
        day = datetime.fromtimestamp(started) if isinstance(started, (float, int)) else datetime.fromisoformat(started.replace('Z', '+00:00'))
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        day = datetime.now()
    for offset in (0, -1, 1):
        folder = root / (day + timedelta(days=offset)).strftime('%Y/%m/%d')
        path = next((p for p in folder.glob(f'rollout-*-{sid}.jsonl') if safe(p, home)), None)
        if path:
            break
    else:
        path = next((p for p in root.glob(f'*/*/*/rollout-*-{sid}.jsonl') if safe(p, home)), None)
    if len(_paths) >= 1024:
        _paths.clear()
    _paths[key] = (path, time.monotonic())
    return path


def tail(path, home):
    # Open each component relative to its parent descriptor, refusing symlink races too.
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = path.relative_to(home).parts
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError('not regular')
        offset = max(0, info.st_size - MAX_BYTES)
        os.lseek(fd, offset, os.SEEK_SET)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(MAX_BYTES)
        if offset:
            data = data.partition(b'\n')[2]
        return data.splitlines()
    finally:
        os.close(fd)


def parse(lines, provider):
    items, tools, pending = [], {}, []

    def text(ts, kind, value):
        if isinstance(value, str) and value:
            items.append({'ts': ts, 'kind': kind, 'text': cap(value)})

    def tool(ts, id, name, arg, status='running', error=None):
        if not isinstance(id, str) or not isinstance(name, str):
            raise ValueError('invalid tool identity')
        row = {'ts': ts, 'kind': 'tool', 'id': cap(id), 'name': cap(name), 'arg': argument(arg), 'status': status, 'error': error}
        if id in tools:
            original = tools[id]
            row['ts'] = original['ts']
            original.update(row)
        else:
            tools[id] = row
            items.append(row)
        return tools[id]

    for raw in lines:
        try:
            r = json.loads(raw)
            if not isinstance(r, dict):
                continue
            ts = timestamp(r.get('timestamp') or r.get('created_at'))
            if provider == 'claude':
                if r.get('isSidechain') or r.get('isMeta'):
                    continue
                content = (r.get('message') or {}).get('content')
                if r.get('type') == 'user':
                    # a typed message is a string, or text blocks when something was attached to it
                    for block in [{'type': 'text', 'text': content}] if isinstance(content, str) else content if isinstance(content, list) else []:
                        if block.get('type') == 'tool_result' and block.get('tool_use_id') in tools:
                            failed = bool(block.get('is_error'))
                            tools[block['tool_use_id']].update(status='failed' if failed else 'completed', error='工具执行失败。' if failed else None)
                        elif block.get('type') == 'text' and isinstance(said := block.get('text'), str) and not HARNESS.match(said):
                            interrupted = said.startswith('[Request interrupted by user')
                            text(ts, 'note' if interrupted else 'user', INTERRUPTED if interrupted else said)
                elif r.get('type') == 'assistant' and isinstance(content, list):
                    for block in content:
                        if block.get('type') == 'text':
                            text(ts, 'assistant', block.get('text'))
                        elif block.get('type') == 'tool_use':
                            inp = block.get('input') or {}
                            arg = next((inp[k] for k in ('command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt') if k in inp), inp)
                            tool(ts, block['id'], block['name'], arg)
            elif provider == 'codex':
                if r.get('type') != 'event_msg':
                    continue
                payload = r['payload']
                event = payload.get('type')
                if event == 'turn_aborted':
                    text(ts, 'note', INTERRUPTED)
                elif event in ('item_started', 'item_completed'):
                    item = payload['item']
                    kind = item.get('type')
                    if event == 'item_completed' and kind in ('UserMessage', 'AgentMessage'):
                        content = '\n'.join(b['text'] for b in item.get('content', []) if b.get('type') == ('text' if kind == 'UserMessage' else 'Text') and isinstance(b.get('text'), str))
                        text(ts, 'user' if kind == 'UserMessage' else 'assistant', content)
                    elif kind == 'CommandExecution':
                        command = item.get('command')
                        arg = shlex.join(command) if isinstance(command, list) else command
                        if not arg:
                            arg = ' '.join(b['cmd'] for b in item.get('parsed_cmd', []) if isinstance(b.get('cmd'), str))
                        if not arg and item.get('id') in tools:
                            arg = tools[item['id']]['arg']
                        failed = item.get('exit_code') not in (None, 0) or item.get('status') == 'failed'
                        status = 'running' if event == 'item_started' else 'failed' if failed else 'completed'
                        tool(ts, item['id'], 'shell', arg, status, '命令执行失败。' if failed else None)
            else:
                kind = r.get('type')
                if kind == 'USER_INPUT' and r.get('source') == 'USER_EXPLICIT':
                    content = r.get('content')
                    if isinstance(content, str):
                        wrapped = re.search(r'<USER_REQUEST>\s*([\s\S]*?)\s*</USER_REQUEST>', content)
                        text(ts, 'user', wrapped[1] if wrapped else content)
                    pending = []
                elif kind == 'PLANNER_RESPONSE' and r.get('source') == 'MODEL':
                    text(ts, 'assistant', r.get('content'))
                    pending = []
                    for n, call in enumerate(r.get('tool_calls') or []):
                        args = call.get('args') or {}
                        arg = args.get('CommandLine') or args.get('Path') or next((v for v in args.values() if isinstance(v, str)), args)
                        pending.append(tool(ts, f"{r['step_index']}:{n}", call['name'], arg))
                elif kind == 'GENERIC' and r.get('source') == 'MODEL':
                    for row in pending:
                        row['status'] = 'running' if r.get('status') == 'RUNNING' else 'completed'
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
            continue
    # Stable sort preserves the order of blocks sharing a timestamp.
    return sorted(items, key=lambda row: datetime.fromisoformat(row['ts']).replace(tzinfo=timezone.utc)
                  if datetime.fromisoformat(row['ts']).tzinfo is None else datetime.fromisoformat(row['ts']))


def title(lines, provider, home, sid):
    """The conversation's title as the CLI named it: Claude Code's own or AI title, Codex's thread name."""
    found = None
    try:
        if provider == 'claude':
            named = {}
            for raw in lines:
                if b'-title"' in raw[:40]:
                    row = json.loads(raw)
                    if row.get('type') in ('custom-title', 'ai-title'):
                        named[row['type']] = row.get('customTitle') or row.get('aiTitle')
            found = named.get('custom-title') or named.get('ai-title')
        elif provider == 'codex':
            index = home / 'session_index.jsonl'
            if safe(index, home) and index.stat().st_size < MAX_BYTES:
                key = sid.encode()
                for raw in index.read_bytes().splitlines():
                    if key in raw:
                        row = json.loads(raw)
                        if row.get('id') == sid and row.get('thread_name'):
                            found = row['thread_name']
    except (OSError, ValueError, AttributeError):
        return None
    return cap(found.strip(), 200) if isinstance(found, str) and found.strip() else None


def read(settings, provider, session_id, limit=200, started=None, missing_session=UNESTABLISHED):
    def empty(note):
        return {'items': [], 'transcript': {'ok': False, 'note': note}}
    if not settings.transcripts:
        return empty(DISABLED)
    if not session_id:
        return empty(missing_session)
    if not isinstance(session_id, str) or not SESSION.fullmatch(session_id) or provider not in ('claude', 'codex', 'antigravity'):
        return empty(MISSING)
    try:
        home = Path(getattr(settings, provider + '_home')).expanduser().resolve()
        path = locate(home, provider, session_id, started)
        if not path or not safe(path, home):
            return empty(MISSING)
        lines = tail(path, home)
        items = parse(lines, provider)
        return {'items': items[-max(1, min(limit, 1000)):], 'transcript': {'ok': True, 'note': None, 'title': title(lines, provider, home, session_id)}}
    except (OSError, ValueError, RuntimeError):
        return empty(MISSING)
