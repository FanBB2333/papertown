// Normalizes the pinned Paseo SDK contract for Papertown.
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

export function agentOf(a) {
  return {
    id: a.id, title: a.title ?? null, provider: a.provider, model: a.model ?? null, cwd: a.cwd,
    workspace_id: a.workspaceId ?? null, session_id: a.persistence?.sessionId ?? null,
    status: a.status, thinking: a.effectiveThinkingOptionId ?? null, mode: a.currentModeId ?? null,
    labels: a.labels ?? {}, created: a.createdAt, updated: a.updatedAt, last_user: a.lastUserMessageAt ?? null,
    archived: !!a.archivedAt, attention: !!a.requiresAttention,
    attention_reason: a.attentionReason ?? null, attention_at: a.attentionTimestamp ?? null,
    turn_started: a.activeTurn?.startedAt ?? null,
    permissions: (a.pendingPermissions ?? []).map((p) => ({ id: p.id, name: p.name, title: p.title ?? null, arg: clip(String(toolArg(p.detail ?? p.input ?? {})), 300), kind: p.kind ?? null })),
    usage: a.lastUsage ? { input: a.lastUsage.inputTokens ?? 0, output: a.lastUsage.outputTokens ?? 0, cost: a.lastUsage.totalCostUsd ?? 0 } : null,
  };
}

// what a tool call was about, in one short line
function toolArg(d = {}) {
  return d.command ?? d.filePath ?? d.query ?? d.url ?? d.text ?? (d.filePaths ?? []).join(", ");
}

// Keep only current tool calls and the last reply, so a long watch uses bounded history.
export class Activity {
  tools = new Map();
  say = null;
  open = null; // the reply still coming in: its message id, or true when the provider gives none

  add(entry) {
    const item = entry.item;
    if (item?.type === "tool_call") {
      this.open = null;
      this.tools.delete(item.callId);
      if (item.status === "running") this.tools.set(item.callId, item);
    } else if (item?.type === "user_message") {
      this.open = null;
    } else if (item?.type === "assistant_message") {
      // A live reply arrives as several items. Later ones continue it until a message or tool call comes between.
      const id = item.messageId ?? true;
      const text = this.say && this.open === id ? this.say.text + item.text : item.text;
      this.say = { kind: "say", text: [...text].slice(0, 200).join("") };
      this.open = id;
    }
  }

  current() {
    const tool = [...this.tools.values()].at(-1);
    return tool ? { kind: "tool", text: `${tool.name} ${String(toolArg(tool.detail))}`.trim() } : this.say;
  }
}

export function doingOf(entries) {
  const activity = new Activity();
  for (const entry of entries) activity.add(entry);
  return activity.current();
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
