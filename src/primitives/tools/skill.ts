import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { log } from "../../infra/logger.ts";
import { readText, scanFiles } from "../../infra/runtime.ts";
import type { ToolDefinition } from "./index.ts";
import { toolsetRegistry } from "./index.ts";
export const SkillFrontmatterSchema = z.object({
	description: z.string().min(1).optional(),
	tools: z.array(z.string()).default([]),
	toolsets: z.array(z.string()).default([]),
});

export interface SkillMeta {
	name: string;
	description: string;
	tools: string[];
	toolsets: string[];
}

/** Registry of loaded skill metadata, keyed by skill name. Populated at startup. */
export const skillRegistry = new Map<string, SkillMeta>();

export function parseSkillMeta(name: string, raw: string): SkillMeta {
	const match = raw.match(/^---\n([\s\S]*?)\n---/);
	let description = name;
	let tools: string[] = [];
	let toolsets: string[] = [];

	if (match) {
		const front = SkillFrontmatterSchema.safeParse(parseYaml(match[1] ?? ""));
		if (front.success) {
			if (front.data.description) description = front.data.description;
			tools = front.data.tools;
			toolsets = front.data.toolsets;
		}
	}

	return { name, description, tools, toolsets };
}

/**
 * Scan a directory for *.md skill files, parse frontmatter, and populate skillRegistry.
 * Call once at startup from index.ts.
 */
export async function loadSkills(skillsDir: string): Promise<void> {
	for await (const file of scanFiles(skillsDir, "*.md")) {
		const raw = await readText(`${skillsDir}/${file}`);
		const name = file.replace(/\.md$/, "");

		skillRegistry.set(name, parseSkillMeta(name, raw));
		log.debug(`[skill] loaded: ${name}`);
	}
}

/**
 * Build a skill_get tool scoped to the given skill names.
 * Only registered for agents that declare `skills:` in frontmatter.
 */
export function buildSkillTool(
	skillNames: string[],
	skillsDir: string,
): ToolDefinition {
	const entries = skillNames.map((name) => {
		const meta = skillRegistry.get(name);
		if (!meta) return name;
		const hasTools = meta.tools.length > 0 || meta.toolsets.length > 0;
		return `${name} (${meta.description}${hasTools ? " [+tools]" : ""})`;
	});
	const description = `Load a reference document by name. Available: ${entries.join(", ")}. Use only when you need specific reference material for the current task. Skills marked [+tools] unlock additional tools when loaded.`;

	const inputSchema = z.object({
		name: z.enum(skillNames as [string, ...string[]]),
	});

	return {
		name: "skill_get",
		description,
		inputSchema,
		execute: async ({ name }) => {
			const filePath = `${skillsDir}/${name}.md`;
			try {
				const raw = await readText(filePath);
				// Strip frontmatter — return only the content body
				const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");

				// Collect tools activated by this skill
				const meta = skillRegistry.get(name);
				const activated: string[] = [];
				if (meta) {
					activated.push(...meta.tools);
					for (const tsName of meta.toolsets) {
						const ts = toolsetRegistry.get(tsName);
						if (ts) {
							for (const t of ts.tools) activated.push(t.name);
						}
					}
				}
				if (activated.length > 0) {
					return `${content}\n\n---\nTools now available: ${activated.join(", ")}`;
				}
				return content;
			} catch (err) {
				log.warn(`[skill] failed to read skill file: ${name}`, {
					error: err instanceof Error ? err.message : String(err),
				});
				return {
					error: `Failed to load skill "${name}": file not found or unreadable`,
				};
			}
		},
	};
}
