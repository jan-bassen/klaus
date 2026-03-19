import path from "node:path";
import type {
	AssistantContent,
	ImagePart,
	ModelMessage,
	StepResult,
	TextPart,
	ToolContent,
	ToolSet,
	UserContent,
} from "ai";
import { tool } from "ai";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	generateMetaTool,
	toolRegistry,
	toolsetRegistry,
} from "@/core/registry";
import { flagRegistry } from "@/flags";
import { log } from "@/logger";
import { settings } from "@/settings";
import {
	appendTrace,
	type ConversationMessage,
	getConversation,
	getTraces,
	type TraceStep,
} from "@/store/conversation";
import { buildProviderTool } from "@/tools/provider";
import { buildSkillTool } from "@/tools/skill";
import type { AgentDefinition, ToolDefinition, TurnContext } from "@/types";
import { hbs } from "./hbs";
import { callModel, type ModelCallStep } from "./model-router";

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
 * Build the rich user message content directly from turn.message.
 * Includes message type prefix, quoted text, flags, and the actual message text.
 */
function buildUserMessageText(turn: TurnContext): string {
	const msg = turn.message;
	if (!msg) return "";

	const media = msg.media;
	const isVoice = !!media && media.mimeType.startsWith("audio/");
	const isImage = !!media && media.mimeType.startsWith("image/");
	const isDocument = !!media && !isVoice && !isImage;

	const parts: string[] = [];

	// Message type prefix
	if (isVoice) {
		const voiceCaption = media?.voiceCaption;
		const line = voiceCaption
			? `Transcript of voice note. Caption: "${voiceCaption}"`
			: "Transcript of voice note.";
		parts.push(line);
	} else if (isImage) {
		parts.push("Image");
	} else if (isDocument) {
		const name = media?.fileName;
		const mime = media?.mimeType;
		if (name) parts.push(`Attached: ${name} (${mime ?? ""})`);
	}

	// Quoted message
	if (msg.quotedMessage?.text) {
		parts.push(`> Quoted: ${msg.quotedMessage.text}`);
	}

	// Flags
	const flagPrompts = Object.keys(turn.flags)
		.filter((k) => turn.flags[k] && flagRegistry.has(k))
		.map((k) => flagRegistry.get(k)?.prompt ?? "")
		.filter(Boolean)
		.join("\n");
	if (flagPrompts) {
		parts.push(flagPrompts);
	}

	// Actual message text: transcript for voice, plain text otherwise
	const messageText = isVoice ? (media?.transcription ?? "") : (msg.text ?? "");
	if (messageText) {
		parts.push(messageText);
	}

	return parts.join("\n");
}

// -- Conversation message reconstruction --

const CHARS_PER_TOKEN = 4;
const MAX_REASONING_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 2000;
/** Number of recent turns (user messages) that get full trace replay */
const TRACE_DEPTH = 3;

/**
 * Build the conversation messages array for the SDK, reconstructing full
 * multi-step traces for recent turns so the model sees its own reasoning
 * and tool use from prior turns.
 *
 * Returns { messages, messageRefs } — messageRefs maps #label → externalId
 * for reply/react tools.
 */
export async function buildConversationMessages(
	turn: Omit<TurnContext, "assembled">,
): Promise<{
	messages: ModelMessage[];
	messageRefs: Record<string, { externalId: string; role: string }>;
}> {
	if (!turn.message) {
		return { messages: [], messageRefs: {} };
	}

	const limit =
		turn.agent.conversationLimit ?? settings.context.defaultConversationLimit;
	const allMessages = await getConversation();
	const traces = await getTraces();

	// Exclude the current inbound message from history
	const filtered = turn.message?.id
		? allMessages.filter((m) => m.externalId !== turn.message?.id)
		: allMessages;

	const recent = filtered.slice(-limit);

	// Budget-aware inclusion (work backwards)
	const budget = settings.context.conversationTokens;
	let tokenCount = 0;
	const included: ConversationMessage[] = [];

	for (let i = recent.length - 1; i >= 0; i--) {
		const row = recent[i];
		if (!row || !row.content) continue;
		const msgTokens = Math.ceil(row.content.length / CHARS_PER_TOKEN);
		// Add rough estimate for trace tokens
		const trace = traces.get(row.id);
		const traceTokens = trace
			? Math.ceil(
					trace.reduce(
						(sum, s) =>
							sum +
							(s.reasoning?.length ?? 0) +
							s.toolCalls.reduce((a, tc) => a + tc.args.length, 0) +
							s.toolResults.reduce(
								(a, tr) =>
									a + Math.min(tr.result.length, MAX_TOOL_RESULT_CHARS),
								0,
							),
						0,
					) / CHARS_PER_TOKEN,
				)
			: 0;
		if (tokenCount + msgTokens + traceTokens > budget) break;
		included.unshift(row);
		tokenCount += msgTokens + traceTokens;
	}

	const messages: ModelMessage[] = [];
	const messageRefs: Record<string, { externalId: string; role: string }> = {};

	// Determine which turns get full traces (last N user messages)
	let userMsgCount = 0;
	for (let i = included.length - 1; i >= 0; i--) {
		if (included[i]?.role === "user") userMsgCount++;
	}
	let usersSeen = 0;
	const traceThreshold = userMsgCount - TRACE_DEPTH;
	let lastUserId: string | undefined;

	for (let i = 0; i < included.length; i++) {
		const row = included[i];
		if (!row) continue;

		const label = i + 1;
		if (row.externalId) {
			messageRefs[String(label)] = {
				externalId: row.externalId,
				role: row.role,
			};
		}

		if (row.role === "user") {
			usersSeen++;
			lastUserId = row.id;
			messages.push({ role: "user", content: `[#${label}] ${row.content}` });
		} else {
			// Assistant turn — traces are keyed by the triggering user message ID
			const trace = lastUserId ? traces.get(lastUserId) : undefined;
			const useTrace = trace && usersSeen > traceThreshold;

			if (useTrace) {
				// Reconstruct multi-step messages from trace
				for (const step of trace) {
					const assistantParts: AssistantContent = [];

					if (step.reasoning) {
						assistantParts.push({
							type: "reasoning",
							text: step.reasoning.slice(0, MAX_REASONING_CHARS),
						});
					}

					// Only include tool calls that have a matching result — unpaired calls
					// cause the API to throw "Tool result is missing for tool call …"
					const resultMap = new Map(
						step.toolResults.map((tr) => [tr.toolCallId, tr]),
					);
					const pairedCalls = step.toolCalls.filter((tc) =>
						resultMap.has(tc.toolCallId),
					);

					for (const tc of pairedCalls) {
						assistantParts.push({
							type: "tool-call",
							toolCallId: tc.toolCallId,
							toolName: tc.toolName,
							input: JSON.parse(tc.args),
						});
					}

					if (assistantParts.length > 0) {
						messages.push({
							role: "assistant",
							content: assistantParts,
						});
					}

					if (pairedCalls.length > 0) {
						const toolParts: ToolContent = pairedCalls.map((tc) => {
							// pairedCalls is pre-filtered to IDs present in resultMap
							const tr = resultMap.get(tc.toolCallId) ?? {
								toolCallId: tc.toolCallId,
								toolName: tc.toolName,
								result: "",
							};
							return {
								type: "tool-result" as const,
								toolCallId: tr.toolCallId,
								toolName: tr.toolName,
								output: {
									type: "text" as const,
									value: tr.result.slice(0, MAX_TOOL_RESULT_CHARS),
								},
							};
						});
						messages.push({ role: "tool", content: toolParts });
					}
				}

				// Final text reply
				if (row.content) {
					messages.push({ role: "assistant", content: row.content });
				}
			} else {
				// Flat assistant message (no trace or outside trace window)
				messages.push({
					role: "assistant",
					content: row.content ?? "",
				});
			}
		}
	}

	return { messages, messageRefs };
}

/**
 * Convert model call steps to trace steps for persistence.
 * Filters out reply tool calls and ensures every tool call has a matching result
 * so replayed traces never produce "Tool result is missing" API errors.
 */
function toTraceSteps(steps: ModelCallStep[]): TraceStep[] {
	const result: TraceStep[] = [];

	for (const step of steps) {
		const allCalls = step.toolCalls.filter((tc) => tc.toolName !== "reply");
		const allResults = step.toolResults.filter((tr) => tr.toolName !== "reply");

		// Only keep calls that have a matching result — orphaned calls corrupt replay
		const resultIds = new Set(allResults.map((tr) => tr.toolCallId));
		const pairedCalls = allCalls.filter((tc) => resultIds.has(tc.toolCallId));

		const toolCalls = pairedCalls.map((tc) => ({
			toolCallId: tc.toolCallId,
			toolName: tc.toolName,
			args: JSON.stringify(tc.args),
		}));
		const toolResults = pairedCalls.map((tc) => {
			// pairedCalls is pre-filtered to IDs present in allResults
			const tr = allResults.find((r) => r.toolCallId === tc.toolCallId) ?? {
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				result: null,
			};
			return {
				toolCallId: tr.toolCallId,
				toolName: tr.toolName,
				result: JSON.stringify(tr.result),
			};
		});
		const reasoning = step.reasoning || undefined;

		if (reasoning || toolCalls.length > 0) {
			result.push({ reasoning, toolCalls, toolResults });
		}
	}

	return result;
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
		const skillsDir = path.resolve(settings.vault.dir, "Klaus", "skills");
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

	const modelId = settings.models[def.modelTier];
	log.info("[agent] calling model", {
		agent: def.name,
		model: modelId,
		activeTools: initialActive,
	});

	try {
		// Build conversation history with traces
		const { messages: historyMessages, messageRefs } =
			await buildConversationMessages(turn);

		// Inject messageRefs into assembled context for reply/react tools
		Object.assign(turn.assembled.messageRefs, messageRefs);

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

		const promptRaw = await Bun.file(def.promptPath).text();
		const promptBody = promptRaw.replace(/^---\n[\s\S]*?\n---\n?/, "");
		const system = buildSystemPrompt(promptBody, turn.assembled.vars);

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

		// Persist trace for multi-turn replay (fire-and-forget)
		if (turn.messageId && result.steps.length > 0) {
			const traceSteps = toTraceSteps(result.steps);
			if (traceSteps.length > 0) {
				appendTrace(turn.messageId, traceSteps).catch((err) =>
					log.warn("[agent] failed to persist trace", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		}
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
