import assert from 'node:assert/strict';
import test from 'node:test';
import { agentOf, itemOf, listAgents } from './protocol.mjs';

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
