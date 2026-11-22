#!/usr/bin/env python3
"""Offline interactive CLI for isolated terminal tests. No model/config access."""
import json
import os
import re
from pathlib import Path
import select
import subprocess
import sys
import termios
import time
import tty

args = sys.argv[1:]
provider = os.environ.get('PT_FAKE_PROVIDER', 'claude')
intro = next((x for x in args if 'intro.md' in x), '')
home = Path(re.search(r'(/\S+?)/\.papertown/intro\.md', intro).group(1))
pt = home / '.papertown/pt'
(home / '.papertown/argv.json').write_text(json.dumps(args))
sid = 'fake-session'
for option in ('--session-id', '--resume', 'resume', '--conversation'):
    if option in args:
        sid = args[args.index(option) + 1]

def hook(event):
    body = {'hook_event_name': event, 'session_id': sid, 'tool_name': 'Bash' if event == 'PreToolUse' else '',
            'prompt': 'SECRET PROMPT', 'tool_input': {'command': 'SECRET INPUT'}}
    subprocess.run([str(pt), 'hook', 'claude'], input=json.dumps(body), text=True, timeout=3)

def out(text):
    print(text, end='\r\n', flush=True)

before = termios.tcgetattr(sys.stdin)
tty.setraw(sys.stdin.fileno())
try:
    # Enable bracketed paste so a multiline send is still a single submission.
    print('\x1b[?2004h', end='', flush=True)
    hook('SessionStart')
    out('⏺ ready ' + sid)
    # Like the real CLIs, the first message given on the command line is the first turn.
    hook('UserPromptSubmit'); out('⏺ first reply'); hook('Stop')
    buffer, pending, paste, busy, frozen = '', '', False, False, False
    tick, end, counter = time.monotonic(), 0, 0
    while True:
        if busy and not frozen and time.monotonic() - tick >= .08:
            tick = time.monotonic(); counter += 1
            out('working timer ' + str(counter))
        if busy and not frozen and time.monotonic() > end:
            busy = False; hook('Stop'); out('⏺ done')
        if not select.select([sys.stdin], [], [], .02)[0]:
            continue
        c = os.read(sys.stdin.fileno(), 4096).decode()
        pending += c
        while pending:
            if pending.startswith('\x1b[200~'):
                paste = True; pending = pending[6:]; continue
            if pending.startswith('\x1b[201~'):
                paste = False; pending = pending[6:]; continue
            if pending.startswith('\x1b') and len(pending) > 1 and '\x1b[200~'.startswith(pending):
                break
            c, pending = pending[0], pending[1:]
            if c == '\x1b' and not paste:
                if buffer == 'ignore':
                    continue
                busy = frozen = False; hook('Stop'); out('⏺ stopped'); continue
            if c in ('\r', '\n') and not paste:
                text, buffer = buffer, ''
                if not text:
                    continue
                out('input: ' + text)
                if text == 'exit':
                    sys.exit(0)
                hook('UserPromptSubmit')
                if text in ('work', 'dialog', 'ignore'):
                    hook('PreToolUse'); busy = True; frozen = text == 'dialog'; end = time.monotonic() + 2
                    if text == 'ignore':
                        buffer = 'ignore'; end += 60
                    out('dialog waiting' if frozen else 'working')
                else:
                    hook('Stop'); out('⏺ reply ' + text.replace('\n', '|'))
            else:
                buffer += c
finally:
    termios.tcsetattr(sys.stdin, termios.TCSADRAIN, before)
