import { Activity, agentOf } from "./protocol.mjs";

// The caller owns the connection. Subscription failures end this watch so its parent can retry.
export async function watchAgents(client, emit, { beatMs = 15000, checkMs = 1000, throttleMs = 500, liveMs = 1000 } = {}) {
  const timelines = new Map(), snapshots = new Map(), subscriptions = [];
  let fail;
  const ended = new Promise((_, reject) => { fail = reject; });
  // Establishment can fail before the main wait starts.
  ended.catch(() => {});
  const beat = setInterval(() => {
    if (client.getConnectionState().status === "connected") emit({ t: "beat" });
  }, beatMs);
  const check = setInterval(() => {
    if (client.getConnectionState().status !== "connected") fail(new Error("Paseo connection lost"));
  }, checkMs);

  function remove(id) {
    snapshots.delete(id);
    const state = timelines.get(id);
    if (state) {
      timelines.delete(id);
      clearTimeout(state.timer);
      clearTimeout(state.liveTimer);
      state.unsubscribe?.();
    }
    emit({ t: "gone", id });
  }

  function changed(id, state, at) {
    state.pending = { t: "doing", id, doing: state.activity.current(), at };
    if (state.timer) return;
    const flush = () => {
      const wait = throttleMs - (performance.now() - state.lastAt);
      if (wait > 0) {
        state.timer = setTimeout(flush, Math.ceil(wait));
        return;
      }
      state.timer = null;
      const line = state.pending, value = JSON.stringify(line.doing);
      if (value === state.lastValue) return;
      state.lastValue = value;
      state.lastAt = performance.now();
      emit(line);
    };
    flush();
  }

  // Anything new in a followed conversation, at most once per liveMs: a page showing it reads it again.
  function touch(id, state) {
    if (state.liveTimer) return;
    const flush = () => {
      state.liveTimer = null;
      state.liveAt = performance.now();
      emit({ t: "live", id });
    };
    const wait = liveMs - (performance.now() - state.liveAt);
    if (wait > 0) state.liveTimer = setTimeout(flush, Math.ceil(wait));
    else flush();
  }

  async function follow(agent) {
    const id = agent.id, handle = client.agents.ref(id);
    const state = { activity: new Activity(), buffer: [], generation: 0, lastAt: -Infinity, liveAt: -Infinity, liveTimer: null };
    timelines.set(id, state);
    async function refresh() {
      const generation = ++state.generation;
      state.buffer = [];
      const page = await handle.timeline.refetch({ direction: "tail", limit: 200, projection: "projected" });
      if (timelines.get(id) !== state || generation !== state.generation) return;
      state.activity = new Activity();
      for (const entry of [...page.entries, ...state.buffer]) state.activity.add(entry);
      const at = state.buffer.at(-1)?.timestamp ?? page.entries.at(-1)?.timestamp ?? new Date().toISOString();
      state.buffer = null;
      changed(id, state, at);
    }
    state.unsubscribe = handle.timeline.subscribe(({ event, timestamp }) => {
      if (timelines.get(id) !== state) return;
      if (event.type === "error") fail(new Error(event.error));
      else if (event.type === "replacement" || event.type === "subscription_restored") {
        refresh().catch(fail);
      } else if (event.type === "timeline") {
        const entry = { item: event.item, timestamp };
        if (state.buffer) state.buffer.push(entry);
        else {
          state.activity.add(entry);
          changed(id, state, timestamp ?? new Date().toISOString());
          touch(id, state);
        }
      }
    });
    await state.unsubscribe.ready;
    if (timelines.get(id) === state) await refresh();
  }

  function upsert(agent) {
    if (agent.archivedAt) return remove(agent.id);
    const previous = snapshots.get(agent.id);
    // Initial pages can finish after a newer subscription event has already arrived.
    if (previous && Date.parse(previous.updatedAt) > Date.parse(agent.updatedAt)) return;
    snapshots.set(agent.id, agent);
    emit({ t: "agent", agent: agentOf(agent) });
    if (agent.labels?.papertown === "1") {
      if (!timelines.has(agent.id)) follow(agent).catch(fail);
    } else if (timelines.has(agent.id)) {
      remove(agent.id);
    }
  }

  const unsubscribe = client.agents.subscribe(update => {
    if (update.kind === "remove") remove(update.agentId);
    else upsert(update.agent);
  });
  try {
    let cursor;
    do {
      const page = await Promise.race([client.agents.list({ includeBackground: true, subscribe: {},
        page: { limit: 200, ...(cursor ? { cursor } : {}) } }), ended]);
      subscriptions.push(page.subscription);
      page.subscription.subscribe({ snapshot: () => {}, update: () => {}, error: fail });
      for (const entry of page.entries) upsert(entry.agent);
      cursor = page.pageInfo.nextCursor;
    } while (cursor);
    emit({ t: "ready" });
    await ended;
  } finally {
    clearInterval(beat);
    clearInterval(check);
    unsubscribe();
    for (const state of timelines.values()) {
      clearTimeout(state.timer);
      clearTimeout(state.liveTimer);
      state.unsubscribe?.();
    }
    timelines.clear();
    await Promise.allSettled(subscriptions.map(subscription => subscription.release()));
  }
}
