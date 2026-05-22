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
	label: string;
	role: string;
	timestamp: string;
	body: string;
}): string {
	return `[#${opts.label} | ${opts.role} | ${opts.timestamp}]\n${opts.body}`;
}

const schema = z.object({
	query: z
		.string()
		.optional()
		.describe("Case-insensitive text to search for in message content"),
	around_message_id: z
		.string()
		.optional()
		.describe(
			"WhatsApp externalId — returns messages surrounding this one. Use with message refs from conversation history.",
		),
	after: z
		.string()
		.optional()
		.describe("ISO timestamp — only return messages after this time"),
	before: z
		.string()
		.optional()
		.describe("ISO timestamp — only return messages before this time"),
	limit: z.number().optional().describe("Max results to return (default 20)"),
	context_window: z
		.number()
		.optional()
		.describe("Messages before/after for around_message_id mode (default 5)"),
});

export const conversationTool: ToolDefinition<typeof schema> = {
	name: "conversation",
	description:
		"Search conversation history across current and archived messages. Use to find past messages by text content, get context around a specific message, or filter by time range.",
	inputSchema: schema,
	execute: async (
		{ query, around_message_id, after, before, limit, context_window },
		context,
	) => {
		const results = await searchConversation({
			...(query ? { query } : {}),
			...(around_message_id ? { around: around_message_id } : {}),
			...(after ? { after } : {}),
			...(before ? { before } : {}),
			...(limit != null ? { limit } : {}),
			...(context_window != null ? { contextWindow: context_window } : {}),
		});

		if (results.length === 0) {
			return { results: [], message: "No messages found." };
		}

		const agentLabel = context.agent?.name ?? "assistant";
		const formatted = results.map((msg, i) => {
			const role = msg.role === "user" ? "user" : agentLabel;
			const ts = formatMessageTimestamp(new Date(msg.createdAt));
			return formatChatMessage({
				label: String(i + 1),
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
