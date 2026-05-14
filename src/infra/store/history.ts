import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Trigger } from "../../pipeline/core.ts";
import { settings } from "../config.ts";
import { log } from "../logger.ts";
import { readText } from "../runtime.ts";
import { localDateString } from "./index.ts";

/** Mirrors the `Trigger` discriminated union in `src/types.ts`. */
export const TriggerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("message"), messageId: z.string() }),
	z.object({ kind: z.literal("schedule"), scheduleId: z.string() }),
	z.object({ kind: z.literal("timer"), timerId: z.string() }),
	z.object({ kind: z.literal("dispatch"), parentRunId: z.string() }),
]);

/** Common fields on either role of a `kind: "msg"` event. */
interface MessageBase {
	content: string | null;
	externalId?: string;
	quotedText?: string;
	quotedRole?: string;
	overrides?: string[];
	command?: string | null;
}

/** Assistant rows must carry `agent` and `runId` so history filtering, templates,
 * and trace lookup can all rely on the link. User rows have neither. */
type AppendMessageInput =
	| (MessageBase & { role: "user" })
	| (MessageBase & {
			role: "assistant";
			agent: string;
			runId: string;
			failed?: boolean;
	  });

interface ConversationStore {
	appendMessage(msg: AppendMessageInput): Promise<string>;
	appendAck(messageId: string, externalId: string): Promise<void>;
	appendReaction(reaction: {
		messageExternalId: string;
		emoji: string;
		senderId: string;
		fromMe: boolean;
	}): Promise<void>;
	appendTrace(
		runId: string,
		agent: string,
		trigger: Trigger,
		steps: TraceStep[],
	): Promise<void>;
	appendBreak(): Promise<void>;
	getConversation(): Promise<ConversationMessage[]>;
	readAllMessages(): Promise<ConversationMessage[]>;
	searchConversation(opts: {
		query?: string;
		around?: string;
		before?: string;
		after?: string;
		limit?: number;
		contextWindow?: number;
	}): Promise<ConversationMessage[]>;
	findByExternalId(externalId: string): { messageId: string } | null;
	/** Indexed by `runId` — the new stable id for an agent run. */
	getTraces(): Promise<Map<string, AgentTrace>>;
	rebuildIndexes(): Promise<void>;
}

// -- Event schemas & types --

const ConversationMessageEventSchema = z.object({
	kind: z.literal("msg"),
	id: z.string(),
	role: z.enum(["user", "assistant"]),
	content: z.string().nullable(),
	createdAt: z.string(),
	externalId: z.string().optional(),
	quotedText: z.string().optional(),
	quotedRole: z.string().optional(),
	overrides: z.array(z.string()).optional(),
	command: z.string().nullable().optional(),
	/** Assistant rows: the agent that produced the reply. */
	agent: z.string().optional(),
	/** Assistant rows: the run that produced the reply (links to the trace). */
	runId: z.string().optional(),
	/** Assistant rows: the turn ended in an error (used by /retry). */
	failed: z.boolean().optional(),
});

const ConversationAckEventSchema = z.object({
	kind: z.literal("ack"),
	messageId: z.string(),
	externalId: z.string(),
});

const ConversationReactionEventSchema = z.object({
	kind: z.literal("reaction"),
	messageExternalId: z.string(),
	emoji: z.string(),
	senderId: z.string(),
	fromMe: z.boolean(),
});

const TraceStepSchema = z.object({
	reasoning: z.string().optional(),
	toolCalls: z
		.array(
			z.object({
				toolCallId: z.string(),
				toolName: z.string(),
				args: z.string(),
			}),
		)
		.default([]),
	toolResults: z
		.array(
			z.object({
				toolCallId: z.string(),
				toolName: z.string(),
				result: z.string(),
			}),
		)
		.default([]),
});

export type TraceStep = z.infer<typeof TraceStepSchema>;

const ConversationTraceEventSchema = z.object({
	kind: z.literal("trace"),
	/** Stable identity for the run that produced these steps. */
	runId: z.string(),
	/** Which agent produced this trace. */
	agent: z.string(),
	/** What kicked off the run. */
	trigger: TriggerSchema,
	steps: z.array(TraceStepSchema),
});

const ConversationBreakEventSchema = z.object({
	kind: z.literal("break"),
	createdAt: z.string(),
});

const ConversationEventSchema = z.discriminatedUnion("kind", [
	ConversationMessageEventSchema,
	ConversationAckEventSchema,
	ConversationReactionEventSchema,
	ConversationTraceEventSchema,
	ConversationBreakEventSchema,
]);

type ConversationMessageEvent = z.infer<typeof ConversationMessageEventSchema>;
type ConversationReactionEvent = z.infer<
	typeof ConversationReactionEventSchema
>;
type ConversationEvent = z.infer<typeof ConversationEventSchema>;

// -- Merged message type returned by getConversation --

interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	content: string | null;
	createdAt: string;
	externalId?: string;
	quotedText?: string;
	quotedRole?: string;
	overrides?: string[];
	command?: string | null;
	/** Assistant rows: the agent that produced the reply. Required for new rows. */
	agent?: string;
	/** Assistant rows: the run id (links to the trace). Required for new rows. */
	runId?: string;
	/** Assistant rows: turn ended in an error. */
	failed?: boolean;
	reactions: Array<{ emoji: string; senderId: string; fromMe: boolean }>;
}

interface AgentTrace {
	agent: string;
	trigger: Trigger;
	steps: TraceStep[];
}

interface ConversationStoreEnv {
	dataDir: string;
}

export function createConversationStore(
	env: ConversationStoreEnv,
): ConversationStore {
	const idToExternal = new Map<string, string>();
	const externalToId = new Map<string, string>();

	const conversationsDir = (): string =>
		path.join(env.dataDir, "conversations");

	function todayFilePath(): string {
		const date = localDateString(settings.timezone);
		return path.join(conversationsDir(), `${date}.jsonl`);
	}

	async function listConversationFiles(): Promise<string[]> {
		const dir = conversationsDir();
		try {
			const entries = await readdir(dir);
			return entries
				.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.map((f) => path.join(dir, f));
		} catch {
			return [];
		}
	}

	function mergeEvents(lines: string[]): ConversationMessage[] {
		const messages = new Map<string, ConversationMessage>();
		const acks = new Map<string, string>();
		const reactions: ConversationReactionEvent[] = [];
		const order: string[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const event = ConversationEventSchema.parse(JSON.parse(line));

				if (event.kind === "msg") {
					messages.set(event.id, {
						id: event.id,
						role: event.role,
						content: event.content,
						createdAt: event.createdAt,
						...(event.externalId ? { externalId: event.externalId } : {}),
						...(event.quotedText ? { quotedText: event.quotedText } : {}),
						...(event.quotedRole ? { quotedRole: event.quotedRole } : {}),
						...(event.overrides ? { overrides: event.overrides } : {}),
						...(event.command != null ? { command: event.command } : {}),
						...(event.agent ? { agent: event.agent } : {}),
						...(event.runId ? { runId: event.runId } : {}),
						...(event.failed ? { failed: true } : {}),
						reactions: [],
					});
					order.push(event.id);
				} else if (event.kind === "ack") {
					acks.set(event.messageId, event.externalId);
				} else if (event.kind === "reaction") {
					reactions.push(event);
				}
			} catch {
				log.warn("[conversation] skipping corrupt line", {
					line: line.slice(0, 100),
				});
			}
		}

		for (const [messageId, externalId] of acks) {
			const msg = messages.get(messageId);
			if (msg) msg.externalId = externalId;
		}

		const extToMsg = new Map<string, string>();
		for (const msg of messages.values()) {
			if (msg.externalId) extToMsg.set(msg.externalId, msg.id);
		}

		for (const r of reactions) {
			const msgId = extToMsg.get(r.messageExternalId);
			if (!msgId) continue;
			const msg = messages.get(msgId);
			if (!msg) continue;
			const existing = msg.reactions.findIndex(
				(rx) => rx.senderId === r.senderId,
			);
			if (r.emoji === "") {
				if (existing >= 0) msg.reactions.splice(existing, 1);
			} else if (existing >= 0) {
				msg.reactions[existing] = {
					emoji: r.emoji,
					senderId: r.senderId,
					fromMe: r.fromMe,
				};
			} else {
				msg.reactions.push({
					emoji: r.emoji,
					senderId: r.senderId,
					fromMe: r.fromMe,
				});
			}
		}

		return order
			.map((id) => messages.get(id))
			.filter((x): x is ConversationMessage => Boolean(x));
	}

	async function ensureDir(): Promise<void> {
		await mkdir(conversationsDir(), { recursive: true });
	}

	async function appendEvent(event: ConversationEvent): Promise<void> {
		await ensureDir();
		await appendFile(todayFilePath(), `${JSON.stringify(event)}\n`);
	}

	async function appendMessage(msg: AppendMessageInput): Promise<string> {
		const id = crypto.randomUUID();
		const event: ConversationMessageEvent = {
			kind: "msg",
			id,
			role: msg.role,
			content: msg.content,
			createdAt: new Date().toISOString(),
			...(msg.externalId ? { externalId: msg.externalId } : {}),
			...(msg.quotedText ? { quotedText: msg.quotedText } : {}),
			...(msg.quotedRole ? { quotedRole: msg.quotedRole } : {}),
			...(msg.overrides && msg.overrides.length > 0
				? { overrides: msg.overrides }
				: {}),
			...(msg.command ? { command: msg.command } : {}),
			...(msg.role === "assistant"
				? {
						agent: msg.agent,
						runId: msg.runId,
						...(msg.failed ? { failed: true } : {}),
					}
				: {}),
		};
		await appendEvent(event);

		idToExternal.set(id, msg.externalId ?? "");
		if (msg.externalId) externalToId.set(msg.externalId, id);

		return id;
	}

	async function appendAck(
		messageId: string,
		externalId: string,
	): Promise<void> {
		await appendEvent({ kind: "ack", messageId, externalId });
		idToExternal.set(messageId, externalId);
		externalToId.set(externalId, messageId);
	}

	async function appendReaction(reaction: {
		messageExternalId: string;
		emoji: string;
		senderId: string;
		fromMe: boolean;
	}): Promise<void> {
		await appendEvent({
			kind: "reaction",
			messageExternalId: reaction.messageExternalId,
			emoji: reaction.emoji,
			senderId: reaction.senderId,
			fromMe: reaction.fromMe,
		});
	}

	async function appendTrace(
		runId: string,
		agent: string,
		trigger: Trigger,
		steps: TraceStep[],
	): Promise<void> {
		await appendEvent({ kind: "trace", runId, agent, trigger, steps });
	}

	async function appendBreak(): Promise<void> {
		await appendEvent({ kind: "break", createdAt: new Date().toISOString() });
	}

	async function getConversation(): Promise<ConversationMessage[]> {
		const lookback = settings.agent.lookbackDays;
		const allFiles = await listConversationFiles();

		const cutoff = allFiles.length > lookback ? allFiles.length - lookback : 0;
		const relevantFiles = allFiles.slice(cutoff);

		const allLines: string[] = [];
		for (const filePath of relevantFiles) {
			try {
				const text = await readText(filePath);
				for (const line of text.split("\n")) {
					if (line.trim()) allLines.push(line);
				}
			} catch {
				// File doesn't exist or read error — skip
			}
		}

		let startIndex = 0;
		for (let i = allLines.length - 1; i >= 0; i--) {
			const line = allLines[i];
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed.kind === "break") {
					startIndex = i + 1;
					break;
				}
			} catch {
				// corrupt line — skip
			}
		}

		return mergeEvents(allLines.slice(startIndex));
	}

	async function readAllMessages(): Promise<ConversationMessage[]> {
		const allFiles = await listConversationFiles();
		const allLines: string[] = [];

		for (const filePath of allFiles) {
			try {
				const text = await readText(filePath);
				for (const line of text.split("\n")) {
					if (line.trim()) allLines.push(line);
				}
			} catch {}
		}

		return mergeEvents(allLines);
	}

	async function searchConversation(opts: {
		query?: string;
		around?: string;
		before?: string;
		after?: string;
		limit?: number;
		contextWindow?: number;
	}): Promise<ConversationMessage[]> {
		const limit = opts.limit ?? 20;
		const contextWindow = opts.contextWindow ?? 5;
		const all = await readAllMessages();

		if (opts.around) {
			const idx = all.findIndex((m) => m.externalId === opts.around);
			if (idx === -1) return [];
			const start = Math.max(0, idx - contextWindow);
			const end = Math.min(all.length, idx + contextWindow + 1);
			return all.slice(start, end);
		}

		let filtered = all;

		if (opts.after) {
			const afterDate = new Date(opts.after).getTime();
			filtered = filtered.filter(
				(m) => new Date(m.createdAt).getTime() >= afterDate,
			);
		}

		if (opts.before) {
			const beforeDate = new Date(opts.before).getTime();
			filtered = filtered.filter(
				(m) => new Date(m.createdAt).getTime() <= beforeDate,
			);
		}

		if (opts.query) {
			const q = opts.query.toLowerCase();
			filtered = filtered.filter((m) => m.content?.toLowerCase().includes(q));
		}

		return filtered.slice(-limit);
	}

	function findByExternalId(externalId: string): { messageId: string } | null {
		const messageId = externalToId.get(externalId);
		return messageId ? { messageId } : null;
	}

	async function getTraces(): Promise<Map<string, AgentTrace>> {
		const traces = new Map<string, AgentTrace>();
		const lookback = settings.agent.lookbackDays;
		const allFiles = await listConversationFiles();
		const cutoff = allFiles.length > lookback ? allFiles.length - lookback : 0;
		const relevantFiles = allFiles.slice(cutoff);

		for (const filePath of relevantFiles) {
			let text: string;
			try {
				text = await readText(filePath);
			} catch {
				continue;
			}

			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const raw = JSON.parse(line);
					if (raw.kind === "trace") {
						const event = ConversationTraceEventSchema.parse(raw);
						traces.set(event.runId, {
							agent: event.agent,
							trigger: event.trigger,
							steps: event.steps,
						});
					}
				} catch {
					// skip corrupt lines
				}
			}
		}

		return traces;
	}

	async function rebuildIndexes(): Promise<void> {
		idToExternal.clear();
		externalToId.clear();

		const allFiles = await listConversationFiles();

		for (const filePath of allFiles) {
			let text: string;
			try {
				text = await readText(filePath);
			} catch {
				continue;
			}

			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = ConversationEventSchema.parse(JSON.parse(line));

					if (event.kind === "msg") {
						if (event.externalId) {
							idToExternal.set(event.id, event.externalId);
							externalToId.set(event.externalId, event.id);
						}
					} else if (event.kind === "ack") {
						idToExternal.set(event.messageId, event.externalId);
						externalToId.set(event.externalId, event.messageId);
					}
				} catch {
					log.warn("[conversation] skipping corrupt line in index rebuild", {
						line: line.slice(0, 100),
					});
				}
			}
		}

		log.info(`[conversation] indexes rebuilt (${idToExternal.size} messages)`);
	}

	return {
		appendMessage,
		appendAck,
		appendReaction,
		appendTrace,
		appendBreak,
		getConversation,
		readAllMessages,
		searchConversation,
		findByExternalId,
		getTraces,
		rebuildIndexes,
	};
}

// ── Module-level instance + delegators ────────────────────────────────────

let _store: ConversationStore | null = null;

export function initHistoryStore(env: ConversationStoreEnv): void {
	_store = createConversationStore(env);
}

function store(): ConversationStore {
	if (!_store) throw new Error("[history] store not initialized");
	return _store;
}

export function appendMessage(msg: AppendMessageInput): Promise<string> {
	return store().appendMessage(msg);
}

export function appendAck(
	messageId: string,
	externalId: string,
): Promise<void> {
	return store().appendAck(messageId, externalId);
}

export function appendReaction(reaction: {
	messageExternalId: string;
	emoji: string;
	senderId: string;
	fromMe: boolean;
}): Promise<void> {
	return store().appendReaction(reaction);
}

export function appendTrace(
	runId: string,
	agent: string,
	trigger: Trigger,
	steps: TraceStep[],
): Promise<void> {
	return store().appendTrace(runId, agent, trigger, steps);
}

export function appendBreak(): Promise<void> {
	return store().appendBreak();
}

export function getConversation(): Promise<ConversationMessage[]> {
	return store().getConversation();
}

export function readAllMessages(): Promise<ConversationMessage[]> {
	return store().readAllMessages();
}

export function searchConversation(opts: {
	query?: string;
	around?: string;
	before?: string;
	after?: string;
	limit?: number;
	contextWindow?: number;
}): Promise<ConversationMessage[]> {
	return store().searchConversation(opts);
}

export function findByExternalId(
	externalId: string,
): { messageId: string } | null {
	return store().findByExternalId(externalId);
}

export function getTraces(): Promise<Map<string, AgentTrace>> {
	return store().getTraces();
}

export function rebuildIndexes(): Promise<void> {
	return store().rebuildIndexes();
}
