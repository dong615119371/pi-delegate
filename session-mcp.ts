#!/usr/bin/env node
/**
 * pi-relay MCP server — session-to-session messaging for Pi and OpenCode agents.
 *
 * Implements direct process-to-process communication:
 *   - Pi targets: Native Named Pipe IPC (\\\\.\\pipe\\pi-session-<id> on Windows,
 *     /tmp/pi-session-<id>.sock on POSIX). Connection IS Context. Zero disk blackboards.
 *   - OpenCode targets: Official HTTP API via opencode-cli router.
 *
 * 5 tools provided:
 *   list_sessions  find live sessions by id or title substring
 *   read_session   read target session recent messages / state
 *   send_session   one-way queued message (Ctrl+Q followUp semantic)
 *   ask_session    question -> wait for target agent to think & finish -> return answer
 *   spawn_session  spawn a new persistent Pi session with built-in IPC bridge
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOpencodeCli } from "./cli.ts";

// ── Native Named Pipe IPC helpers ──────────────────────────────────────────────

export function getSessionPipePath(sessionId: string): string {
	const safeId = sessionId.replace(/[^\w.-]+/g, "_");
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-session-${safeId}`
		: path.join(os.tmpdir(), `pi-session-${safeId}.sock`);
}

export function getLiveDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions-live");
}

interface PiLiveEntry {
	id: string;
	name: string;
	cwd: string;
	pid: number;
	pipe: string;
}

interface Target {
	kind: "pi" | "opencode";
	id: string;
	name: string;
	cwd?: string;
}

function piLiveSessions(): PiLiveEntry[] {
	const dir = getLiveDir();
	const out: PiLiveEntry[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const file of files) {
		const p = path.join(dir, file);
		try {
			const entry = JSON.parse(fs.readFileSync(p, "utf8")) as PiLiveEntry;
			if (!entry?.id || !entry?.pid) continue;
			// PID liveness probe: does the process actually exist?
			try {
				process.kill(entry.pid, 0);
				out.push(entry);
			} catch {
				// Dead process: sweep stale card
				try {
					fs.unlinkSync(p);
				} catch {}
			}
		} catch {}
	}
	return out;
}

// ── OpenCode server API via the official CLI router ────────────────────────────
interface ApiResult {
	ok: boolean;
	status: number;
	data: unknown;
	raw: string;
}

function api(method: string, apiPath: string, body?: unknown, timeoutMs = 120_000): Promise<ApiResult> {
	return new Promise((resolve) => {
		const cli = findOpencodeCli();
		if (!cli) {
			resolve({ ok: false, status: 0, data: null, raw: "OpenCode CLI not found. Install the desktop client or set OPENCODE_CLI." });
			return;
		}
		const args = ["api", method, apiPath];
		if (body !== undefined) args.push("--data", JSON.stringify(body));
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ReturnType<typeof spawn>;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child?.kill("SIGKILL");
			} catch {}
			resolve({ ok: false, status: -1, data: null, raw: `Command timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);

		try {
			child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (err) {
			clearTimeout(timer);
			resolve({ ok: false, status: 0, data: null, raw: String(err) });
			return;
		}
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, status: 0, data: null, raw: String(err) });
		});
		child.on("close", (status) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const raw = stdout.trim();
			let data: unknown = null;
			try {
				data = JSON.parse(raw);
			} catch {
				/* non-JSON output is passed through as raw */
			}
			const isErrorEnvelope = (data !== null && typeof data === "object" && "_tag" in (data as object)) || /HTTP [45]\d\d/.test(raw);
			const ok = status === 0 && !isErrorEnvelope && (data !== null || raw === "");
			resolve({ ok, status: status ?? -1, data, raw: raw || stderr.trim() });
		});
	});
}

async function ocSessionList(): Promise<Array<Record<string, any>>> {
	const res = await api("GET", "/api/session");
	if (!res.ok) return [];
	const data = res.data as { data?: Array<Record<string, any>> } | Array<Record<string, any>>;
	const list = Array.isArray(data) ? data : (data?.data ?? []);
	return Array.isArray(list) ? list : [];
}

async function ocMessageList(sessionID: string): Promise<Array<Record<string, any>>> {
	const res = await api("GET", `/api/session/${encodeURIComponent(sessionID)}/message`);
	if (!res.ok) return [];
	const data = res.data as { data?: Array<Record<string, any>> } | Array<Record<string, any>>;
	const list = Array.isArray(data) ? data : (data?.data ?? []);
	return Array.isArray(list) ? list : [];
}

function ocLastAssistantText(messages: Array<Record<string, any>>, afterTs = 0): string {
	for (const m of messages) {
		if (m?.type !== "assistant") continue;
		const ts = Number(m?.time?.completed ?? m?.time?.created ?? 0);
		if (afterTs > 0 && ts <= afterTs) continue;
		const content = Array.isArray(m?.content) ? m.content : [];
		const texts = content
			.filter((b: Record<string, any>) => b?.type === "text" && typeof b.text === "string")
			.map((b: Record<string, any>) => b.text as string);
		if (texts.length > 0) return texts.join("\n");
	}
	return "";
}

function ocMessageText(m: Record<string, any>): string {
	if (typeof m?.text === "string" && m.text) return m.text;
	if (typeof m?.payload?.text === "string" && m.payload.text) return m.payload.text;
	const content = Array.isArray(m?.content) ? m.content : [];
	return content
		.filter((b: Record<string, any>) => b?.type === "text" && typeof b.text === "string")
		.map((b: Record<string, any>) => b.text as string)
		.join("\n");
}

// ── Target Resolution ──────────────────────────────────────────────────────────

async function resolveTarget(ref: string): Promise<Target | { error: string }> {
	const needle = ref.trim().toLowerCase();

	const pi = piLiveSessions();
	const exactPi = pi.find((e) => e.id === ref);
	if (exactPi) return { kind: "pi", id: exactPi.id, name: exactPi.name, cwd: exactPi.cwd };

	const oc = await ocSessionList();
	const exactOc = oc.find((s) => s?.id === ref);
	if (exactOc) return { kind: "opencode", id: exactOc.id, name: String(exactOc.title ?? exactOc.id), cwd: exactOc.location?.directory };

	const matches: Target[] = [
		...pi.filter((e) => (e.name ?? "").toLowerCase().includes(needle)).map((e) => ({ kind: "pi" as const, id: e.id, name: e.name, cwd: e.cwd })),
		...oc.filter((s) => String(s?.title ?? "").toLowerCase().includes(needle)).map((s) => ({ kind: "opencode" as const, id: s.id as string, name: String(s.title ?? s.id), cwd: s.location?.directory })),
	];
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) {
		return { error: `No live session matches "${ref}". Use list_sessions to see active sessions.` };
	}
	return {
		error:
			`"${ref}" matches ${matches.length} sessions; pass the exact id instead:\n` +
			matches.map((m) => `  [${m.kind}] ${m.id}  ${m.name}`).join("\n"),
	};
}

// ── Persistent Pi Session Spawner (Supervisor) ────────────────────────────────

function findPiEntry(): { node: string; entry: string } | null {
	if (process.env.PI_ENTRY && fs.existsSync(process.env.PI_ENTRY)) {
		return { node: process.execPath, entry: process.env.PI_ENTRY };
	}
	let current = path.join(os.homedir(), ".local", "bin", "pi.cmd");
	for (let hop = 0; hop < 4; hop++) {
		let text: string;
		try {
			text = fs.readFileSync(current, "utf8");
		} catch {
			return null;
		}
		const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		const next = quoted.find((q) => /\.(cmd|js)$/i.test(q));
		if (!next) return null;
		const resolved = path.resolve(next.replace(/%dp0%/gi, path.dirname(current) + path.sep));
		if (/\.js$/i.test(resolved)) return { node: process.execPath, entry: resolved };
		current = resolved;
	}
	return null;
}

function findMailboxBridge(): string | null {
	if (process.env.PI_MAILBOX_BRIDGE && fs.existsSync(process.env.PI_MAILBOX_BRIDGE)) {
		return process.env.PI_MAILBOX_BRIDGE;
	}
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sibling = path.join(here, "..", "pi-async-jobs", "async-jobs", "mailbox.ts");
		if (fs.existsSync(sibling)) return sibling;
	} catch {}
	const gitRoot = path.join(os.homedir(), ".pi", "agent", "git", "github.com", "dong615119371");
	try {
		for (const dir of fs.readdirSync(gitRoot)) {
			const candidate = path.join(gitRoot, dir, "async-jobs", "mailbox.ts");
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch {}
	return null;
}

const SUPERVISOR_SRC = [
	'const { spawn } = require("node:child_process");',
	'const fs = require("node:fs");',
	'const logFile = process.env.PI_SUP_LOG;',
	'const appendLog = (line) => { try { fs.appendFileSync(logFile, line + "\\n"); } catch {} };',
	'process.on("uncaughtException", (err) => {',
	'  appendLog("SUPERVISOR UNCAUGHT: " + (err.stack || err.message));',
	'  process.exit(1);',
	'});',
	'appendLog("SUPERVISOR STARTED: pid=" + process.pid);',
	'const child = spawn(process.env.PI_SUP_NODE, JSON.parse(process.env.PI_SUP_ARGS), {',
	'  stdio: ["pipe", "pipe", "pipe"],',
	'  windowsHide: true,',
	'  cwd: process.env.PI_SUP_CWD || undefined,',
	'});',
	'child.on("error", (err) => {',
	'  appendLog("CHILD SPAWN ERROR: " + (err.stack || err.message));',
	'  process.exit(1);',
	'});',
	'const out = fs.createWriteStream(logFile, { flags: "a" });',
	'child.stdout.pipe(out, { end: false });',
	'child.stderr.pipe(out, { end: false });',
	'setTimeout(() => { try { child.stdin.end(); } catch {} }, Number(process.env.PI_SUP_TTL || "28800") * 1000);',
	'child.on("close", (code) => {',
	'  appendLog("CHILD CLOSED: code=" + code);',
	'  try { out.end(); } catch {}',
	'  process.exit(code ?? 0);',
	'});',
].join("\n");

function normalizeCwd(raw?: string): string | null {
	if (!raw) return process.cwd();
	const patched = raw.replace(/^([A-Za-z]):([^\\/])/, "$1:/$2");
	const resolved = path.resolve(patched);
	try {
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			return resolved;
		}
	} catch {}
	return null;
}

function spawnPiSession(opts: { id: string; cwd?: string; model?: string; ttlSeconds?: number }): { ok: boolean; text: string } {
	const entry = findPiEntry();
	if (!entry) return { ok: false, text: "pi entry not found: set PI_ENTRY to the pi-coding-agent cli.js path." };
	const targetCwd = normalizeCwd(opts.cwd);
	if (!targetCwd) {
		return { ok: false, text: `cwd does not exist or is not a directory: "${opts.cwd}"` };
	}
	const ttl = Math.max(60, Math.min(86400, Number(opts.ttlSeconds) || 28800));
	const args = [entry.entry, "--mode", "rpc", "--session-id", opts.id];
	if (opts.model) args.push("--model", opts.model);
	const bridge = findMailboxBridge();
	if (bridge) args.push("--extension", bridge);
	const logDir = path.join(os.homedir(), ".pi", "agent", "spawn-logs");
	const logFile = path.join(logDir, `${opts.id.replace(/[^\w.-]+/g, "_")}.log`);
	try {
		fs.mkdirSync(logDir, { recursive: true });
		fs.writeFileSync(logFile, "");
		const supervisor = spawn(process.execPath, ["-e", SUPERVISOR_SRC], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: {
				...process.env,
				PI_SUP_NODE: entry.node,
				PI_SUP_ARGS: JSON.stringify(args),
				PI_SUP_TTL: String(ttl),
				PI_SUP_LOG: logFile,
				PI_SUP_CWD: targetCwd,
			},
		});
		supervisor.unref();
	} catch (err) {
		return { ok: false, text: `spawn failed: ${String(err)}` };
	}
	return {
		ok: true,
		text:
			`Spawned persistent pi session ${opts.id} (ttl ${ttl}s, cwd ${targetCwd}, log ${logFile}). ` +
			(bridge ? "IPC bridge attached. " : "WARNING: IPC bridge extension not found. ") +
			"It is NOT a background job; talk to it with send_session/ask_session.",
	};
}

// ── Direct Named Pipe Client Helpers ───────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function sendPipe(pipePath: string, payload: unknown, timeoutMs = 10_000): Promise<{ ok: boolean; data?: any; error?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		const socket = net.connect(pipePath, () => {
			socket.write(JSON.stringify(payload) + "\n");
		});

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				socket.destroy();
			} catch {}
			resolve({ ok: false, error: `Connection timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);

		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.includes("\n")) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					const res = JSON.parse(buffer.trim());
					resolve({ ok: res.ok !== false, data: res, error: res.error });
				} catch (err) {
					resolve({ ok: false, error: `Malformed response: ${String(err)}` });
				}
				socket.end();
			}
		});

		socket.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, error: err.message });
		});
	});
}

// ── Tools ──────────────────────────────────────────────────────────────────────

const TOOLS = [
	{
		name: "list_sessions",
		description:
			"List live agent sessions (Pi and OpenCode) that this relay can talk to. " +
			"Returns kind, id, name/title, and working directory. " +
			"Use the id (or a unique name substring) with read_session / send_session / ask_session.",
		inputSchema: {
			type: "object",
			properties: {
				search: { type: "string", description: "Optional case-insensitive substring filter on the session name/title." },
			},
		},
	},
	{
		name: "read_session",
		description:
			"Read the recent messages of a target session (Pi or OpenCode). " +
			"Use this to catch up on what the other agent said or did.",
		inputSchema: {
			type: "object",
			properties: {
				session: { type: "string", description: "Target session id, or a unique name/title substring." },
				count: { type: "number", description: "How many recent messages to read. Default 10." },
			},
			required: ["session"],
		},
	},
	{
		name: "send_session",
		description:
			"Send a one-way message to a target session (Pi or OpenCode). Queued like a Ctrl+Q follow-up: " +
			"it never interrupts a running turn. Returns immediately — use ask_session when you need the other agent's answer.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target session id, or a unique name/title substring." },
				message: { type: "string", description: "Message body (under 24,000 characters)." },
				from: { type: "string", description: "Sender label shown to the target. Default 'peer-agent'." },
			},
			required: ["to", "message"],
		},
	},
	{
		name: "ask_session",
		description:
			"Ask a target session (Pi or OpenCode) a question and WAIT for its agent to think, act and finish, " +
			"then return its final conclusion. Delivers as a queued follow-up (Ctrl+Q semantic), " +
			"so it never interrupts work in progress. Blocks until target completes its turn.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target session id, or a unique name/title substring." },
				message: { type: "string", description: "The question or request (under 24,000 characters)." },
				from: { type: "string", description: "Sender label shown to the target. Default 'peer-agent'." },
				timeoutSeconds: { type: "number", description: "Max wait for the answer. Default 600." },
			},
			required: ["to", "message"],
		},
	},
	{
		name: "spawn_session",
		description:
			"Create a NEW persistent Pi session that this relay can talk to. The session is a durable entity: " +
			"it idles, receives queued messages via native IPC pipe, answers, and is never a background job " +
			"(nothing appears in any jobs panel). Returns the session id. Exits itself after ttlSeconds (default 28800 = 8h).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Session id (letters, digits, _ . -). Also its address." },
				cwd: { type: "string", description: "Working directory for the session. Default: current dir." },
				model: { type: "string", description: "Model id, e.g. magpie/xiaomi/mimo-v2.6-flash." },
				ttlSeconds: { type: "number", description: "Self-expiry after this many seconds. Default 28800." },
			},
			required: ["id"],
		},
	},
];

async function callTool(name: string, args: Record<string, any>): Promise<ToolResult> {
	switch (name) {
		case "list_sessions": {
			const search = String(args.search ?? "").trim().toLowerCase();
			const lines: string[] = [];
			for (const e of piLiveSessions()) {
				if (search && !(e.name ?? "").toLowerCase().includes(search)) continue;
				lines.push(`[pi] ${e.id}  ${e.name}  cwd=${e.cwd ?? "?"}  (live pipe: ${e.pipe})`);
			}
			for (const s of await ocSessionList()) {
				const title = String(s.title ?? s.id);
				if (search && !title.toLowerCase().includes(search)) continue;
				const busy = (s.time?.busy ?? 0) > (s.time?.idle ?? 0);
				lines.push(`[opencode] ${s.id}  ${title}  cwd=${s.location?.directory ?? "?"}  ${busy ? "busy" : "idle"}`);
			}
			return ok(lines.length > 0 ? lines.join("\n") : "No live sessions found.");
		}

		case "read_session": {
			const target = await resolveTarget(String(args.session ?? ""));
			if ("error" in target) return fail(target.error);
			const count = Math.max(1, Math.min(100, Number(args.count) || 10));

			if (target.kind === "pi") {
				const pipePath = getSessionPipePath(target.id);
				const res = await sendPipe(pipePath, { type: "read", count }, 8_000);
				if (!res.ok) return fail(`Failed to read from Pi session ${target.id}: ${res.error}`);
				const msgs = Array.isArray(res.data?.messages) ? res.data.messages : [];
				if (msgs.length === 0) return fail(`Session ${target.id} has no messages.`);
				return ok(msgs.join("\n\n---\n\n"));
			}

			const messages = await ocMessageList(target.id);
			if (messages.length === 0) return fail(`Session ${target.id} has no messages (or API refused read).`);
			const tail = messages.slice(0, count).reverse();
			const blocks = tail.filter((m) => ocMessageText(m) !== "").map((m) => `[${m?.type ?? "?"}]\n${ocMessageText(m)}`);
			return ok(blocks.join("\n\n---\n\n") || "(no text messages in this session)");
		}

		case "send_session": {
			const target = await resolveTarget(String(args.to ?? ""));
			if ("error" in target) return fail(target.error);
			const message = String(args.message ?? "").trim();
			if (!message) return fail("message must not be empty.");
			if (message.length > 24_000) {
				return fail(`Message length (${message.length} chars) exceeds safe buffer limit (24,000 chars). Write large content to a file and pass its path instead.`);
			}
			const from = String(args.from ?? "peer-agent");

			if (target.kind === "pi") {
				const pipePath = getSessionPipePath(target.id);
				const res = await sendPipe(pipePath, { type: "msg", from, message }, 10_000);
				if (!res.ok) return fail(`Failed to deliver message to Pi session ${target.id}: ${res.error}`);
				return ok(`Delivered message to Pi session ${target.id} (${target.name}).`);
			}

			const res = await api("POST", `/api/session/${encodeURIComponent(target.id)}/prompt`, { text: message });
			if (!res.ok) return fail(`OpenCode prompt failed: ${res.raw}`);
			return ok(`Sent message to OpenCode session ${target.id} (${target.name}).`);
		}

		case "ask_session": {
			const target = await resolveTarget(String(args.to ?? ""));
			if ("error" in target) return fail(target.error);
			const message = String(args.message ?? "").trim();
			if (!message) return fail("message must not be empty.");
			if (message.length > 24_000) {
				return fail(`Message length (${message.length} chars) exceeds safe buffer limit (24,000 chars). Write large content to a file and pass its path instead.`);
			}
			const from = String(args.from ?? "peer-agent");
			const timeoutMs = Math.max(10, Math.min(3600, Number(args.timeoutSeconds) || 600)) * 1000;

			if (target.kind === "pi") {
				// Pure IPC: Connect pipe, send ask, hold socket open until target finishes
				const pipePath = getSessionPipePath(target.id);
				const res = await sendPipe(pipePath, { type: "ask", from, message }, timeoutMs);
				if (!res.ok) return fail(`Target Pi session ${target.id} error or timed out: ${res.error}`);
				return ok(res.data?.text || "(the target answered with no text)");
			}

			const sentAt = Date.now();
			const sent = await api("POST", `/api/session/${encodeURIComponent(target.id)}/prompt`, { text: message });
			if (!sent.ok) return fail(`OpenCode prompt failed: ${sent.raw}`);

			const waited = await api("POST", `/api/experimental/session/${encodeURIComponent(target.id)}/wait`, undefined, timeoutMs + 5000);
			if (waited.ok) {
				const text = ocLastAssistantText(await ocMessageList(target.id), sentAt);
				if (text) return ok(text);
			}

			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 2000));
				const messages = await ocMessageList(target.id);
				const isSettled = messages.some((m) => {
					if (m?.type !== "idle") return false;
					const ts = Number(m?.time?.completed ?? m?.time?.created ?? 0);
					return ts > sentAt;
				});
				const answer = messages.find((m) => {
					if (m?.type !== "assistant") return false;
					const completedTs = Number(m?.time?.completed ?? 0);
					if (completedTs > sentAt) return true;
					if (isSettled && Number(m?.time?.created ?? 0) > sentAt) return true;
					return false;
				});
				if (answer) {
					const content = Array.isArray(answer?.content) ? answer.content : [];
					const texts = content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text as string);
					if (texts.length > 0) return ok(texts.join("\n"));
					if (isSettled) return ok("(the target answered with no text)");
				}
			}
			return fail(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the target to answer.`);
		}

		case "spawn_session": {
			const id = String(args.id ?? "").trim();
			if (!/^[\w.-]+$/.test(id)) return fail("id must match [\\w.-]+.");
			const result = spawnPiSession({
				id,
				cwd: args.cwd ? String(args.cwd) : undefined,
				model: args.model ? String(args.model) : undefined,
				ttlSeconds: args.ttlSeconds ? Number(args.ttlSeconds) : undefined,
			});
			return result.ok ? ok(result.text) : fail(result.text);
		}

		default:
			return fail(`Unknown tool: ${name}`);
	}
}

// ── JSON-RPC over stdio (MCP stdio transport) ──────────────────────────────────

function send(msg: unknown): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: number | string | null | undefined, result: unknown): void {
	if (id === undefined || id === null) return;
	send({ jsonrpc: "2.0", id, result });
}

async function handle(line: string): Promise<void> {
	let req: { id?: number | string | null; method?: string; params?: Record<string, any> };
	try {
		req = JSON.parse(line);
	} catch {
		send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		return;
	}
	const { id, method, params } = req;
	if (!method) {
		if (id !== undefined && id !== null) {
			send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: missing method" } });
		}
		return;
	}
	try {
		switch (method) {
			case "initialize":
				return reply(id, {
					protocolVersion: params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "pi-relay", version: "0.2.0" },
				});
			case "notifications/initialized":
			case "notifications/cancelled":
				return;
			case "ping":
				return reply(id, {});
			case "tools/list":
				return reply(id, { tools: TOOLS });
			case "tools/call":
				return reply(id, await callTool(String(params?.name ?? ""), (params?.arguments as Record<string, any>) ?? {}));
			default:
				if (id !== undefined && id !== null) {
					send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
				}
		}
	} catch (err) {
		if (id !== undefined && id !== null) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err) } });
		}
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let index: number;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) void handle(line);
	}
});

process.stdin.on("end", () => {
	setTimeout(() => process.exit(0), 1000).unref();
});
