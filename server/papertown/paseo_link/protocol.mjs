// Normalizes the pinned Paseo SDK contract for Papertown.
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

export function agentOf(a) {
  return {
    id: a.id, title: a.title ?? null, provider: a.provider, model: a.model ?? null, cwd: a.cwd,
    workspace_id: a.workspaceId ?? null,
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
export function itemOf(e) {
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


export async function listAgents(client) {
  const rows = [];
  let cursor;
  do {
    const page = await client.agents.list({ includeBackground: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    rows.push(...page.entries.map(entry => agentOf(entry.agent)));
    cursor = page.pageInfo.nextCursor;
  } while (cursor);
  return rows.filter(a => !a.archived).sort((a, b) => String(b.last_user ?? b.updated).localeCompare(String(a.last_user ?? a.updated)));
}
