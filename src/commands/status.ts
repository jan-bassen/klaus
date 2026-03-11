import type { Command } from "@/commands";
import { getDefaultAgent } from "@/core/defaults";
import { QUERIES } from "@/db/queries";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const statusCommand: Command = {
	name: "status",
	description: "Show current agent and system status",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const [tasksResult, nodeCountResult] = await Promise.all([
				QUERIES.active_tasks?.({ chatId: msg.chatId }),
				QUERIES.node_count?.({}),
			]);

			const tasks = tasksResult as { id: string }[];
			const { count } = nodeCountResult as { count: number };
			const agent = getDefaultAgent(msg.chatId);

			enqueueMessage({
				chatId: msg.chatId,
				content: `*Klaus status*\nAgent: @${agent}\nTasks: ${tasks.length} active\nMemory: ${count} nodes`,
				dedupKey: `${msg.id}:status`,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Status unavailable — database error.",
				dedupKey: `${msg.id}:status-error`,
			});
		}
	},
};
