/**
 * Papertown bridge: mirrors this pi session into the Papertown web app and lets the app
 * talk to it. The server starts pi inside a tmux session with `pi -e bridge.ts`, so the
 * same conversation can be followed in the terminal (`tmux -L papertown attach`) and in
 * the browser at the same time.
 *
 * Built only on pi's public extension API, the way the examples shipped with pi do it
 * (examples/extensions/file-trigger.ts and send-user-message.ts):
 *   - pi.on(...) events are batched and posted to the server
 *   - messages typed in the app are long-polled from the server and injected with
 *     pi.sendUserMessage(), as a follow-up while pi is busy
 *   - pi.registerTool() adds the Papertown tools (project brief; job submission for coders;
 *     for the console's assistant: the page you look at, reading, asking, showing and doing)
 *   - the model, thinking level, session and context usage are reported as `state`, and
 *     slash commands typed in the app arrive as `cmd`: the ones pi's extension API can do
 *     (model, thinking, compact, new, clone, name, session, reload) run here; extension
 *     commands, skills and prompt templates go through pi's own expansion. The rest of
 *     pi's built-in commands need its terminal UI, so the server types them into tmux.
 *
 * Environment (set by the server): PAPERTOWN_URL, PAPERTOWN_AGENT, PAPERTOWN_AGENT_TOKEN,
 * PAPERTOWN_AGENT_ROLE. Without them the extension does nothing.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SERVER = process.env.PAPERTOWN_URL ?? "";
const AGENT = process.env.PAPERTOWN_AGENT ?? "";
const TOKEN = process.env.PAPERTOWN_AGENT_TOKEN ?? "";
const ROLE = process.env.PAPERTOWN_AGENT_ROLE ?? "";

type Ev = Record<string, unknown> & { t: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("");
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

// the thinking levels a model takes, as pi-ai's getSupportedThinkingLevels() decides them
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function levelsOf(m: any): string[] {
	if (!m?.reasoning) return ["off"];
	return LEVELS.filter((l) => {
		const mapped = m.thinkingLevelMap?.[l];
		if (mapped === null) return false;
		return l === "xhigh" || l === "max" ? mapped !== undefined : true;
	});
}

const modelRef = (m: any) => (m ? { provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: !!m.reasoning, contextWindow: m.contextWindow ?? null } : null);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export default function papertownBridge(pi: ExtensionAPI) {
	if (!SERVER || !AGENT) return;
	const base = `${SERVER}/api/bridge/${AGENT}`;
	const headers = { "content-type": "application/json", "x-papertown-token": TOKEN };

	let ctx: ExtensionContext | undefined;
	let queue: Ev[] = [];
	let flushing = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let delta = "";
	let deltaTimer: ReturnType<typeof setTimeout> | undefined;
	let polling = false;
	let stopped = false;

	async function call(path: string, init: RequestInit = {}, timeout = 8000): Promise<any> {
		const r = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(timeout) });
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body?.detail ?? `Papertown ${r.status}`);
		return body;
	}

	function send(ev: Ev) {
		queue.push(ev);
		void flush();
	}

	async function flush() {
		if (flushing || !queue.length) return;
		flushing = true;
		const batch = queue;
		queue = [];
		try {
			await call("/events", { method: "POST", body: JSON.stringify({ events: batch }) });
		} catch {
			// server away: keep the newest events and try again shortly
			queue = batch.concat(queue).slice(-400);
			clearTimeout(retry);
			retry = setTimeout(() => {
				retry = undefined;
				void flush();
			}, 2000);
		} finally {
			flushing = false;
		}
		if (queue.length && !retry) void flush();
	}

	function flushDelta() {
		clearTimeout(deltaTimer);
		deltaTimer = undefined;
		if (delta) send({ t: "delta", text: delta });
		delta = "";
	}

	function hello() {
		send({
			t: "hello",
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			cwd: ctx?.cwd ?? process.cwd(),
			session: ctx?.sessionManager.getSessionFile() ?? null,
			idle: ctx?.isIdle() ?? true,
		});
		state(true);
	}

	// what the app shows next to the chat; `full` adds the model list and the commands
	function state(full = false) {
		if (!ctx) return;
		const sm = ctx.sessionManager;
		const ev: Ev = {
			t: "state",
			model: modelRef(ctx.model),
			thinking: pi.getThinkingLevel(),
			levels: levelsOf(ctx.model),
			session: { id: sm.getSessionId(), name: pi.getSessionName() ?? null, file: sm.getSessionFile() ?? null },
			context: ctx.getContextUsage() ?? null,
		};
		if (full) {
			const reg = ctx.modelRegistry;
			const models = reg.getAvailable().map(modelRef);
			ev.models = models;
			ev.providers = Object.fromEntries([...new Set(models.map((m: any) => m.provider))].map((p) => [p, reg.getProviderDisplayName(p)]));
			ev.commands = pi.getCommands().map((c) => ({ name: c.name, description: c.description ?? "", source: c.source }));
		}
		send(ev);
	}

	function note(text: string, error = false) {
		send({ t: "note", text, error });
	}

	function findModel(arg: string) {
		const all = ctx?.modelRegistry.getAvailable() ?? [];
		const want = arg.trim().toLowerCase();
		const [p, id] = want.includes("/") ? [want.slice(0, want.indexOf("/")), want.slice(want.indexOf("/") + 1)] : ["", want];
		return (
			all.find((m) => m.provider.toLowerCase() === p && m.id.toLowerCase() === id) ??
			all.find((m) => !p && m.id.toLowerCase() === id) ??
			all.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(want) || (m.name ?? "").toLowerCase().includes(want))
		);
	}

	function stats() {
		const sm = ctx!.sessionManager;
		let user = 0, assistant = 0, tools = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
		for (const e of sm.getEntries() as any[]) {
			const m = e.type === "message" ? e.message : null;
			if (!m) continue;
			if (m.role === "user") user++;
			if (m.role === "toolResult") tools++;
			if (m.role !== "assistant") continue;
			assistant++;
			const u = m.usage ?? {};
			input += u.input ?? 0; output += u.output ?? 0; cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
		}
		const c = ctx!.getContextUsage();
		return [
			`会话 ${pi.getSessionName() ?? sm.getSessionId()}`,
			`消息：你 ${user} 条，pi ${assistant} 条，工具结果 ${tools} 条`,
			`token：输入 ${fmt(input)}，输出 ${fmt(output)}，缓存读 ${fmt(cacheRead)}，缓存写 ${fmt(cacheWrite)}`,
			`花费 $${cost.toFixed(4)}`,
			c ? `上下文 ${c.tokens == null ? "?" : fmt(c.tokens)} / ${fmt(c.contextWindow)}${c.percent == null ? "" : `（${c.percent.toFixed(0)}%）`}` : "",
			`文件 ${sm.getSessionFile() ?? "（未保存）"}`,
		].filter(Boolean).join("\n");
	}

	// slash commands from the app
	async function command(name: string, args: string) {
		if (!ctx) return;
		switch (name) {
			case "model": {
				if (!args) return state(true);
				const m = findModel(args);
				if (!m) return note(`没有找到可用的模型「${args}」。没登录的供应商要先在终端里 /login。`, true);
				if (!(await pi.setModel(m))) return note(`${m.provider} 还没有配置登录或 key，先在终端里 /login。`, true);
				return; // model_select reports it
			}
			case "thinking": {
				if (!args) return note(`思考强度：${pi.getThinkingLevel()}（可选 ${levelsOf(ctx.model).join(" / ")}）`);
				if (!LEVELS.includes(args as any)) return note(`没有这个思考强度：${args}`, true);
				pi.setThinkingLevel(args as any);
				return state();
			}
			case "compact":
				note("正在压缩上下文…");
				return ctx.compact({
					customInstructions: args || undefined,
					onComplete: (r: any) => { note(`上下文已压缩${r?.tokensBefore ? `（压缩前 ${fmt(r.tokensBefore)} token）` : ""}。`); state(); },
					onError: (e) => note(`压缩失败：${e.message}`, true),
				});
			case "name":
				if (!args) return note(`会话名：${pi.getSessionName() ?? "（未命名）"}`);
				pi.setSessionName(args);
				return state();
			case "session":
				return note(stats());
			case "new":
			case "clone":
			case "reload":
				// these replace or reload the session, which pi only allows from a command
				return void pi.sendUserMessage(`/papertown ${name}`, { expandPromptTemplates: true });
			default:
				// extension commands, /skill:name and prompt templates, expanded by pi itself
				return void pi.sendUserMessage(`/${name}${args ? ` ${args}` : ""}`, ctx.isIdle()
					? { expandPromptTemplates: true }
					: { expandPromptTemplates: true, deliverAs: "followUp" });
		}
	}

	pi.registerCommand("papertown", {
		description: "Papertown bridge: new | clone | reload (used by the web app)",
		handler: async (args: string, c: ExtensionCommandContext) => {
			const op = args.trim();
			if (!c.isIdle()) {
				c.abort();
				await c.waitForIdle();
			}
			if (op === "new") {
				note("开始新会话。");
				await c.newSession();
			} else if (op === "clone") {
				const leaf = c.sessionManager.getLeafId();
				if (!leaf) return note("会话还是空的，没有可复制的。", true);
				note("复制当前会话，在副本里继续。");
				await c.fork(leaf, { position: "at" });
			} else if (op === "reload") {
				await c.reload();
				note("已重新加载扩展、skills、提示模板和上下文文件。");
				state(true);
			}
		},
	});

	function deliver(m: { id: number; kind?: string; text?: string; name?: string; args?: string; mode?: string | null }) {
		if (m.kind === "abort") {
			ctx?.abort();
			send({ t: "delivered", ids: [m.id] });
			return;
		}
		if (m.kind === "cmd") {
			send({ t: "delivered", ids: [m.id] });
			command(m.name ?? "", (m.args ?? "").trim()).catch((e) => note(`/${m.name} 出错：${e?.message ?? e}`, true));
			return;
		}
		if (!m.text) return;
		// while pi works a message either steers what it is doing or waits until it is done
		const idle = ctx?.isIdle() ?? true;
		const steer = m.mode === "steer";
		void pi.sendUserMessage(m.text, idle ? undefined : { deliverAs: steer ? "steer" : "followUp" });
		send({ t: "delivered", ids: [m.id], queued: !idle && !steer, steered: !idle && steer });
	}

	async function poll() {
		if (polling) return;
		polling = true;
		let online = false;
		while (!stopped) {
			try {
				const { messages } = await call("/inbox?wait=20", {}, 30000);
				if (stopped) break; // the session was replaced while this poll was out
				if (!online) {
					online = true;
					hello(); // also after the server restarts
				}
				for (const m of messages ?? []) deliver(m);
			} catch {
				online = false;
				await sleep(2000);
			}
		}
	}

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		hello();
		void poll();
	});

	pi.on("input", async (e, c) => {
		ctx = c;
		// messages from the app come back through here as "extension"; they are already shown
		if (e.source !== "extension") send({ t: "input", text: e.text, source: e.source });
		return { action: "continue" };
	});

	pi.on("agent_start", async (_e, c) => {
		ctx = c;
		send({ t: "start" });
	});

	pi.on("message_update", async (e) => {
		const a: any = e.assistantMessageEvent;
		if (a?.type !== "text_delta") return;
		delta += a.delta;
		if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 120);
	});

	pi.on("message_end", async (e) => {
		const m: any = e.message;
		if (m?.role !== "assistant") return;
		flushDelta();
		const tools = (m.content ?? [])
			.filter((c: any) => c.type === "toolCall")
			.map((c: any) => ({ id: c.id, name: c.name, args: c.arguments }));
		send({
			t: "assistant",
			text: textOf(m.content),
			tools,
			model: m.model ? `${m.provider}/${m.model}` : null,
			usage: m.usage ? { input: m.usage.input, output: m.usage.output, cost: m.usage.cost?.total ?? 0 } : null,
			stop: m.stopReason,
			error: m.errorMessage ?? null,
		});
	});

	pi.on("tool_execution_start", async (e) => {
		send({ t: "tool_start", id: e.toolCallId, name: e.toolName, args: e.args });
	});

	pi.on("tool_execution_end", async (e) => {
		send({
			t: "tool_end",
			id: e.toolCallId,
			name: e.toolName,
			error: e.isError,
			result: clip(textOf(e.result?.content), 4000),
			ms: e.durationMs ?? null,
		});
	});

	pi.on("agent_settled", async (e, c) => {
		ctx = c;
		flushDelta();
		send({ t: "settled", aborted: e.aborted });
		state();
	});

	// changes made in the terminal (/model, Ctrl+P, /thinking, /name, /compact) show up in the app too
	pi.on("model_select", async (e, c) => {
		ctx = c;
		if (e.source !== "restore") note(`模型换成 ${e.model.provider}/${e.model.id}。`);
		state();
	});
	pi.on("thinking_level_select", async (_e, c) => {
		ctx = c;
		state();
	});
	pi.on("session_info_changed", async (_e, c) => {
		ctx = c;
		state();
	});
	pi.on("session_compact", async (_e, c) => {
		ctx = c;
		state();
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		flushDelta();
		send({ t: "bye" });
		await flush();
	});

	// the console's assistant: the page you are looking at, any endpoint to read, and asking you,
	// showing you and doing for you (each action waits for you to allow it in the sidebar)
	if (ROLE === "assistant") {
		const text = (t: string, details?: unknown) => ({ content: [{ type: "text" as const, text: t }], details });
		pi.registerTool({
			name: "papertown_page",
			label: "The user's page",
			description:
				"What the user is looking at in the Papertown console right now: the project, the panel with its settings and what is open, what they pointed at, where each part of the panel's data comes from (files, nvidb commands, Papertown endpoints) and the text the panel shows.",
			parameters: Type.Object({}),
			async execute() {
				const r = await call("/page");
				return text(r.text, r);
			},
		});
		pi.registerTool({
			name: "papertown_get",
			label: "Read Papertown",
			description:
				"GET one of Papertown's endpoints and return its JSON, e.g. /api/lines/line_6, /api/jobs?line_id=line_6, /api/gpus or /api/lines/line_6/data. Read only.",
			parameters: Type.Object({ path: Type.String({ description: "The endpoint, starting with /api/" }) }),
			async execute(_id, params) {
				if (!params.path.startsWith("/api/")) throw new Error("path must start with /api/");
				const r = await fetch(SERVER + params.path, { signal: AbortSignal.timeout(30000) });
				const body = await r.text();
				if (!r.ok) throw new Error(`Papertown ${r.status}: ${clip(body, 300)}`);
				return text(clip(body, 40000));
			},
		});
		pi.registerTool({
			name: "papertown_brief",
			label: "Project brief",
			description: "A project's brief: its idea, method draft, experiments and results, review feedback and the state of its repositories. Defaults to the project on the user's screen.",
			parameters: Type.Object({ line: Type.Optional(Type.String({ description: "The project, as line_6 or #6" })) }),
			async execute(_id, params) {
				const r = await call(`/brief${params.line ? `?line=${encodeURIComponent(params.line)}` : ""}`);
				return text(r.text, r);
			},
		});
		pi.registerTool({
			name: "papertown_ask",
			label: "Ask the user",
			description:
				"Ask the user something in the sidebar: give choices to click, or set point to ask them to click the part of the page they mean. Their answer comes as the next message; end your turn after asking.",
			parameters: Type.Object({
				question: Type.String(),
				choices: Type.Optional(Type.Array(Type.String())),
				point: Type.Optional(Type.Boolean({ description: "Ask them to point at the page" })),
			}),
			async execute(_id, params) {
				const r = await call("/ask", { method: "POST", body: JSON.stringify(params) });
				return text(r.text, r);
			},
		});
		pi.registerTool({
			name: "papertown_show",
			label: "Show the user",
			description:
				"Open something in the user's console or light up part of the page: mod opens a panel (overview, survey, code, exp, data, paper, agents, skills, mcp, rag), line a project, file a file in the code panel (code:path or code:path:line), job a job's details in the experiments panel, ref a part of the page (refs are listed in papertown_page).",
			parameters: Type.Object({
				mod: Type.Optional(Type.String()),
				line: Type.Optional(Type.String()),
				file: Type.Optional(Type.String()),
				job: Type.Optional(Type.String()),
				ref: Type.Optional(Type.String()),
			}),
			async execute(_id, params) {
				const r = await call("/show", { method: "POST", body: JSON.stringify(params) });
				return text(r.text, r);
			},
		});
		pi.registerTool({
			name: "papertown_actions",
			label: "What can be done",
			description: "The actions papertown_do can ask for, with their arguments.",
			parameters: Type.Object({}),
			async execute() {
				const r = await call("/actions");
				return text(r.text, r);
			},
		});
		pi.registerTool({
			name: "papertown_do",
			label: "Ask to do",
			description:
				"Ask to do something in the town (see papertown_actions). It waits in the sidebar until the user allows or denies it; the outcome comes back as an <event> message. End your turn after asking.",
			parameters: Type.Object({
				action: Type.String({ description: "e.g. job.cancel" }),
				args: Type.Optional(Type.Record(Type.String(), Type.Any())),
				why: Type.String({ description: "Why, in a sentence the user reads on the card" }),
			}),
			async execute(_id, params) {
				const r = await call("/act", { method: "POST", body: JSON.stringify({ ...params, args: params.args ?? {} }) });
				return text(r.text, r);
			},
		});
		return;
	}

	pi.registerTool({
		name: "papertown_project",
		label: "Papertown project",
		description:
			"Read this project's brief from Papertown: the idea, the method draft, experiment jobs and results, and review feedback.",
		parameters: Type.Object({}),
		async execute() {
			const b = await call("/brief");
			return { content: [{ type: "text", text: b.text }], details: b };
		},
	});

	if (ROLE !== "coder") return;

	pi.registerTool({
		name: "papertown_submit_job",
		label: "Submit experiment",
		description:
			"Submit an experiment to the Papertown farm, where it is queued, run and monitored. The command runs with bash in this project's code directory. Print `PROGRESS <0-100>` lines to report progress and either print `RESULT {json}` or write $PAPERTOWN_JOB_DIR/result.json with the metrics.",
		promptSnippet: "Submit experiments to the Papertown farm instead of running long jobs in the foreground",
		parameters: Type.Object({
			name: Type.String({ description: "Short job name, e.g. main or ablation-no-graph" }),
			command: Type.String({ description: "Shell command to run, e.g. python run.py --seed 0" }),
			backend: Type.Optional(Type.String({ description: "local (default). nvidb is not connected yet." })),
		}),
		async execute(_id, params) {
			const j = await call("/jobs", { method: "POST", body: JSON.stringify(params) });
			return {
				content: [{ type: "text", text: `Submitted ${j.id} (${j.name}) to ${j.backend}; status ${j.status}. Check it with papertown_job_status.` }],
				details: j,
			};
		},
	});

	pi.registerTool({
		name: "papertown_job_status",
		label: "Experiment status",
		description: "Check jobs on the Papertown farm for this project: status, progress, result and the end of the log. Omit job_id to list them all.",
		parameters: Type.Object({ job_id: Type.Optional(Type.String({ description: "Job id from papertown_submit_job" })) }),
		async execute(_id, params) {
			const r = await call(params.job_id ? `/jobs/${encodeURIComponent(params.job_id)}` : "/jobs");
			return { content: [{ type: "text", text: r.text }], details: r };
		},
	});
}
