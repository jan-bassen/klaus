import { readFileSync } from "node:fs";
import type {
	ImagePart,
	ModelMessage,
	StepResult,
	TextPart,
	ToolSet,
	UserContent,
} from "ai";
import { Output, tool } from "ai";
import sharp from "sharp";
import { z } from "zod";
import { resolveProvider, settings } from "@/config";
import { log } from "@/logger";
import { hbs, interpolateUserVars, stripHbsParams } from "@/markdown";
import { appendTrace, type TraceStep } from "@/store/conversation";
import { addTimer, listTimers, removeTimer } from "@/store/timers";
import { generateMetaTool, toolRegistry, toolsetRegistry } from "@/tools";
import { buildProviderTool } from "@/tools/provider";
import { REPLY_TOOL_NAME } from "@/tools/reply";
import { parseRunAt } from "@/tools/sets/dispatch";
import { buildSkillTool, skillRegistry } from "@/tools/skill";
import type { AgentDefinition, ToolDefinition, TurnContext } from "@/types";
import { awaitConfirmation } from "@/whatsapp/confirm";
import { buildConversationMessages } from "./messages";
import { callModel, type ModelCallStep } from "./model";

const PersistentOutputSchema = z.object({
	nextRun: z
		.string()
		.describe("When to run next: delay string ('2h','1d') or ISO datetime"),
	objective: z.string().describe("What the next run should focus on"),
});

const MAX_IMAGE_DIMENSION = settings.vision.maxImageDimension;

function buildSystemPrompt(
	body: string,
	vars: Record<string, unknown>,
): string {
	const clean = stripHbsParams(body);
	const template = hbs.compile(clean, { noEscape: true });
	return template(vars)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Hardcoded fallback when message.md template is missing or invalid. */
function buildUserMessageFallback(turn: TurnContext): string {
	const msg = turn.message;
	if (!msg) return "";

	const media = msg.media;
	const isVoice = !!media && media.mimeType.startsWith("audio/");
	const isImage = !!media && media.mimeType.startsWith("image/");
	const isDocument = !!media && !isVoice && !isImage;

	const parts: string[] = [];

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

	if (msg.quotedMessage?.text) {
		parts.push(`> Quoted: ${msg.quotedMessage.text}`);
	}

	const messageText = isVoice ? (media?.transcription ?? "") : (msg.text ?? "");
	if (messageText) parts.push(messageText);

	return parts.join("\n");
}

function messageTemplatePath(): string {
	return `${settings.vault.internalPath}/message.md`;
}

/**
 * Build the rich user message content from turn.message.
 * Uses {vault}/Klaus/message.md Handlebars template if present, otherwise falls back to hardcoded format.
 */
function buildUserMessageText(turn: TurnContext): string {
	const msg = turn.message;
	if (!msg) return "";

	const media = msg.media;
	const isVoice = !!media && media.mimeType.startsWith("audio/");
	const isImage = !!media && media.mimeType.startsWith("image/");
	const isDocument = !!media && !isVoice && !isImage;
	const messageText = isVoice ? (media?.transcription ?? "") : (msg.text ?? "");

	let raw: string;

	try {
		const templateRaw = readFileSync(messageTemplatePath(), "utf-8");
		const template = hbs.compile(templateRaw, { noEscape: true });
		raw = template({
			isVoice,
			isImage,
			isDocument,
			voiceCaption: media?.voiceCaption ?? "",
			fileName: media?.fileName ?? "",
			mimeType: media?.mimeType ?? "",
			quotedText: msg.quotedMessage?.text ?? "",
			messageText,
			overrides: Object.keys(turn.activeoverrides),
		})
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	} catch {
		raw = buildUserMessageFallback(turn);
	}

	// Interpolate $var references in user message text
	const allVars = { ...turn.assembled.vars, ...turn.assembled.userVars };
	return interpolateUserVars(raw, allVars);
}

/**
 * Convert model call steps to trace steps for persistence.
 * Filters out reply tool calls and ensures every tool call has a matching result
 * so replayed traces never produce "Tool result is missing" API errors.
 */
function toTraceSteps(steps: ModelCallStep[]): TraceStep[] {
	const result: TraceStep[] = [];

	for (const step of steps) {
		const allCalls = step.toolCalls.filter(
			(tc) => tc.toolName !== REPLY_TOOL_NAME,
		);
		const allResults = step.toolResults.filter(
			(tr) => tr.toolName !== REPLY_TOOL_NAME,
		);

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
 * Clamp a run-at ISO string to the configured min/max bounds.
 * Returns a new ISO string, clamped if necessary.
 */
export function clampNextRun(isoRunAt: string): string {
	const runAtMs = new Date(isoRunAt).getTime();
	const nowMs = Date.now();
	const delayMs = runAtMs - nowMs;
	const clamped = Math.max(
		settings.persistent.minNextRunMs,
		Math.min(delayMs, settings.persistent.maxNextRunMs),
	);
	if (clamped !== delayMs) {
		return new Date(nowMs + clamped).toISOString();
	}
	return isoRunAt;
}

/**
 * Cancel existing timers for the same agent+chatId combination.
 * Prevents timer accumulation across runs.
 */
async function cancelExistingPersistentTimers(
	agentName: string,
	chatId: string,
): Promise<void> {
	const existing = listTimers().filter(
		(t) =>
			t.agentName === agentName &&
			t.chatId === chatId &&
			t.createdBy === `persistent:${agentName}`,
	);
	for (const t of existing) {
		await removeTimer(t.id);
	}
}

/**
 * Schedule the next persistent timer from structured output or fallback.
 */
async function schedulePersistentTimer(
	agentName: string,
	chatId: string,
	nextRun: string,
	objective: string,
): Promise<void> {
	await cancelExistingPersistentTimers(agentName, chatId);
	const absoluteRunAt = parseRunAt(nextRun);
	const clampedRunAt = clampNextRun(absoluteRunAt);
	await addTimer({
		id: crypto.randomUUID(),
		agentName,
		chatId,
		objective,
		runAt: clampedRunAt,
		createdBy: `persistent:${agentName}`,
		createdAt: new Date().toISOString(),
	});
	log.info("[agent] persistent timer scheduled", {
		agent: agentName,
		runAt: clampedRunAt,
		objective,
	});
}

export interface AgentRunResult {
	usage: { promptTokens: number; completionTokens: number };
	durationMs: number;
	steps: ModelCallStep[];
	model: string;
	provider: string;
	tier: string;
	conversationMessages: number;
	systemPrompt: string;
	userMessage: string;
	replyContent: string;
}

/**
 * Generic agent execution engine used by all agents.
 * Loads the agent's prompt, runs the agentic loop via the Vercel AI SDK.
 * All agents produce free-text output via the reply tool — no structured return.
 * Returns pipeline-relevant metadata for logging.
 */
export async function runAgent(
	turn: TurnContext,
	def: AgentDefinition,
): Promise<AgentRunResult> {
	// Build Vercel AI SDK tools — closures over turn so execute receives TurnContext
	const wrap = (t: ToolDefinition) =>
		tool({
			description: t.description,
			inputSchema: t.inputSchema,
			execute: async (input) => {
				if (t.requiresConfirmation && !turn.overrides?.autoAccept) {
					if (!turn.message)
						return "Cannot request confirmation — no inbound message context.";
					const result = await awaitConfirmation(
						turn.message,
						`Confirm ${t.name}? React 👍 to proceed.`,
					);
					if (result !== "confirmed") return "Operation cancelled by user.";
				}
				return t.execute(input, turn);
			},
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

	// Provider tools — injected directly (no wrapping), always active.
	// Resolve SDK from the effective provider for this turn.
	const effectiveProvider = turn.overrides?.provider;
	const providerCfg = resolveProvider(effectiveProvider);
	for (const name of def.providerTools ?? []) {
		const pt = buildProviderTool(name, providerCfg.sdk);
		if (!pt) {
			log.warn("[agent] provider tool not available", {
				tool: name,
				sdk: providerCfg.sdk,
			});
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
		const skillsDir = settings.vault.skillsDir;
		const skillTool = buildSkillTool(def.skills, skillsDir);
		const sdkToolName = skillTool.name.replace(/\./g, "_");
		allTools[sdkToolName] = wrap(skillTool);
		initialActive.push(sdkToolName);

		// Pre-register tools that skills may activate (inactive until skill is loaded)
		for (const sName of def.skills) {
			const meta = skillRegistry.get(sName);
			if (!meta) continue;
			for (const toolName of meta.tools) {
				const t = toolRegistry.get(toolName);
				if (!t) {
					log.warn("[agent] unknown tool in skill", {
						skill: sName,
						tool: toolName,
					});
					continue;
				}
				const n = t.name.replace(/\./g, "_");
				if (!allTools[n]) allTools[n] = wrap(t);
			}
			for (const tsName of meta.toolsets) {
				const ts = toolsetRegistry.get(tsName);
				if (!ts) {
					log.warn("[agent] unknown toolset in skill", {
						skill: sName,
						toolset: tsName,
					});
					continue;
				}
				for (const t of ts.tools) {
					const n = t.name.replace(/\./g, "_");
					if (!allTools[n]) allTools[n] = wrap(t);
				}
			}
		}
	}

	// prepareStep: expand activeTools when meta-tools or skill_get are called in previous steps
	const buildActiveTools = (steps: StepResult<ToolSet>[]): string[] => {
		const active = new Set(initialActive);
		for (const step of steps) {
			for (const call of step.toolCalls) {
				const name = call.toolName as string;
				if (name.startsWith("use_")) {
					const tsName = name.slice(4); // 'use_files' → 'files'
					const ts = toolsetRegistry.get(tsName);
					if (!ts) continue;
					active.delete(`use_${tsName}`); // replace meta-tool with actual tools
					for (const t of ts.tools) active.add(t.name.replace(/\./g, "_"));
				} else if (name === "skill_get") {
					const sName = (call as unknown as { input?: { name?: string } }).input
						?.name;
					const meta = sName ? skillRegistry.get(sName) : undefined;
					if (!meta) continue;
					for (const toolName of meta.tools) {
						active.add(toolName.replace(/\./g, "_"));
					}
					for (const tsName of meta.toolsets) {
						const ts = toolsetRegistry.get(tsName);
						if (!ts) continue;
						for (const t of ts.tools) active.add(t.name.replace(/\./g, "_"));
					}
				}
			}
		}
		return [...active];
	};

	const effectiveTier = turn.overrides?.modelTier ?? def.modelTier;
	const effectiveToolChoice = turn.overrides?.toolChoice;

	let effectiveTemperature: number | undefined;
	const tempPreset = turn.overrides?.temperaturePreset;
	if (tempPreset === "cold") {
		effectiveTemperature = providerCfg.coldTemperature ?? 0;
	} else if (tempPreset === "hot") {
		effectiveTemperature = providerCfg.hotTemperature ?? 1;
	} else if (providerCfg.temperature !== undefined) {
		effectiveTemperature = providerCfg.temperature;
	}

	let effectiveTopP: number | undefined;
	const topPPreset = turn.overrides?.topPPreset;
	if (topPPreset === "creative") {
		effectiveTopP = providerCfg.creativeTopP ?? 0.95;
	} else if (topPPreset === "rigid") {
		effectiveTopP = providerCfg.rigidTopP ?? 0.1;
	} else if (providerCfg.topP !== undefined) {
		effectiveTopP = providerCfg.topP;
	}
	// Build providerOptions from overrides
	let providerOptions: Record<string, Record<string, unknown>> | undefined;
	const sdkName = providerCfg.sdk;

	const reasoningEffort = turn.overrides?.reasoningEffort;
	if (reasoningEffort) {
		switch (sdkName) {
			case "anthropic":
				providerOptions ??= {};
				providerOptions.anthropic = {
					...providerOptions.anthropic,
					effort: reasoningEffort,
				};
				break;
			case "openai":
				providerOptions ??= {};
				providerOptions.openai = {
					...providerOptions.openai,
					reasoningEffort,
				};
				break;
			case "google":
				providerOptions ??= {};
				providerOptions.google = {
					...providerOptions.google,
					thinkingConfig: { thinkingLevel: reasoningEffort },
				};
				break;
			default:
				log.warn("[agent] reasoning effort not supported for provider", {
					sdk: sdkName,
				});
		}
	}

	if (turn.overrides?.fast) {
		switch (sdkName) {
			case "anthropic":
				providerOptions ??= {};
				providerOptions.anthropic = {
					...providerOptions.anthropic,
					speed: "fast",
				};
				break;
			default:
				log.warn("[agent] fast mode not supported for provider", {
					sdk: sdkName,
				});
		}
	}

	const modelId = providerCfg[effectiveTier];
	log.info("[agent] calling model", {
		agent: def.name,
		model: modelId,
		sdk: providerCfg.sdk,
		activeTools: initialActive,
	});

	try {
		// Build conversation history with traces (skip if !clean override)
		const { messages: historyMessages, messageRefs } = turn.overrides
			?.skipHistory
			? {
					messages: [] as ModelMessage[],
					messageRefs: {} as Record<
						string,
						{ externalId: string; role: string }
					>,
				}
			: await buildConversationMessages(turn);

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
			tier: effectiveTier,
			provider: effectiveProvider,
			agentName: def.name,
			chatId: turn.chatId,
			...(turn.messageId ? { messageId: turn.messageId } : {}),
			system,
			messages,
			...(effectiveTemperature !== undefined
				? { temperature: effectiveTemperature }
				: {}),
			...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
			...(providerOptions ? { providerOptions } : {}),
			...(effectiveToolChoice === "required"
				? { toolChoice: "required" as const }
				: {}),
			...(Object.keys(allTools).length > 0
				? {
						tools: allTools,
						activeTools:
							effectiveToolChoice === "none"
								? [REPLY_TOOL_NAME]
								: initialActive,
						...(effectiveToolChoice !== "none"
							? { prepareStep: buildActiveTools }
							: {}),
					}
				: {}),
			...(def.persistent
				? { output: Output.object({ schema: PersistentOutputSchema }) }
				: {}),
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

		// Persistent agents: schedule next run from structured output
		if (def.persistent) {
			const parsed = PersistentOutputSchema.safeParse(result.output);
			if (parsed.success) {
				await schedulePersistentTimer(
					def.name,
					turn.chatId,
					parsed.data.nextRun,
					parsed.data.objective,
				);
			} else {
				log.warn("[agent] persistent output parse failed, using fallback", {
					agent: def.name,
				});
				const fallbackObjective =
					turn.dispatchContext?.objective ?? "Continue persistent check-in";
				await schedulePersistentTimer(
					def.name,
					turn.chatId,
					settings.persistent.defaultNextRun,
					fallbackObjective,
				);
			}
		}

		// Extract reply content from reply tool calls for logging
		const replyContent = result.steps
			.flatMap((s) => s.toolCalls)
			.filter((tc) => tc.toolName === REPLY_TOOL_NAME)
			.map((tc) => {
				const content = tc.args?.content;
				return typeof content === "string" ? content : "";
			})
			.join("\n---\n");

		// Build user message string for logging
		const userMessageStr =
			typeof userContent === "string"
				? userContent
				: JSON.stringify(userContent);

		return {
			usage: result.usage,
			durationMs: result.durationMs,
			steps: result.steps,
			model: modelId,
			provider: providerCfg.sdk,
			tier: effectiveTier,
			conversationMessages: historyMessages.length,
			systemPrompt: system,
			userMessage: userMessageStr,
			replyContent,
		};
	} catch (err) {
		// Persistent agents must always reschedule, even on failure
		if (def.persistent) {
			const fallbackObjective =
				turn.dispatchContext?.objective ?? "Continue persistent check-in";
			await schedulePersistentTimer(
				def.name,
				turn.chatId,
				settings.persistent.defaultNextRun,
				fallbackObjective,
			).catch((timerErr) =>
				log.error("[agent] failed to schedule recovery timer", {
					agent: def.name,
					error:
						timerErr instanceof Error ? timerErr.message : String(timerErr),
				}),
			);
		}
		log.error("[agent] callModel failed", {
			agent: def.name,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
		throw err;
	}
}
