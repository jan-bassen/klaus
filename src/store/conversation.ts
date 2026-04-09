import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/logger";
import { settings } from "@/settings";
import { localDateString } from "./date-utils";

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
	flags: z.array(z.string()).optional(),
	command: z.string().nullable().optional(),
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
	messageId: z.string(),
	steps: z.array(TraceStepSchema),
});

const ConversationBreakEventSchema = z.object({
	kind: z.literal("break"),
	createdAt: z.string(),
});

export const ConversationEventSchema = z.discriminatedUnion("kind", [
	ConversationMessageEventSchema,
	ConversationAckEventSchema,
	ConversationReactionEventSchema,
	ConversationTraceEventSchema,
	ConversationBreakEventSchema,
]);

export type ConversationMessageEvent = z.infer<
	typeof ConversationMessageEventSchema
>;
export type ConversationAckEvent = z.infer<typeof ConversationAckEventSchema>;
export type ConversationReactionEvent = z.infer<
	typeof ConversationReactionEventSchema
>;
export type ConversationBreakEvent = z.infer<
	typeof ConversationBreakEventSchema
>;
type ConversationEvent = z.infer<typeof ConversationEventSchema>;

// -- Merged message type returned by getConversation --

export interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	content: string | null;
	createdAt: string;
	externalId?: string;
	quotedText?: string;
	quotedRole?: string;
	flags?: string[];
	command?: string | null;
	reactions: Array<{ emoji: string; senderId: string; fromMe: boolean }>;
}

// -- In-memory indexes --

/** Map<messageId, externalId> — populated from msg + ack events */
const idToExternal = new Map<string, string>();
/** Map<externalId, messageId> — reverse index */
const externalToId = new Map<string, string>();

// -- File layout --

function conversationsDir(): string {
	return path.join(settings.dataDir, "conversations");
}

function todayFilePath(): string {
	const date = localDateString(settings.timezone);
	return path.join(conversationsDir(), `${date}.jsonl`);
}

/** List all YYYY-MM-DD.jsonl files in conversations/, sorted chronologically. */
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

// -- Event merging --

/** Parse JSONL lines, merge acks + reactions into ordered messages. */
function mergeEvents(lines: string[]): ConversationMessage[] {
	const messages = new Map<string, ConversationMessage>();
	const acks = new Map<string, string>(); // messageId → externalId
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
					...(event.flags ? { flags: event.flags } : {}),
					...(event.command != null ? { command: event.command } : {}),
					reactions: [],
				});
				order.push(event.id);
			} else if (event.kind === "ack") {
				acks.set(event.messageId, event.externalId);
			} else if (event.kind === "reaction") {
				reactions.push(event);
			}
			// break and trace events are silently skipped
		} catch {
			log.warn("[conversation] skipping corrupt line", {
				line: line.slice(0, 100),
			});
		}
	}

	// Apply acks
	for (const [messageId, externalId] of acks) {
		const msg = messages.get(messageId);
		if (msg) msg.externalId = externalId;
	}

	// Build externalId → messageId map for reaction attachment
	const extToMsg = new Map<string, string>();
	for (const msg of messages.values()) {
		if (msg.externalId) extToMsg.set(msg.externalId, msg.id);
	}

	// Apply reactions (latest per sender wins)
	for (const r of reactions) {
		const msgId = extToMsg.get(r.messageExternalId);
		if (!msgId) continue;
		const msg = messages.get(msgId);
		if (!msg) continue;
		const existing = msg.reactions.findIndex(
			(rx) => rx.senderId === r.senderId,
		);
		if (r.emoji === "") {
			// Removal
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

// -- Write helpers --

async function ensureDir(): Promise<void> {
	await mkdir(conversationsDir(), { recursive: true });
}

async function appendEvent(event: ConversationEvent): Promise<void> {
	await ensureDir();
	await appendFile(todayFilePath(), `${JSON.stringify(event)}\n`);
}

// -- Public API: writes --

/** Append a message event. Returns the generated UUID. */
export async function appendMessage(msg: {
	role: "user" | "assistant";
	content: string | null;
	externalId?: string;
	quotedText?: string;
	quotedRole?: string;
	flags?: string[];
	command?: string | null;
}): Promise<string> {
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
		...(msg.flags && msg.flags.length > 0 ? { flags: msg.flags } : {}),
		...(msg.command ? { command: msg.command } : {}),
	};
	await appendEvent(event);

	idToExternal.set(id, msg.externalId ?? "");
	if (msg.externalId) externalToId.set(msg.externalId, id);

	return id;
}

/** Append an ack event (externalId backfill from WhatsApp delivery confirmation). */
export async function appendAck(
	messageId: string,
	externalId: string,
): Promise<void> {
	await appendEvent({ kind: "ack", messageId, externalId });
	idToExternal.set(messageId, externalId);
	externalToId.set(externalId, messageId);
}

/** Append a reaction event. */
export async function appendReaction(reaction: {
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

/** Append a trace event (agent reasoning + tool calls for a turn). */
export async function appendTrace(
	messageId: string,
	steps: TraceStep[],
): Promise<void> {
	await appendEvent({ kind: "trace", messageId, steps });
}

/** Append a break marker. Messages before the last break are excluded from context. */
export async function appendBreak(): Promise<void> {
	await appendEvent({ kind: "break", createdAt: new Date().toISOString() });
}

// -- Public API: reads --

/**
 * Load recent conversation messages, respecting break markers.
 * Reads day-partitioned files backwards from today up to lookbackDays.
 * Stops at the most recent break marker — only messages after it are returned.
 */
export async function getConversation(): Promise<ConversationMessage[]> {
	const lookback = settings.context.conversationLookbackDays;
	const allFiles = await listConversationFiles();

	// Take files within lookback window (most recent N days)
	const cutoff = allFiles.length > lookback ? allFiles.length - lookback : 0;
	const relevantFiles = allFiles.slice(cutoff);

	// Read all lines from relevant files in chronological order
	const allLines: string[] = [];
	for (const filePath of relevantFiles) {
		try {
			const text = await Bun.file(filePath).text();
			for (const line of text.split("\n")) {
				if (line.trim()) allLines.push(line);
			}
		} catch {
			// File doesn't exist or read error — skip
		}
	}

	// Find the last break marker and discard everything before it
	let startIndex = 0;
	for (let i = allLines.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(allLines[i]!);
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

/** Read and merge all JSONL files (all time), returning messages sorted by createdAt. */
export async function readAllMessages(): Promise<ConversationMessage[]> {
	const allFiles = await listConversationFiles();
	const allLines: string[] = [];

	for (const filePath of allFiles) {
		try {
			const text = await Bun.file(filePath).text();
			for (const line of text.split("\n")) {
				if (line.trim()) allLines.push(line);
			}
		} catch {}
	}

	return mergeEvents(allLines);
}

/** Search conversation history across all JSONL files. */
export async function searchConversation(opts: {
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

	// "around" mode: find target message and return context window around it
	if (opts.around) {
		const idx = all.findIndex((m) => m.externalId === opts.around);
		if (idx === -1) return [];
		const start = Math.max(0, idx - contextWindow);
		const end = Math.min(all.length, idx + contextWindow + 1);
		return all.slice(start, end);
	}

	// Filter mode
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

	// Return most recent matches
	return filtered.slice(-limit);
}

/** Find a message by its WhatsApp externalId (in-memory lookup). */
export function findByExternalId(
	externalId: string,
): { messageId: string } | null {
	const messageId = externalToId.get(externalId);
	return messageId ? { messageId } : null;
}

/** Get the internal message ID for a WhatsApp externalId. */
export function resolveExternalId(externalId: string): string | null {
	return externalToId.get(externalId) ?? null;
}

/** Get the WhatsApp externalId for an internal message ID. */
export function resolveMessageId(messageId: string): string | null {
	return idToExternal.get(messageId) ?? null;
}

/** Read all trace events from recent files, keyed by messageId. */
export async function getTraces(): Promise<Map<string, TraceStep[]>> {
	const traces = new Map<string, TraceStep[]>();
	const lookback = settings.context.conversationLookbackDays;
	const allFiles = await listConversationFiles();
	const cutoff = allFiles.length > lookback ? allFiles.length - lookback : 0;
	const relevantFiles = allFiles.slice(cutoff);

	for (const filePath of relevantFiles) {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch {
			continue;
		}

		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const raw = JSON.parse(line);
				if (raw.kind !== "trace") continue;
				const event = ConversationTraceEventSchema.parse(raw);
				traces.set(event.messageId, event.steps);
			} catch {
				// skip corrupt lines
			}
		}
	}

	return traces;
}

/**
 * Rebuild in-memory indexes from all conversation files.
 * Call once at startup.
 */
export async function rebuildIndexes(): Promise<void> {
	idToExternal.clear();
	externalToId.clear();

	const allFiles = await listConversationFiles();

	for (const filePath of allFiles) {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
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

	log.info("[conversation] indexes rebuilt", {
		messages: idToExternal.size,
	});
}

/** Clear in-memory indexes. Used by tests. */
export function _clearIndexesForTest(): void {
	idToExternal.clear();
	externalToId.clear();
}
