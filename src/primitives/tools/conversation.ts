import { z } from "zod";
import { settings } from "../../infra/config.ts";
import { searchConversation } from "../../infra/store/history.ts";
import type { ToolDefinition } from "./index.ts";

function formatMessageTimestamp(date: Date): string {
	const day = date.toLocaleDateString(settings.locale, {
		day: "2-digit",
		month: "2-digit",
		timeZone: settings.timezone,
	});
	const time = date.toLocaleTimeString(settings.locale, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: settings.timezone,
	});
	return `${day} ${time}`;
}

function formatChatMessage(opts: {
	messageId: string;
	role: string;
	timestamp: string;
	body: string;
}): string {
	return `messageId: ${opts.messageId}\nrole: ${opts.role}\ntime: ${opts.timestamp}\n${opts.body}`;
}

const schema = z.object({
	text: z
		.string()
		.optional()
		.describe("Case-insensitive text to search for in message content"),
	aroundMessageId: z
		.string()
		.optional()
		.describe(
			"WhatsApp messageId from search_messages results. Returns nearby messages around that message.",
		),
	after: z
		.string()
		.optional()
		.describe("ISO timestamp — only return messages after this time"),
	before: z
		.string()
		.optional()
		.describe("ISO timestamp — only return messages before this time"),
	limit: z
		.number({ error: "limit must be a whole number." })
		.int({ error: "limit must be a whole number." })
		.min(1, { error: "limit must be at least 1." })
		.optional()
		.describe("Max results to return (default 20)"),
	contextMessages: z
		.number({ error: "contextMessages must be a whole number." })
		.int({ error: "contextMessages must be a whole number." })
		.nonnegative({ error: "contextMessages must be 0 or greater." })
		.optional()
		.describe(
			"Messages before and after aroundMessageId to return (default 5)",
		),
});

export const searchMessagesTool: ToolDefinition<typeof schema> = {
	name: "search_messages",
	description:
		"Search WhatsApp conversation history. Use to find past messages by text, get context around a messageId, or filter by time range.",
	inputSchema: schema,
	execute: async (
		{ text, aroundMessageId, after, before, limit, contextMessages },
		context,
	) => {
		const results = await searchConversation({
			...(text ? { query: text } : {}),
			...(aroundMessageId ? { around: aroundMessageId } : {}),
			...(after ? { after } : {}),
			...(before ? { before } : {}),
			...(limit != null ? { limit } : {}),
			...(contextMessages != null ? { contextWindow: contextMessages } : {}),
		});

		if (results.length === 0) {
			return { results: [], message: "No messages found." };
		}

		const agentLabel = context.agent?.name ?? "assistant";
		const formatted = results.map((msg) => {
			const role = msg.role === "user" ? "user" : agentLabel;
			const ts = formatMessageTimestamp(new Date(msg.createdAt));
			return formatChatMessage({
				messageId: msg.externalId ?? msg.id,
				role,
				timestamp: ts,
				body: msg.content ?? "",
			});
		});

		return {
			count: results.length,
			messages: formatted.join("\n\n"),
		};
	},
};
