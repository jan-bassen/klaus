import { config } from "@/config";
import {
	type ConversationMessage,
	getConversation,
} from "@/store/conversation";
import type { ContextQuery, ContextResult, TurnContext } from "@/types";

// Rough token estimate: 1 token ≈ 4 characters.
const CHARS_PER_TOKEN = 4;
const MAX_QUOTED_CHARS = 500;
const MAX_MESSAGE_CHARS = 1000;

/** Formats a message timestamp using the configured locale and timezone. */
export function formatMessageTimestamp(date: Date): string {
	const day = date.toLocaleDateString(config.locale, {
		day: "2-digit",
		month: "2-digit",
		timeZone: config.timezone,
	});
	const time = date.toLocaleTimeString(config.locale, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: config.timezone,
	});
	return `${day} ${time}`;
}

/** Renders the header line for a chat message: [#label | role | timestamp] */
export function formatChatHeader(
	label: string,
	role: string,
	timestamp: string,
): string {
	return `[#${label} | ${role} | ${timestamp}]`;
}

/** Renders a full chat message block. */
export function formatChatMessage(opts: {
	label: string;
	role: string;
	timestamp: string;
	body: string;
	quoteBlock?: string | undefined;
	reactionStr?: string | undefined;
}): string {
	const header = formatChatHeader(opts.label, opts.role, opts.timestamp);
	return `${header}\n${opts.quoteBlock ?? ""}${opts.body}${opts.reactionStr ?? ""}`;
}

/** Provides conversation: structured messages for the SDK messages array. */
export const conversationQuery: ContextQuery = {
	name: "conversation",
	priority: 3,
	run: async (turn: Omit<TurnContext, "assembled">): Promise<ContextResult> => {
		// Skip for dispatched agents — no WhatsApp conversation context.
		if (!turn.message) {
			return { tokenCount: 0, truncate: "never" };
		}

		const limit =
			turn.agent.conversationLimit ?? config.context.defaultConversationLimit;

		const allMessages = await getConversation();

		// Exclude the current inbound message from history
		const filtered = turn.message?.id
			? allMessages.filter((m) => m.externalId !== turn.message?.id)
			: allMessages;

		// Take the last N messages
		const recent = filtered.slice(-limit);

		const budget = config.context.conversationTokens;
		let tokenCount = 0;
		const included: ConversationMessage[] = [];

		// Work backwards from most recent, accumulate until budget
		for (let i = recent.length - 1; i >= 0; i--) {
			const row = recent[i];
			if (!row || !row.content) continue;
			const contentLen = Math.min(row.content.length, MAX_MESSAGE_CHARS);
			const quotedLen = row.quotedText
				? Math.min(row.quotedText.length, MAX_QUOTED_CHARS)
				: 0;
			const msgTokens = Math.ceil((contentLen + quotedLen) / CHARS_PER_TOKEN);
			if (tokenCount + msgTokens > budget) break;
			included.unshift(row);
			tokenCount += msgTokens;
		}

		const agentLabel = turn.agent?.name ?? "assistant";
		const messageRefs: Record<string, { externalId: string; role: string }> =
			{};
		const conversationMessages: Array<{
			role: "user" | "assistant";
			content: string;
		}> = [];

		for (let i = 0; i < included.length; i++) {
			const row = included[i];
			if (!row) continue;
			const label = i + 1;
			if (row.externalId) {
				messageRefs[String(label)] = {
					externalId: row.externalId,
					role: row.role,
				};
			}
			const ts = formatMessageTimestamp(new Date(row.createdAt));
			const quotedRaw = row.quotedText?.slice(0, MAX_QUOTED_CHARS) ?? null;
			const ellipsis =
				row.quotedText && row.quotedText.length > MAX_QUOTED_CHARS ? "…" : "";
			const quoteBlock = quotedRaw
				? `> ${row.quotedRole === "user" ? "user" : agentLabel}: ${quotedRaw}${ellipsis}\n`
				: "";
			const body =
				row.content && row.content.length > MAX_MESSAGE_CHARS
					? `${row.content.slice(0, MAX_MESSAGE_CHARS)}…`
					: row.content;
			const rxns = row.reactions ?? [];
			const reactionStr =
				rxns.length > 0
					? `\n[reactions: ${rxns.map((r) => (r.fromMe ? `${r.emoji} (you)` : r.emoji)).join("  ")}]`
					: "";
			const content = `[#${label} | ${ts}]\n${quoteBlock}${body ?? ""}${reactionStr}`;
			conversationMessages.push({
				role: row.role === "user" ? "user" : "assistant",
				content,
			});
		}

		return {
			tokenCount,
			truncate: "never",
			vars: {
				_conversationMessages: conversationMessages,
				_messageRefs: messageRefs,
			},
		};
	},
};
