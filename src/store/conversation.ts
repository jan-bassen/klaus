import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/config";
import { log } from "@/logger";
import { type ConversationStore, getServices } from "@/services";
import { localDateString } from ".";

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

const ConversationSupersedeEventSchema = z.object({
	kind: z.literal("supersede"),
	messageId: z.string(),
	supersededAt: z.string(),
	reason: z.string().optional(),
});

export const ConversationEventSchema = z.discriminatedUnion("kind", [
	ConversationMessageEventSchema,
	ConversationAckEventSchema,
	ConversationReactionEventSchema,
	ConversationTraceEventSchema,
	ConversationBreakEventSchema,
	ConversationSupersedeEventSchema,
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
export type ConversationSupersedeEvent = z.infer<
	typeof ConversationSupersedeEventSchema
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
	overrides?: string[];
	command?: string | null;
	reactions: Array<{ emoji: string; senderId: string; fromMe: boolean }>;
}

export interface ConversationStoreEnv {
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
		const superseded = new Set<string>();
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
						reactions: [],
					});
					order.push(event.id);
				} else if (event.kind === "ack") {
					acks.set(event.messageId, event.externalId);
				} else if (event.kind === "reaction") {
					reactions.push(event);
				} else if (event.kind === "supersede") {
					superseded.add(event.messageId);
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
			.filter((id) => !superseded.has(id))
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

	async function appendMessage(msg: {
		role: "user" | "assistant";
		content: string | null;
		externalId?: string;
		quotedText?: string;
		quotedRole?: string;
		overrides?: string[];
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
			...(msg.overrides && msg.overrides.length > 0
				? { overrides: msg.overrides }
				: {}),
			...(msg.command ? { command: msg.command } : {}),
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
		messageId: string,
		steps: TraceStep[],
	): Promise<void> {
		await appendEvent({ kind: "trace", messageId, steps });
	}

	async function appendBreak(): Promise<void> {
		await appendEvent({ kind: "break", createdAt: new Date().toISOString() });
	}

	async function appendSupersede(
		messageId: string,
		reason?: string,
	): Promise<void> {
		await appendEvent({
			kind: "supersede",
			messageId,
			supersededAt: new Date().toISOString(),
			...(reason ? { reason } : {}),
		});
	}

	async function getConversation(): Promise<ConversationMessage[]> {
		const lookback = settings.context.conversationLookbackDays;
		const allFiles = await listConversationFiles();

		const cutoff = allFiles.length > lookback ? allFiles.length - lookback : 0;
		const relevantFiles = allFiles.slice(cutoff);

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

	async function readAllMessages(): Promise<ConversationMessage[]> {
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

	function resolveExternalId(externalId: string): string | null {
		return externalToId.get(externalId) ?? null;
	}

	function resolveMessageId(messageId: string): string | null {
		return idToExternal.get(messageId) ?? null;
	}

	async function getTraces(): Promise<Map<string, TraceStep[]>> {
		const traces = new Map<string, TraceStep[]>();
		const superseded = new Set<string>();
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
					if (raw.kind === "trace") {
						const event = ConversationTraceEventSchema.parse(raw);
						traces.set(event.messageId, event.steps);
					} else if (raw.kind === "supersede") {
						const event = ConversationSupersedeEventSchema.parse(raw);
						superseded.add(event.messageId);
					}
				} catch {
					// skip corrupt lines
				}
			}
		}

		for (const id of superseded) traces.delete(id);
		return traces;
	}

	async function rebuildIndexes(): Promise<void> {
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

		log.info(`[conversation] indexes rebuilt (${idToExternal.size} messages)`);
	}

	return {
		appendMessage,
		appendAck,
		appendReaction,
		appendTrace,
		appendBreak,
		appendSupersede,
		getConversation,
		readAllMessages,
		searchConversation,
		findByExternalId,
		resolveExternalId,
		resolveMessageId,
		getTraces,
		rebuildIndexes,
	};
}

// Module-level delegators — preserve existing public API, route to registered instance.

export function appendMessage(msg: {
	role: "user" | "assistant";
	content: string | null;
	externalId?: string;
	quotedText?: string;
	quotedRole?: string;
	overrides?: string[];
	command?: string | null;
}): Promise<string> {
	return getServices().conversations.appendMessage(msg);
}

export function appendAck(
	messageId: string,
	externalId: string,
): Promise<void> {
	return getServices().conversations.appendAck(messageId, externalId);
}

export function appendReaction(reaction: {
	messageExternalId: string;
	emoji: string;
	senderId: string;
	fromMe: boolean;
}): Promise<void> {
	return getServices().conversations.appendReaction(reaction);
}

export function appendTrace(
	messageId: string,
	steps: TraceStep[],
): Promise<void> {
	return getServices().conversations.appendTrace(messageId, steps);
}

export function appendBreak(): Promise<void> {
	return getServices().conversations.appendBreak();
}

export function appendSupersede(
	messageId: string,
	reason?: string,
): Promise<void> {
	return getServices().conversations.appendSupersede(messageId, reason);
}

export function getConversation(): Promise<ConversationMessage[]> {
	return getServices().conversations.getConversation();
}

export function readAllMessages(): Promise<ConversationMessage[]> {
	return getServices().conversations.readAllMessages();
}

export function searchConversation(opts: {
	query?: string;
	around?: string;
	before?: string;
	after?: string;
	limit?: number;
	contextWindow?: number;
}): Promise<ConversationMessage[]> {
	return getServices().conversations.searchConversation(opts);
}

export function findByExternalId(
	externalId: string,
): { messageId: string } | null {
	return getServices().conversations.findByExternalId(externalId);
}

export function resolveExternalId(externalId: string): string | null {
	return getServices().conversations.resolveExternalId(externalId);
}

export function resolveMessageId(messageId: string): string | null {
	return getServices().conversations.resolveMessageId(messageId);
}

export function getTraces(): Promise<Map<string, TraceStep[]>> {
	return getServices().conversations.getTraces();
}

export function rebuildIndexes(): Promise<void> {
	return getServices().conversations.rebuildIndexes();
}
