#!/usr/bin/env node
/**
 * pi-relay MCP server — session-to-session messaging for pi and OpenCode agents.
 *
 * Four tools that end the human clipboard between parallel sessions:
 *   list_sessions  find live sessions by id or title substring
 *   read_session   read a session's recent messages / latest output
 *   send_session   one-way queued message (the Ctrl+Q follow-up semantic)
 *   ask_session    question -> wait for the target agent to finish -> return its answer
 *
 * Either end can be a pi session or an OpenCode session:
 *   OpenCode targets go through the OpenCode server API via `opencode api`
 *     (the official CLI router — no manual token handling; spawn the CLI executable
 *     directly with an args array, never through the .cmd shim, which re-parses
 *     arguments in cmd.exe and corrupts JSON bodies).
 *   pi targets go through the mailbox that `async-jobs/mailbox.ts` (same-named file in
 *     the pi-async-jobs package) watches inside every pi session. The directory layout
 *     is defined there and mirrored here — keep the two in sync.
 *
 * Plain Node, no dependencies. Requires Node >= 22.6 (native TypeScript type
 * stripping) to run the .ts entry directly: `node session-mcp.ts`.
 *
 * Wire-up example (pi mcp.json / OpenCode mcp config):
 *   { "mcp": { "pi-relay": { "type": "local", "command": ["node",
 *       "D:/ai项目/工程项目/PI插件项目/pi-delegate/session-mcp.ts"] } } }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findOpencodeCli } from "./cli.ts";

// ── mailbox layout (mirrors async-jobs/mailbox.ts) ─────────────────────────────
const MAILBOX_ROOT = path.join(os.homedir(), ".pi", "agent", "mailbox");
const BOX_DIR = path.join(MAILBOX_ROOT, "box");
const FEED_DIR = path.join(MAILBOX_ROOT, "feeds");
const REG_DIR = path.join(MAILBOX_ROOT, "registry");

interface Envelope {
	id: string;
	from: string;
	to: string;
	type: "msg" | "ask";
	body: string;
	ts: number;
}

interface PiRegistryEntry {
	id: string;
	name: string;
	cwd: string;
	pid: number;
	ts: number;
	stopped?: boolean;
}

interface Target {
	kind: "pi" | "opencode";
	id: string;
	name: string;
	cwd?: string;
	/** Set when the target is queued blindly: not registered, but mail is left in its box. */
	unregistered?: boolean;
}

function ensureDirs(): void {
	for (const dir of [MAILBOX_ROOT, BOX_DIR, FEED_DIR, REG_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/**
 * File-name safety for session ids (audit finding: a forged id like `..\..\x`
 * escaped the mailbox directory). Mirrors mailbox.ts's rule: [\w.-] survives,
 * everything else collapses to `_`. Raw ids stay in file content, never in paths.
 */
function fileSafe(id: string): string {
	return id.replace(/[^\w.-]+/g, "_");
}

function boxFileFor(id: string): string {
	return path.join(BOX_DIR, `${fileSafe(id)}.jsonl`);
}

function feedFileFor(id: string): string {
	return path.join(FEED_DIR, `${fileSafe(id)}.jsonl`);
}

// ── persistent session spawning (NOT a background job) ─────────────────────────
//
// The point of spawn_session: a session is a durable entity, never a "task". The
// session runs under a tiny detached supervisor that only holds its stdin open and
// expires it after ttlSeconds — no job engine, no timeout sweep, nothing in any jobs
// panel. Mail arrives in its box whether it is mid-turn or idle.

/** Follow the pi.cmd shim chain down to [node, cli.js]. Quoting-safe: only reads. */
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

/** Locate the mailbox bridge extension to give the new session a receive side. */
function findMailboxBridge(): string | null {
	if (process.env.PI_MAILBOX_BRIDGE && fs.existsSync(process.env.PI_MAILBOX_BRIDGE)) {
		return process.env.PI_MAILBOX_BRIDGE;
	}
	// dev checkout: pi-delegate and pi-async-jobs sit side by side
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const sibling = path.join(here, "..", "pi-async-jobs", "async-jobs", "mailbox.ts");
		if (fs.existsSync(sibling)) return sibling;
	} catch {
		/* fall through to the installed package */
	}
	const gitRoot = path.join(os.homedir(), ".pi", "agent", "git", "github.com", "dong615119371");
	try {
		for (const dir of fs.readdirSync(gitRoot)) {
			const candidate = path.join(gitRoot, dir, "async-jobs", "mailbox.ts");
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch {
		/* no installed copy */
	}
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
	'child.stdout.pipe(out); child.stderr.pipe(out);',
	'setTimeout(() => { try { child.stdin.end(); } catch {} }, Number(process.env.PI_SUP_TTL || "28800") * 1000);',
	'child.on("exit", (code) => {',
	'  appendLog("CHILD EXITED: code=" + code);',
	'  try { out.end(); } catch {}',
	'  process.exit(code ?? 0);',
	'});',
].join("\n");

function normalizeCwd(raw?: string): string | null {
	if (!raw) return process.cwd();
	// Repair DOS drive-relative paths like `D:ai项目` -> `D:/ai项目`
	const patched = raw.replace(/^([A-Za-z]):([^\\/])/, "$1:/$2");
	const resolved = path.resolve(patched);
	try {
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			return resolved;
		}
	} catch {}
	return null;
}

function spawnPiSession(opts: { id: string; cwd?: string; model?: string; ttlSeconds?: number; message?: string; from: string }): { ok: boolean; text: string } {
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
	const logFile = path.join(MAILBOX_ROOT, "spawn", `${fileSafe(opts.id)}.log`);
	try {
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		// Reset/truncate any old log before supervisor starts appending
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
	if (opts.message) {
		appendEnvelope({ kind: "pi", id: opts.id, name: opts.id }, "msg", opts.message, opts.from);
	}
	return {
		ok: true,
		text:
			`Spawned persistent pi session ${opts.id} (ttl ${ttl}s, cwd ${targetCwd}, log ${logFile}). ` +
			(bridge
				? "Mailbox bridge attached: it can receive. "
				: "WARNING: mailbox bridge not found - this session can send but never receive. Install the updated pi-async-jobs package. ") +
			(opts.message ? "First message queued in its box. " : "") +
			"It is NOT a background job; stop it by letting the ttl expire.",
	};
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
			try { child?.kill("SIGKILL"); } catch {}
			resolve({ ok: false, status: -1, data: null, raw: `Command timed out after ${Math.round(timeoutMs / 1000)}s` });
		}, timeoutMs);

		try {
			child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (err) {
			clearTimeout(timer);
			resolve({ ok: false, status: 0, data: null, raw: String(err) });
			return;
		}
		child.stdout?.on("data", (d) => { stdout += d.toString(); });
		child.stderr?.on("data", (d) => { stderr += d.toString(); });
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

/** Last assistant text in an OpenCode message list. Message shape (newest first):
 *  {type: "assistant", content: [{type: "text"|"reasoning", text}]}, {type: "user", text}. */
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

// ── session registry and target resolution ─────────────────────────────────────
function piRegistry(): PiRegistryEntry[] {
	const out: PiRegistryEntry[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(REG_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const file of files) {
		try {
			const entry = JSON.parse(fs.readFileSync(path.join(REG_DIR, file), "utf8")) as PiRegistryEntry;
			if (entry?.id) out.push(entry);
		} catch {
			/* half-written registry entry: skip */
		}
	}
	return out;
}

function isPiAlive(entry: PiRegistryEntry): boolean {
	// Heartbeat fresh enough (the bridge beats every 30s) counts as alive;
	// a session that shut down cleanly marks itself stopped and stays addressable.
	if (entry.stopped) return false;
	return Date.now() - (entry.ts ?? 0) < 90_000;
}

async function resolveTarget(ref: string): Promise<Target | { error: string }> {
	const needle = ref.trim().toLowerCase();

	const pi = piRegistry();
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
		return { error: `No session matches "${ref}". Use list_sessions to see live and registered sessions.` };
	}
	return {
		error:
			`"${ref}" matches ${matches.length} sessions; pass the exact id instead:\n` +
			matches.map((m) => `  [${m.kind}] ${m.id}  ${m.name}`).join("\n"),
	};
}

function appendEnvelope(target: Target, type: "msg" | "ask", message: string, from: string): string {
	ensureDirs();
	const envelope: Envelope = { id: randomUUID(), from, to: target.id, type, body: message, ts: Date.now() };
	fs.appendFileSync(boxFileFor(target.id), JSON.stringify(envelope) + "\n");
	return envelope.id;
}

/** Wait until the target's feed reports a run that answered `askId` — event-driven
 *  (fs.watch on the feeds directory), with the deadline only as a failure bound. */
function waitForFeedAnswer(feedFile: string, askId: string, timeoutMs: number): Promise<{ ok: boolean; text?: string; error?: string }> {
	return new Promise((resolve) => {
		const feedName = path.basename(feedFile);
		const feedDir = path.dirname(feedFile);
		let settled = false;
		let watcher: fs.FSWatcher | null = null;
		let fallbackTimer: ReturnType<typeof setInterval> | null = null;
		const finish = (result: { ok: boolean; text?: string; error?: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadlineTimer);
			if (fallbackTimer !== null) clearInterval(fallbackTimer);
			try {
				watcher?.close();
			} catch {
				/* already closed */
			}
			resolve(result);
		};
		const check = () => {
			try {
				const lines = fs.readFileSync(feedFile, "utf8").split(/\r?\n/).filter(Boolean);
				for (const line of lines) {
					try {
						const entry = JSON.parse(line) as { text?: string; answering?: string[] };
						if (Array.isArray(entry.answering) && entry.answering.includes(askId)) {
							finish({ ok: true, text: entry.text ?? "" });
							return;
						}
					} catch {
						/* skip malformed feed lines */
					}
				}
			} catch {
				/* feed file not created yet: the target has not finished a run */
			}
		};
		const deadlineTimer = setTimeout(() => {
			finish({ ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the target to answer. It may be busy or offline; the question stays queued and will be delivered on its next start.` });
		}, timeoutMs);
		try {
			watcher = fs.watch(feedDir, (_event, filename) => {
				if (filename && filename.toLowerCase() !== feedName.toLowerCase()) return;
				check();
			});
		} catch {
			// No usable watch handle: degrade to a coarse poll instead of never resolving.
			fallbackTimer = setInterval(check, 5_000);
			fallbackTimer.unref?.();
		}
		check(); // the answer may already be sitting there
	});
}

// ── tools ──────────────────────────────────────────────────────────────────────
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const TOOLS = [
	{
		name: "list_sessions",
		description:
			"List live agent sessions (pi and OpenCode) that this relay can talk to. " +
			"Returns kind, id, name/title, working directory and busy/idle state. " +
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
			"Read the recent messages of a target session (pi or OpenCode): the last N turns for OpenCode, " +
			"the last N finished-run outputs for pi. Use this to catch up on what the other agent said or did.",
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
			"Send a one-way message to a target session (pi or OpenCode). Queued like a Ctrl+Q follow-up: " +
			"it never interrupts a running turn, and a message to an offline pi session is delivered when it starts. " +
			"Returns immediately — use ask_session when you need the other agent's answer.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target session id, or a unique name/title substring." },
				message: { type: "string", description: "Message body." },
				from: { type: "string", description: "Sender label shown to the target. Default 'peer-agent'." },
			},
			required: ["to", "message"],
		},
	},
	{
		name: "ask_session",
		description:
			"Ask a target session (pi or OpenCode) a question and WAIT for its agent to think, act and finish, " +
			"then return its final conclusion. The question is delivered as a queued follow-up (Ctrl+Q semantic), " +
			"so it never interrupts work in progress. This call blocks: use it when the next step needs the answer, " +
			"e.g. have a review session audit changes and return the findings.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Target session id, or a unique name/title substring." },
				message: { type: "string", description: "The question or request." },
				from: { type: "string", description: "Sender label shown to the target. Default 'peer-agent'." },
				timeoutSeconds: { type: "number", description: "Max wait for the answer. Default 600." },
			},
			required: ["to", "message"],
		},
	},
	{
		name: "spawn_session",
		description:
			"Create a NEW persistent pi session that this relay can talk to. Unlike a delegated " +
			"task, the session is a durable entity: it idles, receives queued messages like a Ctrl+Q " +
			"follow-up, answers, and is never a background job (nothing appears in any jobs panel). " +
			"Returns the session id; use send_session/ask_session to talk to it. It exits itself after " +
			"ttlSeconds (default 28800 = 8h).",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Session id (letters, digits, _ . -). Also its address." },
				cwd: { type: "string", description: "Working directory for the session. Default: current dir." },
				model: { type: "string", description: "Model id, e.g. magpie/xiaomi/mimo-v2.6-flash." },
				ttlSeconds: { type: "number", description: "Self-expiry after this many seconds. Default 28800." },
				message: { type: "string", description: "Optional first message, queued in its box before it wakes." },
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
			for (const e of piRegistry()) {
				if (search && !(e.name ?? "").toLowerCase().includes(search)) continue;
				const state = e.stopped ? "stopped" : isPiAlive(e) ? "alive" : "stale";
				lines.push(`[pi] ${e.id}  ${e.name}  cwd=${e.cwd ?? "?"}  ${state}`);
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
				let entries: Array<{ ts: number; text: string }> = [];
				try {
					entries = fs
						.readFileSync(feedFileFor(target.id), "utf8")
						.split(/\r?\n/)
						.filter(Boolean)
						.map((line) => {
							try {
								return JSON.parse(line) as { ts: number; text: string };
							} catch {
								return null;
							}
						})
						.filter((e): e is { ts: number; text: string } => e !== null);
				} catch {
					return fail(`Session ${target.id} has no recorded output yet.`);
				}
				const tail = entries.slice(-count);
				if (tail.length === 0) return fail(`Session ${target.id} has no recorded output yet.`);
				return ok(tail.map((e) => `[${new Date(e.ts).toLocaleString()}]\n${e.text}`).join("\n\n---\n\n"));
			}
			const messages = await ocMessageList(target.id);
			if (messages.length === 0) return fail(`Session ${target.id} has no messages (or the OpenCode API refused the read).`);
			// The API returns newest first; show the newest `count` in chronological order.
			const tail = messages.slice(0, count).reverse();
			const blocks = tail
				.filter((m) => ocMessageText(m) !== "")
				.map((m) => `[${m?.type ?? "?"}]\n${ocMessageText(m)}`);
			return ok(blocks.join("\n\n---\n\n") || "(no text messages in this session)");
		}

		case "send_session": {
			const target = await resolveTarget(String(args.to ?? ""));
			if ("error" in target) return fail(target.error);
			const message = String(args.message ?? "").trim();
			if (!message) return fail("message must not be empty.");
			const from = String(args.from ?? "peer-agent");
			if (target.kind === "pi") {
				appendEnvelope(target, "msg", message, from);
				return ok(`Queued message to pi session ${target.id} (${target.name}).`);
			}
			// OpenCode prompt body: {text}. The server queues it as a steer delivery and
			// wakes the target agent — its native queued-message semantic.
			const res = await api("POST", `/api/session/${encodeURIComponent(target.id)}/prompt`, { text: message });
			if (!res.ok) return fail(`OpenCode prompt failed: ${res.raw}`);
			return ok(`Sent message to OpenCode session ${target.id} (${target.name}).`);
		}

		case "ask_session": {
			const target = await resolveTarget(String(args.to ?? ""));
			if ("error" in target) return fail(target.error);
			const message = String(args.message ?? "").trim();
			if (!message) return fail("message must not be empty.");
			const from = String(args.from ?? "peer-agent");
			const timeoutMs = Math.max(10, Math.min(3600, Number(args.timeoutSeconds) || 600)) * 1000;

			if (target.kind === "pi") {
				const askId = appendEnvelope(target, "ask", message, from);
				const result = await waitForFeedAnswer(feedFileFor(target.id), askId, timeoutMs);
				if (!result.ok) return fail(result.error ?? "No answer.");
				return ok(result.text ?? "(the target answered with no text)");
			}
			const sentAt = Date.now();
			const sent = await api("POST", `/api/session/${encodeURIComponent(target.id)}/prompt`, { text: message });
			if (!sent.ok) return fail(`OpenCode prompt failed: ${sent.raw}`);
			// Preferred: the experimental wait endpoint blocks asynchronously until the agent is idle again.
			// Give wait a timeout linked directly to the requested timeoutMs (+5s grace).
			const waited = await api("POST", `/api/experimental/session/${encodeURIComponent(target.id)}/wait`, undefined, timeoutMs + 5000);
			if (waited.ok) {
				const text = ocLastAssistantText(await ocMessageList(target.id), sentAt);
				if (text) return ok(text);
				// If no text was produced after sentAt, it was an early idle race condition — fall through to polling!
			}
			// Fallback: poll for a NEW assistant message.
			// Intermediate steps (tool calls like read/grep) emit assistant messages with no text
			// blocks — these must NOT trigger an early exit while the agent is still working.
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
					const ts = Number(m?.time?.completed ?? m?.time?.created ?? 0);
					return ts > sentAt;
				});
				if (answer) {
					const content = Array.isArray(answer?.content) ? answer.content : [];
					const texts = content
						.filter((b: Record<string, any>) => b?.type === "text" && typeof b.text === "string")
						.map((b: Record<string, any>) => b.text as string);
					if (texts.length > 0) {
						return ok(texts.join("\n"));
					}
					if (isSettled) {
						return ok("(the target answered with no text)");
					}
					// Intermediate tool call: agent is still executing tools, keep polling!
				}
			}
			return fail(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the target to answer.`);
		}

		case "spawn_session": {
			const id = String(args.id ?? "").trim();
			if (!/^[\w.-]+$/.test(id)) return fail("id must match [\\w.-]+ — it becomes the mailbox address.");
			const result = spawnPiSession({
				id,
				cwd: args.cwd ? String(args.cwd) : undefined,
				model: args.model ? String(args.model) : undefined,
				ttlSeconds: args.ttlSeconds ? Number(args.ttlSeconds) : undefined,
				message: args.message ? String(args.message) : undefined,
				from: String(args.from ?? "peer-agent"),
			});
			return result.ok ? ok(result.text) : fail(result.text);
		}

		default:
			return fail(`Unknown tool: ${name}`);
	}
}

// ── JSON-RPC over stdio (newline-delimited, MCP stdio transport) ────────────────
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
	if (!method) return;
	try {
		switch (method) {
			case "initialize":
				return reply(id, {
					protocolVersion: params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "pi-relay", version: "0.1.0" },
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
// Exit cleanly when stdin closes, allowing a 1s grace period for pending I/O before forcing exit.
process.stdin.on("end", () => {
	setTimeout(() => process.exit(0), 1000).unref();
});
