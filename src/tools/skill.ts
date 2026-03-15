import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { log } from "@/logger";
import type { ToolDefinition } from "@/types";

export interface SkillMeta {
	name: string;
	description: string;
}

/** Registry of loaded skill metadata, keyed by skill name. Populated at startup. */
export const skillRegistry = new Map<string, SkillMeta>();

/**
 * Scan a directory for *.md skill files, parse frontmatter, and populate skillRegistry.
 * Call once at startup from index.ts.
 */
export async function loadSkills(skillsDir: string): Promise<void> {
	const glob = new Bun.Glob("*.md");
	for await (const file of glob.scan({ cwd: skillsDir })) {
		const raw = await Bun.file(`${skillsDir}/${file}`).text();
		const match = raw.match(/^---\n([\s\S]*?)\n---/);
		const name = file.replace(/\.md$/, "");

		let description = name;
		if (match) {
			const front = parseYaml(match[1] ?? "") as Record<string, unknown>;
			if (typeof front.description === "string" && front.description) {
				description = front.description;
			}
		}

		skillRegistry.set(name, { name, description });
		log.debug("[skill] loaded metadata", { name, description });
	}
}

/**
 * Build a skill.get tool scoped to the given skill names.
 * Only registered for agents that declare `skills:` in frontmatter.
 */
export function buildSkillTool(
	skillNames: string[],
	skillsDir: string,
): ToolDefinition {
	const entries = skillNames.map((name) => {
		const meta = skillRegistry.get(name);
		return meta ? `${name} (${meta.description})` : name;
	});
	const description = `Load a reference document by name. Available: ${entries.join(", ")}. Use only when you need specific reference material for the current task.`;

	const inputSchema = z.object({
		name: z.enum(skillNames as [string, ...string[]]),
	});

	return {
		name: "skill.get",
		description,
		inputSchema,
		execute: async ({ name }) => {
			const filePath = `${skillsDir}/${name}.md`;
			try {
				const raw = await Bun.file(filePath).text();
				// Strip frontmatter — return only the content body
				return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
			} catch (err) {
				log.warn("[skill.get] failed to read skill file", {
					skill: name,
					path: filePath,
					error: err instanceof Error ? err.message : String(err),
				});
				return {
					error: `Failed to load skill "${name}": file not found or unreadable`,
				};
			}
		},
		kind: "builtin",
		capability: "resource",
	};
}
