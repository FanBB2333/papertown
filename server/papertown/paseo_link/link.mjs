// Reads Paseo for the Papertown server through its SDK (@getpaseo/client); one command per run, JSON on stdout:
//
//   node link.mjs list                    agents on this machine (newest first)
//   node link.mjs timeline <id> [limit]   one agent's conversation, trimmed for the room
//   node link.mjs watch                   live snapshots and activity as NDJSON
//   node link.mjs usage [--force]         subscription reports, bypassing cache when requested
//
// PASEO_WS overrides the endpoint (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD sets
// the daemon password if it has one.

import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { agentOf, doingOf, itemOf, listAgents } from "./protocol.mjs";
import { watchAgents } from "./watch.mjs";

const [cmd, id, limit] = process.argv.slice(2);
const daemon = new DaemonClient({
  clientId: `papertown-${process.pid}`, clientType: "cli",
  url: process.env.PASEO_WS || "ws://127.0.0.1:6767/ws",
  ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
  reconnect: { enabled: false },
});
const api = createPaseoApi(daemon);
const client = { ...api, connect: () => daemon.connect(), getConnectionState: () => daemon.getConnectionState(),
  ensureConnected: () => daemon.ensureConnected() };


try {
  await client.connect();
  if (cmd === "usage") {
    console.log(JSON.stringify((await daemon.listUsageReports({ forceRefresh: id === "--force" })).reports));
  } else if (cmd === "list") {
    console.log(JSON.stringify(await listAgents(client)));
  } else if (cmd === "timeline" && id) {
    const a = client.agents.ref(id);
    const page = await a.timeline.refetch({ direction: "tail", limit: Number(limit) || 200, projection: "projected" });
    await a.refresh();
    const cur = a.current();
    if (!cur) throw new Error("Paseo agent no longer exists");
    console.log(JSON.stringify({ agent: agentOf(cur), items: page.entries.map(itemOf).filter(Boolean), doing: doingOf(page.entries) }));
  } else if (cmd === "watch") {
    await watchAgents(client, line => console.log(JSON.stringify(line)));
  } else {
    console.error("usage: node link.mjs list | timeline <id> [limit] | watch | usage [--force]");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e?.message ?? String(e));
  process.exitCode = 1;
} finally {
  try { await api.dispose(); } finally { await daemon.close().catch(() => {}); }
}
