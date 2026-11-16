// Reads Paseo for the Papertown server through its SDK (@getpaseo/client); one command per run, JSON on stdout:
//
//   node link.mjs list                    agents on this machine (newest first)
//   node link.mjs timeline <id> [limit]   one agent's conversation, trimmed for the room
//
// PASEO_WS overrides the endpoint (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD sets
// the daemon password if it has one.

import { createPaseoClient } from "@getpaseo/client";

const [cmd, id, limit] = process.argv.slice(2);
const client = createPaseoClient({
  url: process.env.PASEO_WS || "ws://127.0.0.1:6767/ws",
  ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
});

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

function agentOf(a) {
  return {
    id: a.id, title: a.title ?? null, provider: a.provider, model: a.model ?? null, cwd: a.cwd,
    status: a.status, thinking: a.effectiveThinkingOptionId ?? null, mode: a.currentModeId ?? null,
    labels: a.labels ?? {}, created: a.createdAt, updated: a.updatedAt, last_user: a.lastUserMessageAt ?? null,
    archived: !!a.archivedAt, attention: !!a.requiresAttention,
    permissions: (a.pendingPermissions ?? []).map((p) => ({ id: p.id, name: p.name, title: p.title ?? null, arg: clip(String(toolArg(p.detail ?? p.input ?? {})), 300) })),
    usage: a.lastUsage ? { input: a.lastUsage.inputTokens ?? 0, output: a.lastUsage.outputTokens ?? 0, cost: a.lastUsage.totalCostUsd ?? 0 } : null,
  };
}

// what a tool call was about, in one short line
function toolArg(d = {}) {
  return d.command ?? d.filePath ?? d.query ?? d.url ?? (d.filePaths ?? []).join(", ");
}

// a timeline entry as the room shows it, or null for what stays in Paseo
function itemOf(e) {
  const it = e.item ?? {}, ts = e.timestamp;
  switch (it.type) {
    case "user_message": return { ts, kind: "user", text: it.text };
    case "assistant_message": return { ts, kind: "assistant", text: it.text };
    case "tool_call": return { ts, kind: "tool", id: it.callId, name: it.name, status: it.status, arg: clip(String(toolArg(it.detail)), 160), error: it.error ? clip(String(it.error.message ?? it.error), 300) : null };
    case "error": return { ts, kind: "error", text: it.message };
    case "notification": return it.level === "info" ? null : { ts, kind: "error", text: it.message };
    case "compaction": return it.status === "completed" ? { ts, kind: "note", text: "上下文已压缩" } : null;
    default: return null;
  }
}

try {
  await client.connect();
  if (cmd === "list") {
    const page = await client.agents.list({});
    const rows = page.entries.map((x) => agentOf(x.agent ?? x));
    rows.sort((a, b) => String(b.last_user ?? b.updated).localeCompare(String(a.last_user ?? a.updated)));
    console.log(JSON.stringify(rows));
  } else if (cmd === "timeline" && id) {
    const a = client.agents.ref(id);
    const page = await a.timeline.refetch({ direction: "tail", limit: Number(limit) || 200, projection: "projected" });
    await a.refresh();
    const cur = a.current();
    console.log(JSON.stringify({ agent: cur ? agentOf(cur) : null, items: (page.entries ?? []).map(itemOf).filter(Boolean) }));
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
