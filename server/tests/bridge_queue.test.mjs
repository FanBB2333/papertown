import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';

test('pi bridge holds, steers, retracts and releases follow-ups through fake inboxes', async () => {
  const saved = { fetch: globalThis.fetch, url: process.env.PAPERTOWN_URL, agent: process.env.PAPERTOWN_AGENT,
    role: process.env.PAPERTOWN_AGENT_ROLE };
  const handlers = new Map(), sent = [], events = [];
  let inbox, idle = false, aborted = false;
  const response = data => ({ ok: true, json: async () => data });
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith('http://fake.invalid/api/bridge/fake/'));
    if (url.includes('/inbox')) return new Promise(resolve => { inbox = messages => resolve(response({ messages })); });
    assert.ok(url.endsWith('/events'));
    events.push(...JSON.parse(options.body).events);
    return response({});
  };
  process.env.PAPERTOWN_URL = 'http://fake.invalid';
  process.env.PAPERTOWN_AGENT = 'fake';
  process.env.PAPERTOWN_AGENT_ROLE = 'writer';
  const pi = {
    on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerTool() {},
    getThinkingLevel: () => 'off', getSessionName: () => null, getCommands: () => [],
    sendUserMessage(text, options) { sent.push({ text, options }); idle = false; }
  };
  const context = { isIdle: () => idle, abort() { aborted = true; }, getContextUsage: () => null,
    sessionManager: { getSessionId: () => 'fake', getSessionFile: () => null }, modelRegistry: { getAvailable: () => [] } };
  async function deliver(messages) {
    assert.ok(inbox);
    inbox(messages);
    await tick();
  }
  try {
    // Only the schema builder needs a stub. The bridge and its queue run unchanged with a fake pi and HTTP transport.
    const source = stripTypeScriptTypes(await readFile(new URL('../papertown/pi/bridge.ts', import.meta.url), 'utf8'))
      .replace('import { Type } from "typebox";', 'const Type = new Proxy({}, { get: () => () => ({}) });');
    const { default: bridge } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    bridge(pi);
    await handlers.get('session_start')({}, context);
    await deliver([{ id: 1, text: 'Next', mode: 'queue' }, { id: 2, text: 'Retract', mode: 'queue' }]);
    assert.deepEqual(sent, []);
    assert.equal(events.filter(e => e.t === 'queued').length, 2);
    await deliver([{ id: 3, kind: 'queue_drop', mid: 2 }, { id: 4, kind: 'queue_now', mid: 1 }]);
    assert.deepEqual(sent, [{ text: 'Next', options: { deliverAs: 'steer' } }]);
    await deliver([{ id: 5, text: 'After turn', mode: 'queue' }]);
    idle = true;
    await handlers.get('agent_settled')({}, context);
    assert.deepEqual(sent.at(-1), { text: 'After turn', options: undefined });
    await deliver([{ id: 6, kind: 'abort' }, { id: 7, text: 'Replacement', mode: 'queue' }]);
    assert.ok(aborted);
    assert.equal(sent.length, 2);
    idle = true;
    await handlers.get('agent_settled')({ aborted: true }, context);
    assert.equal(sent.at(-1).text, 'Replacement');
    assert.ok(!sent.some(m => m.text === 'Retract'));
  } finally {
    await handlers.get('session_shutdown')?.();
    inbox?.([]);
    await tick();
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [['PAPERTOWN_URL', saved.url], ['PAPERTOWN_AGENT', saved.agent], ['PAPERTOWN_AGENT_ROLE', saved.role]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
