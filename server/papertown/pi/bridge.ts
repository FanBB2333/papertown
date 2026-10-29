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
 *   - pi.registerTool() adds the Papertown tools (project brief; job submission for coders)
 *
 * Environment (set by the server): PAPERTOWN_URL, PAPERTOWN_AGENT, PAPERTOWN_AGENT_TOKEN,
 * PAPERTOWN_AGENT_ROLE. Without them the extension does nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	}

	function deliver(m: { id: number; kind?: string; text?: string }) {
		if (m.kind === "abort") {
			ctx?.abort();
			send({ t: "delivered", ids: [m.id] });
			return;
		}
		if (!m.text) return;
		const idle = ctx?.isIdle() ?? true;
		void pi.sendUserMessage(m.text, idle ? undefined : { deliverAs: "followUp" });
		send({ t: "delivered", ids: [m.id], queued: !idle });
	}

	async function poll() {
		if (polling) return;
		polling = true;
		let online = false;
		while (!stopped) {
			try {
				const { messages } = await call("/inbox?wait=20", {}, 30000);
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

	pi.on("agent_settled", async (e) => {
		flushDelta();
		send({ t: "settled", aborted: e.aborted });
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		flushDelta();
		send({ t: "bye" });
		await flush();
	});

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
