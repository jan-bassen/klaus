import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { log } from "@/logger";

export const FlagFrontmatterSchema = z.object({
	description: z.string().min(1).optional(),
});

export interface FlagMeta {
	name: string;
	description: string;
	prompt: string;
}

/** Registry of loaded flag metadata, keyed by flag name. Populated at startup. */
export const flagRegistry = new Map<string, FlagMeta>();

/** Returns the set of recognized flag names. */
export function getKnownFlags(): string[] {
	return [...flagRegistry.keys()];
}

/**
 * Scan a directory for *.md flag files, parse frontmatter, and populate flagRegistry.
 * Call once at startup from index.ts.
 */
export async function loadFlags(flagsDir: string): Promise<void> {
	const glob = new Bun.Glob("*.md");
	for await (const file of glob.scan({ cwd: flagsDir })) {
		const raw = await Bun.file(`${flagsDir}/${file}`).text();
		const name = file.replace(/\.md$/, "");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);

		let description = name;
		let prompt = raw.trim();

		if (match) {
			const front = FlagFrontmatterSchema.safeParse(parseYaml(match[1] ?? ""));
			if (front.success && front.data.description) {
				description = front.data.description;
			}
			prompt = raw.slice(match[0].length).trim();
		}

		flagRegistry.set(name, { name, description, prompt });
		log.debug("[flags] loaded flag", { name, description });
	}
}
