import assert from 'node:assert/strict';
import test from 'node:test';
import { Activity, agentOf, doingOf, itemOf, listAgents } from './protocol.mjs';
import { watchAgents } from './watch.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

test('lists every page, including background workspaces, without importing archives', async () => {
  const calls = [];
  const client = { agents: { async list(options) {
    calls.push(options);
    return options.page.cursor
      ? { entries: [{ agent: { id: 'second', workspaceId: 'w2', updatedAt: '2026-02' } }], pageInfo: { nextCursor: null } }
      : { entries: [{ agent: { id: 'first', workspaceId: 'w1', updatedAt: '2026-01' } },
          { agent: { id: 'archived', archivedAt: '2026-03' } }], pageInfo: { nextCursor: 'page2' } };
  } } };
  const rows = await listAgents(client);
  assert.deepEqual(rows.map(a => a.id), ['second', 'first']);
  assert.equal(rows[0].workspace_id, 'w2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includeBackground, true);
});

test('preserves native permission IDs, tools, errors and conversation text', () => {
  const a = agentOf({ id: 'a', status: 'permission', workspaceId: 'w', pendingPermissions: [
    { id: 'permission-1', name: 'Bash', input: { command: 'echo test' } }
  ] });
  assert.equal(a.permissions[0].id, 'permission-1');
  assert.equal(a.permissions[0].arg, 'echo test');
  assert.equal(itemOf({ timestamp: 'now', item: { type: 'assistant_message', text: '原样保留' } }).text, '原样保留');
  assert.equal(itemOf({ item: { type: 'tool_call', callId: 'call1', name: 'shell', status: 'failed', error: { message: 'oops' } } }).error, 'oops');
  assert.equal(itemOf({ item: { type: 'notification', level: 'info' } }), null);
});

test('preserves SDK 0.13.2 attention, active turn and permission kinds', () => {
  const a = agentOf({ id: 'a', status: 'running', requiresAttention: true, attentionReason: 'finished',
    attentionTimestamp: '2026-11-21T01:00:00Z', activeTurn: { turnId: 'turn', startedAt: '2026-11-21T00:00:00Z' },
    pendingPermissions: [{ id: 'q', name: 'question', kind: 'question' }, { id: 'p', name: 'plan', kind: 'plan' }] });
  assert.equal(a.attention, true);
  assert.equal(a.attention_reason, 'finished');
  assert.equal(a.attention_at, '2026-11-21T01:00:00Z');
  assert.equal(a.turn_started, '2026-11-21T00:00:00Z');
  assert.deepEqual(a.permissions.map(p => p.kind), ['question', 'plan']);
  assert.equal(agentOf({}).attention_at, null);
  assert.equal(agentOf({ activeTurn: { turnId: 't', startedAt: null } }).turn_started, null);
});

test('history and live activity agree across tool updates and clipped replies', () => {
  const tool = (id, status) => ({ item: { type: 'tool_call', callId: id, name: 'Bash', detail: { command: id }, status } });
  const entries = [{ item: { type: 'assistant_message', text: 'x'.repeat(250) } }, tool('first', 'running'), tool('second', 'running')];
  const activity = new Activity();
  for (const entry of entries) activity.add(entry);
  assert.deepEqual(activity.current(), doingOf(entries));
  assert.deepEqual(activity.current(), { kind: 'tool', text: 'Bash second' });
  activity.add(tool('second', 'completed'));
  assert.equal(activity.current().text, 'Bash first');
  activity.add(tool('first', 'failed'));
  assert.deepEqual(activity.current(), { kind: 'say', text: 'x'.repeat(200) });
  assert.equal(doingOf([]), null);
});

test('a reply that streams in as several items reads as one message', () => {
  const say = (text, messageId) => ({ item: { type: 'assistant_message', text, ...(messageId ? { messageId } : {}) } });
  const activity = new Activity();
  for (const entry of [say('A_DONE STEER'), say('_B7DE15'), { item: { type: 'reasoning', text: 'thinking' } }, say('\n')]) activity.add(entry);
  assert.equal(activity.current().text, 'A_DONE STEER_B7DE15\n');
  activity.add({ item: { type: 'user_message', text: 'next' } });
  activity.add(say('B_DONE'));
  assert.equal(activity.current().text, 'B_DONE');
  activity.add(say('one', 'm1')); activity.add(say(' two', 'm1')); activity.add(say('three', 'm2'));
  assert.equal(activity.current().text, 'three');
  activity.add(say('x'.repeat(300)));
  assert.equal(activity.current().text.length, 200);
});

test('watch uses one client, subscribes owned timelines, throttles and exits on disconnect', async () => {
  const lines = [], handlers = new Map(), released = [], timelineIds = [];
  let update, connection = 'connected', ready;
  const started = new Promise(resolve => { ready = resolve; });
  const client = {
    getConnectionState: () => ({ status: connection }),
    agents: {
      subscribe(handler) { update = handler; return () => released.push('updates'); },
      async list(options) {
        assert.deepEqual(options.subscribe, {});
        return { entries: [{ agent: { id: 'owned', labels: { papertown: '1' } } }, { agent: { id: 'other' } }],
          pageInfo: { nextCursor: null }, subscription: { subscribe() {}, async release() { released.push('list'); } } };
      },
      ref(id) {
        return { timeline: {
          subscribe(handler) {
            timelineIds.push(id);
            handlers.set(id, handler);
            return Object.assign(() => released.push(id), { ready: Promise.resolve() });
          },
          async refetch() { return { entries: [{ timestamp: 'history', item: { type: 'assistant_message', text: 'Ready' } }] }; }
        } };
      }
    }
  };
  const watching = watchAgents(client, line => {
    lines.push({ ...line, emitted: performance.now() });
    if (line.t === 'ready') ready();
  }, { beatMs: 10, checkMs: 5 });
  const stopped = assert.rejects(watching, /connection lost/);
  try {
    await started;
    await sleep(10);
    assert.deepEqual(timelineIds, ['owned']);
    const tool = command => ({ timestamp: command, event: { type: 'timeline', item: {
      type: 'tool_call', callId: 'call', name: 'Bash', detail: { command }, status: 'running' } } });
    handlers.get('owned')(tool('first'));
    handlers.get('owned')(tool('latest'));
    assert.equal(lines.filter(l => l.t === 'doing').length, 1);
    assert.equal(lines.filter(l => l.t === 'live').length, 1);
    await sleep(530);
    const activity = lines.filter(l => l.t === 'doing');
    assert.equal(activity.length, 2);
    assert.equal(activity[1].doing.text, 'Bash latest');
    assert.ok(activity[1].emitted - activity[0].emitted >= 490);
    assert.ok(lines.some(l => l.t === 'beat'));
    update({ kind: 'upsert', agent: { id: 'owned', status: 'idle', labels: { papertown: '1' } } });
    assert.equal(lines.at(-1).agent.status, 'idle');
    update({ kind: 'remove', agentId: 'owned' });
    assert.equal(lines.at(-1).t, 'gone');
  } finally {
    connection = 'disconnected';
    await stopped;
  }
  assert.deepEqual(released.sort(), ['list', 'owned', 'updates']);
});
