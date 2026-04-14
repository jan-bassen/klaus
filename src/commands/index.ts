import { z } from "zod";
import { log } from "@/logger";
import type { InboundMessage } from "@/types";

export interface Command {
	name: string;
	aliases?: string[];
	description: string;
	execute: (msg: InboundMessage, args: string[]) => Promise<void>;
}

export class CommandRegistry {
	private commands = new Map<string, Command>();

	register(command: Command): void {
		this.commands.set(command.name, command);
		if (command.aliases) {
			for (const alias of command.aliases) {
				this.commands.set(alias, command);
			}
		}
	}

	get(name: string): Command | undefined {
		return this.commands.get(name);
	}

	has(name: string): boolean {
		return this.commands.has(name);
	}

	getAll(): Command[] {
		return [...new Set(this.commands.values())];
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

const CommandShape = z
	.object({
		name: z.string(),
		description: z.string(),
		execute: z.function(),
	})
	.passthrough();

function isCommand(x: unknown): x is Command {
	return CommandShape.safeParse(x).success;
}

/**
 * Scan a directory for .ts files and register every exported Command.
 * Follows the same auto-discovery pattern as loadAllTools() and loadContextVariables().
 */
export async function loadCommands(commandsDir: string): Promise<void> {
	const glob = new Bun.Glob("*.ts");
	for await (const file of glob.scan({ cwd: commandsDir })) {
		if (file === "index.ts") continue;
		try {
			const mod = (await import(`${commandsDir}/${file}`)) as Record<
				string,
				unknown
			>;
			for (const exported of Object.values(mod)) {
				if (isCommand(exported)) {
					registry.register(exported);
					log.debug(`[commands] loaded: /${exported.name}`);
				}
			}
		} catch (err) {
			log.error(`[commands] failed to load: ${file}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
