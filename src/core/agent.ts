import path from "node:path";
import type {
	ImagePart,
	ModelMessage,
	StepResult,
	TextPart,
	ToolSet,
	UserContent,
} from "ai";
import { tool } from "ai";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config } from "@/config";
import {
	generateMetaTool,
	toolRegistry,
	toolsetRegistry,
} from "@/core/registry";
import { log } from "@/logger";
import { buildProviderTool } from "@/tools/provider";
import { buildSkillTool } from "@/tools/skill";
import type { AgentDefinition, ToolDefinition, TurnContext } from "@/types";
import { hbs } from "./hbs";
import { callModel } from "./model-router";

const AgentFrontmatterSchema = z.object({
	name: z.string().min(1),
	modelTier: z.enum(["default", "low", "high"]),
	tools: z.array(z.string()).default([]),
	toolsets: z.array(z.string()).default([]),
	providerTools: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	schedule: z.string().optional(),
	vaultScope: z.string().optional(),
	conversationLimit: z.number().optional(),
});

// Max long-edge dimension for vision images. A 2048px image → at most 4×4 = 16 tiles ≈ 24k tokens.
const MAX_IMAGE_DIMENSION = 2048;

function buildSystemPrompt(
	body: string,
	vars: Record<string, unknown>,
): string {
	const template = hbs.compile(body, { noEscape: true });
	return template(vars)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Build the rich user message content from turn context vars + message data.
 * Includes message type prefix, quoted text, flags, and the actual message text.
 */
function buildUserMessageText(turn: TurnContext): string {
	const vars = turn.assembled.vars;
	const parts: string[] = [];

	// Message type prefix
	const messageType = vars.message_type as string | undefined;
	if (messageType === "voice") {
		const voiceCaption = vars.voice_caption as string | undefined;
		const line = voiceCaption
			? `Transcript of voice note. Caption: "${voiceCaption}"`
			: "Transcript of voice note.";
		parts.push(line);
	} else if (messageType === "image") {
		parts.push("Image");
	} else if (messageType === "document") {
		const name = vars.attachment_name as string | undefined;
		const mime = vars.attachment_mime as string | undefined;
		if (name) parts.push(`Attached: ${name} (${mime ?? ""})`);
	}

	// Quoted message
	const isReply = vars.is_reply as boolean | undefined;
	const quotedText = vars.quoted_text as string | undefined;
	if (isReply && quotedText) {
		parts.push(`> Quoted: ${quotedText}`);
	}

	// Flags
	const flags = vars.flags as string | undefined;
	if (flags) {
		parts.push(flags);
	}

	// Actual message text
	const messageText = vars.message_text as string | undefined;
	if (messageText) {
		parts.push(messageText);
	}

	return parts.join("\n");
}

/**
 * Generic agent execution engine used by all agents.
 * Loads the agent's prompt, runs the agentic loop via the Vercel AI SDK.
 * All agents produce free-text output via the reply tool — no structured return.
 */
export async function runAgent(
	turn: TurnContext,
	def: AgentDefinition,
): Promise<void> {
	// Load prompt body (strip YAML frontmatter)
	const raw = await Bun.file(def.promptPath).text();
	const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");

	const vars = { ...turn.assembled.vars };
	if (def.skills?.length) {
		vars.skills = def.skills;
	}
	const system = buildSystemPrompt(body, vars);

	// Build Vercel AI SDK tools — closures over turn so execute receives TurnContext
	const wrap = (t: ToolDefinition) =>
		tool({
			description: t.description,
			inputSchema: t.inputSchema,
			execute: (input) => t.execute(input, turn),
		});

	// All registered tools visible to the model (core tools + meta-tools + all toolset tools).
	// activeTools below restricts which subset is shown per step.
	const allTools: ToolSet = {};

	// Core tools — always active
	const initialActive: string[] = [];
	for (const name of def.tools) {
		const t = toolRegistry.get(name);
		if (!t) {
			log.warn("[agent] unknown tool", { tool: name });
			continue;
		}
		const sdkName = t.name.replace(/\./g, "_");
		allTools[sdkName] = wrap(t);
		initialActive.push(sdkName);
	}

	// Provider tools — injected directly (no wrapping), always active
	for (const name of def.providerTools ?? []) {
		const pt = buildProviderTool(name);
		if (!pt) {
			log.warn("[agent] unknown provider tool", { tool: name });
			continue;
		}
		allTools[name] = pt;
		initialActive.push(name);
	}

	// Toolsets — register meta-tool (active) + all toolset tools (inactive until activated)
	for (const tsName of def.toolsets ?? []) {
		const ts = toolsetRegistry.get(tsName);
		if (!ts) {
			log.warn("[agent] unknown toolset", { toolset: tsName });
			continue;
		}
		const meta = generateMetaTool(ts);
		allTools[meta.name] = wrap(meta);
		initialActive.push(meta.name);
		for (const t of ts.tools) {
			allTools[t.name.replace(/\./g, "_")] = wrap(t);
			// NOT added to initialActive — only visible after use_X is called
		}
	}

	// Skills — per-agent scoped tool, registered only when agent declares skills
	if (def.skills?.length) {
		const skillsDir = path.resolve(config.vault.dir, "Klaus", "skills");
		const skillTool = buildSkillTool(def.skills, skillsDir);
		const sdkName = skillTool.name.replace(/\./g, "_");
		allTools[sdkName] = wrap(skillTool);
		initialActive.push(sdkName);
	}

	// prepareStep: expand activeTools when meta-tools are called in previous steps
	const buildActiveTools = (steps: StepResult<ToolSet>[]): string[] => {
		const active = new Set(initialActive);
		for (const step of steps) {
			for (const call of step.toolCalls) {
				const name = call.toolName as string;
				if (!name.startsWith("use_")) continue;
				const tsName = name.slice(4); // 'use_files' → 'files'
				const ts = toolsetRegistry.get(tsName);
				if (!ts) continue;
				active.delete(`use_${tsName}`); // replace meta-tool with actual tools
				for (const t of ts.tools) active.add(t.name.replace(/\./g, "_"));
			}
		}
		return [...active];
	};

	const modelId = config.models[def.modelTier];
	log.info("[agent] calling model", {
		agent: def.name,
		model: modelId,
		activeTools: initialActive,
	});

	try {
		// Build conversation history messages
		const historyMessages: ModelMessage[] =
			turn.assembled.conversationMessages.map((m) => ({
				role: m.role,
				content: m.content,
			}));

		// Build user content — include raw image bytes for vision if applicable.
		// Prefer the current message's image; fall back to quoted message's image if this is a reply.
		let userContent: UserContent;
		const inboundMedia = turn.message?.media;
		const quotedMedia = turn.message?.quotedMessage?.media;
		const visionMedia = inboundMedia?.mimeType.startsWith("image/")
			? inboundMedia
			: quotedMedia?.mimeType.startsWith("image/")
				? quotedMedia
				: null;
		if (visionMedia) {
			const textContent = buildUserMessageText(turn);

			// Downscale large images to prevent token overflow (Anthropic tiles at 512×512 px, ~1500 tokens/tile)
			const rawBytes = await Bun.file(visionMedia.path).arrayBuffer();
			const resized = await sharp(Buffer.from(rawBytes))
				.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
					fit: "inside",
					withoutEnlargement: true,
				})
				.toBuffer();

			const imagePart: ImagePart = {
				type: "image",
				image: new Uint8Array(resized),
				mediaType: visionMedia.mimeType as Exclude<
					ImagePart["mediaType"],
					undefined
				>,
			};
			userContent = textContent
				? [imagePart, { type: "text", text: textContent } as TextPart]
				: [imagePart];
		} else if (turn.message) {
			userContent = buildUserMessageText(turn);
		} else {
			userContent = turn.dispatchContext?.objective || "";
		}

		const messages: ModelMessage[] = [
			...historyMessages,
			{ role: "user" as const, content: userContent },
		];

		const result = await callModel({
			tier: def.modelTier,
			agentName: def.name,
			chatId: turn.chatId,
			...(turn.messageId ? { messageId: turn.messageId } : {}),
			...(turn.taskId ? { taskId: turn.taskId } : {}),
			system,
			messages,
			...(Object.keys(allTools).length > 0
				? {
						tools: allTools,
						activeTools: initialActive,
						prepareStep: buildActiveTools,
					}
				: {}),
		});

		log.info("[agent] model call completed", {
			agent: def.name,
			usage: result.usage,
		});
	} catch (err) {
		log.error("[agent] callModel failed", {
			agent: def.name,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		throw err;
	}
}

/**
 * Load an AgentDefinition from its .md file (parses YAML frontmatter).
 * Called at startup and on hot-reload.
 */
export async function loadAgentDefinition(
	promptPath: string,
): Promise<AgentDefinition> {
	log.debug("[agent] loading definition", { promptPath });
	const raw = await Bun.file(promptPath).text();

	const match = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!match) throw new Error(`No YAML frontmatter found in: ${promptPath}`);

	const rawFront = parseYaml(match[1] ?? "");
	const front = AgentFrontmatterSchema.parse(rawFront);

	const {
		name,
		modelTier,
		tools,
		toolsets,
		providerTools,
		skills,
		schedule,
		vaultScope,
		conversationLimit,
	} = front;

	log.info("[agent] loaded definition", { name, modelTier, tools });

	return {
		name,
		modelTier,
		tools,
		...(toolsets.length > 0 ? { toolsets } : {}),
		...(providerTools.length > 0 ? { providerTools } : {}),
		...(skills.length > 0 ? { skills } : {}),
		...(schedule ? { schedule } : {}),
		...(vaultScope ? { vaultScope } : {}),
		...(conversationLimit !== undefined ? { conversationLimit } : {}),
		promptPath,
	};
}

/**
 * Registry of all loaded agents. Populated at startup by scanning /src/agents/*.md.
 */
export const agentRegistry = new Map<string, AgentDefinition>();

/**
 * Scan a directory for *.md agent definition files and load them into agentRegistry.
 * Call once at startup from index.ts.
 */
export async function loadAgents(agentsDir: string): Promise<void> {
	const glob = new Bun.Glob("*.md");
	for await (const file of glob.scan({ cwd: agentsDir })) {
		try {
			const def = await loadAgentDefinition(`${agentsDir}/${file}`);
			agentRegistry.set(def.name, def);
		} catch (err) {
			log.error("[agent] failed to load agent definition", {
				file,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
