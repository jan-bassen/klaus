import type { Command } from "@/commands";
import { getDefaultAgent } from "@/core/defaults";
import { getActiveJobs } from "@/core/queue";
import { settings } from "@/settings";
import type { InboundMessage } from "@/types";
import { enqueueMessage } from "@/whatsapp/send";

export const statusCommand: Command = {
	name: "status",
	description: "Show current agent and system status",
	async execute(msg: InboundMessage, _args: string[]): Promise<void> {
		try {
			const [jobs, noteCount] = await Promise.all([
				getActiveJobs(),
				countVaultNotes(),
			]);

			const agent = getDefaultAgent(msg.chatId);

			enqueueMessage({
				chatId: msg.chatId,
				content: `*Klaus status*\nAgent: @${agent}\nJobs: ${jobs.length} active\nVault: ${noteCount} notes`,
				dedupKey: `${msg.id}:status`,
			});
		} catch {
			enqueueMessage({
				chatId: msg.chatId,
				content: "Status unavailable.",
				dedupKey: `${msg.id}:status-error`,
			});
		}
	},
};

async function countVaultNotes(): Promise<number> {
	const glob = new Bun.Glob("**/*.md");
	let count = 0;
	for await (const _ of glob.scan({ cwd: settings.vault.dir })) {
		count++;
	}
	return count;
}
