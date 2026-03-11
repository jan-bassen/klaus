import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { files, messages, nodes, tasks } from "@/db/schema";

type QueryFn = (params: Record<string, unknown>) => Promise<unknown>;

export const QUERIES: Record<string, QueryFn> = {
	recent_messages: async (params) => {
		const chatId = params.chatId as string | undefined;
		const limit = typeof params.limit === "number" ? params.limit : 20;
		return db
			.select({
				id: messages.id,
				role: messages.role,
				content: messages.content,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(chatId ? eq(messages.chatId, chatId) : undefined)
			.orderBy(desc(messages.createdAt))
			.limit(limit);
	},

	active_tasks: async (params) => {
		const chatId = params.chatId as string | undefined;
		const filter = chatId
			? and(eq(tasks.status, "running"), eq(tasks.chatId, chatId))
			: eq(tasks.status, "running");
		return db
			.select()
			.from(tasks)
			.where(filter)
			.orderBy(desc(tasks.createdAt))
			.limit(50);
	},

	node_count: async () => {
		const rows = await db.select({ id: nodes.id }).from(nodes);
		return { count: rows.length };
	},

	file_list: async (params) => {
		const limit = typeof params.limit === "number" ? params.limit : 50;
		return db
			.select({
				id: files.id,
				path: files.path,
				mimeType: files.mimeType,
				sizeBytes: files.sizeBytes,
				createdAt: files.createdAt,
			})
			.from(files)
			.orderBy(desc(files.createdAt))
			.limit(limit);
	},
};
