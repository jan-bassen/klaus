import { appendFile, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "@/config";
import { log } from "@/logger";

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

export const ConversationEventSchema = z.discriminatedUnion("kind", [
	ConversationMessageEventSchema,
	ConversationAckEventSchema,
	ConversationReactionEventSchema,
	ConversationTraceEventSchema,
]);

export type ConversationMessageEvent = z.infer<
	typeof ConversationMessageEventSchema
>;
export type ConversationAckEvent = z.infer<typeof ConversationAckEventSchema>;
export type ConversationReactionEvent = z.infer<
	typeof ConversationReactionEventSchema
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

function conversationsDir(): string {
	return path.join(config.dataDir, "conversations");
}

function currentFilePath(): string {
	return path.join(conversationsDir(), "current.jsonl");
}

/** Parse JSONL lines, merge acks + reactions into ordered messages. */
function mergeEvents(text: string): ConversationMessage[] {
	const messages = new Map<string, ConversationMessage>();
	const acks = new Map<string, string>(); // messageId → externalId
	const reactions: ConversationReactionEvent[] = [];
	const order: string[] = [];

	for (const line of text.split("\n")) {
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

function archiveDir(): string {
	return path.join(conversationsDir(), "archive");
}

async function ensureDirs(): Promise<void> {
	await mkdir(conversationsDir(), { recursive: true });
	await mkdir(archiveDir(), { recursive: true });
}

async function appendEvent(event: ConversationEvent): Promise<void> {
	await ensureDirs();
	await appendFile(currentFilePath(), `${JSON.stringify(event)}\n`);
}

// -- Public API --

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

/**
 * Read current.jsonl, merge acks + reactions into messages.
 * Returns chronological list of conversation messages.
 */
export async function getConversation(): Promise<ConversationMessage[]> {
	let text: string;
	try {
		text = await Bun.file(currentFilePath()).text();
	} catch {
		return [];
	}

	return mergeEvents(text);
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

/** Rotate current.jsonl to archive/{timestamp}.jsonl and start fresh. */
export async function rotate(): Promise<void> {
	await ensureDirs();
	const current = currentFilePath();
	try {
		await Bun.file(current).text(); // Check exists
	} catch {
		return; // Nothing to rotate
	}
	const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
	const archivePath = path.join(archiveDir(), `${ts}.jsonl`);
	await rename(current, archivePath);
	idToExternal.clear();
	externalToId.clear();
	log.info("[conversation] rotated", { archivePath });
}

/**
 * Rebuild in-memory indexes from current.jsonl.
 * Call once at startup.
 */
export async function rebuildIndexes(): Promise<void> {
	idToExternal.clear();
	externalToId.clear();

	let text: string;
	try {
		text = await Bun.file(currentFilePath()).text();
	} catch {
		return; // No conversation file yet
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

	log.info("[conversation] indexes rebuilt", {
		messages: idToExternal.size,
	});
}

/** Read and merge all JSONL files (current + archive), returning messages sorted by createdAt. */
export async function readAllMessages(): Promise<ConversationMessage[]> {
	const files: string[] = [];

	// Archive files first (oldest to newest)
	try {
		const archiveFiles = await readdir(archiveDir());
		for (const f of archiveFiles.sort()) {
			if (f.endsWith(".jsonl")) {
				files.push(path.join(archiveDir(), f));
			}
		}
	} catch {
		// No archive dir yet
	}

	// Current file last
	files.push(currentFilePath());

	const allMessages: ConversationMessage[] = [];

	for (const filePath of files) {
		let text: string;
		try {
			text = await Bun.file(filePath).text();
		} catch {
			continue;
		}

		allMessages.push(...mergeEvents(text));
	}

	return allMessages;
}

/** Search conversation history across current + archived JSONL files. */
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

/** Append a trace event (agent reasoning + tool calls for a turn). */
export async function appendTrace(
	messageId: string,
	steps: TraceStep[],
): Promise<void> {
	await appendEvent({ kind: "trace", messageId, steps });
}

/** Read all trace events from current.jsonl, keyed by messageId. */
export async function getTraces(): Promise<Map<string, TraceStep[]>> {
	const traces = new Map<string, TraceStep[]>();
	let text: string;
	try {
		text = await Bun.file(currentFilePath()).text();
	} catch {
		return traces;
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

	return traces;
}

/** Clear in-memory indexes. Used by rotate() and tests. */
export function _clearIndexesForTest(): void {
	idToExternal.clear();
	externalToId.clear();
}
