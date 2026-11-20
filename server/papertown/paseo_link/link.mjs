// Reads Paseo for the Papertown server through its SDK (@getpaseo/client); one command per run, JSON on stdout:
//
//   node link.mjs list                    agents on this machine (newest first)
//   node link.mjs timeline <id> [limit]   one agent's conversation, trimmed for the room
//
// PASEO_WS overrides the endpoint (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD sets
// the daemon password if it has one.

import { createPaseoClient } from "@getpaseo/client";
import { agentOf, itemOf, listAgents } from "./protocol.mjs";

const [cmd, id, limit] = process.argv.slice(2);
const client = createPaseoClient({
  url: process.env.PASEO_WS || "ws://127.0.0.1:6767/ws",
  ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
});


try {
  await client.connect();
  if (cmd === "list") {
    console.log(JSON.stringify(await listAgents(client)));
  } else if (cmd === "timeline" && id) {
    const a = client.agents.ref(id);
    const page = await a.timeline.refetch({ direction: "tail", limit: Number(limit) || 200, projection: "projected" });
    await a.refresh();
    const cur = a.current();
    if (!cur) throw new Error("Paseo agent no longer exists");
    console.log(JSON.stringify({ agent: agentOf(cur), items: page.entries.map(itemOf).filter(Boolean) }));
  } else {
    console.error("usage: node link.mjs list | timeline <id> [limit]");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e?.message ?? String(e));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
