import type { InboundMessage } from "@/types";

export interface Command {
	name: string;
	description: string;
	execute: (msg: InboundMessage, args: string[]) => Promise<void>;
}

export class CommandRegistry {
	private commands = new Map<string, Command>();

	register(command: Command): void {
		this.commands.set(command.name, command);
	}

	get(name: string): Command | undefined {
		return this.commands.get(name);
	}

	has(name: string): boolean {
		return this.commands.has(name);
	}
}

export const registry = new CommandRegistry();

/**
 * Parse a /command from a message.
 * Returns null if the message is not a command.
 */
export function parseCommand(
	msg: InboundMessage,
): { name: string; args: string[] } | null {
	if (!msg.text || !msg.text.startsWith("/")) return null;

	const tokens = msg.text.split(/\s+/).filter(Boolean);
	const raw = tokens[0]?.slice(1);
	if (!raw) return null;

	return {
		name: raw.toLowerCase(),
		args: tokens.slice(1),
	};
}
