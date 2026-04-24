/**
 * Agent core loop: take a fully-prepared turn (config, context, prompts) and
 * drive the Vercel AI SDK to produce an `AgentRunResult`.
 *
 * The orchestrator (`pipeline/index.ts`) handles parsing, config, context, and
 * prompt assembly. By the time we get here, everything is in place and we just
 * call the model and post-process.
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type {
	LanguageModel,
	ModelMessage,
	StepResult,
	ToolSet,
	UserContent,
} from "ai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { type ModelTier, resolveProvider, settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { appendTrace, type TraceStep } from "@/infra/store/history";
import { addTimer } from "@/infra/store/timers";
import { enqueueMessage } from "@/infra/whatsapp/send";
import {
	type AssembledTools,
	assembleContext,
	type HistoryOptions,
} from "@/pipeline/context";
import {
	buildSystemPrompt,
	buildUserMessage,
	resolveSampling,
} from "@/pipeline/prompts";
import { emitReport } from "@/pipeline/reports";
import { REPLY_TOOL_NAME } from "@/primitives/tools/reply";
import type { Variable } from "@/primitives/variables";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import type { AgentDefinition } from "./agents";
import type { TurnConfig } from "./overrides";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * What kicked off this run. Discriminated by `kind`; the source-id field is
 * named for what it points to so destructuring stays self-documenting.
 *
 * - `message`  — a user-typed WhatsApp message
 * - `schedule` — a cron-fired schedule (`Klaus/agents/*.md` static persistence)
 * - `timer`    — a one-shot timer (incl. dynamic-persistence reschedules)
 * - `dispatch` — another agent invoked us inline via the dispatch tool
 */
export type Trigger =
	| { kind: "message"; messageId: string }
	| { kind: "schedule"; scheduleId: string }
	| { kind: "timer"; timerId: string }
	| { kind: "dispatch"; parentRunId: string };

/**
 * The full per-turn state carried through `executeAgent`. Partial variants
 * (`Omit<TurnContext, "vars">`) flow in at the pipeline / dispatch boundary
 * and `executeAgent` fills in `vars` before handing off to the model loop.
 */
export interface TurnContext {
	chatId: string;
	/** Present for WhatsApp turns; undefined for dispatched/scheduled/timer runs. */
	message?: InboundMessage;
	agent: AgentDefinition;
	/** Stable identity for this agent run — set at the dispatch boundary, immutable thereafter. */
	runId: string;
	/** What kicked off this run — first-class for trace persistence + reports. */
	trigger: Trigger;
	/** Names of override presets activated this turn (e.g. ["voice","large"]). */
	overrides: Record<string, boolean>;
	/** Effective turn configuration — agent defaults merged with per-message overrides. */
	config: TurnConfig;
	/** Unified nested variable namespace (e.g. vars.media.doc.text, vars.time.date). */
	vars: Record<string, unknown>;
	/** Label → externalId mapping for message references (reply/react tools). */
	messageRefs: Record<string, { externalId: string; role: string }>;
	/** The prompt the parent/scheduler handed to this agent. Undefined unless trigger.kind === "dispatch". */
	dispatchContext?: { prompt: string };
	/**
	 * Ordered slots for inline-dispatched sub-agent replies. Each slot is an
	 * array of reply strings filled by a sub-agent while its turn runs. At end
	 * of this turn, slots flush in index order — either into `_replyCollector`
	 * (if this turn is itself a sub) or to WhatsApp (if top-level). Preserves
	 * dispatch-call order even when sub-agents run in parallel.
	 */
	pendingSubReplies: string[][];
	/** @internal — collects reply content for inline-dispatched agents instead of sending to WhatsApp */
	_replyCollector?: string[];
}

export class LlmTimeoutError extends Error {
	constructor(modelId: string, timeoutMs: number) {
		super(`LLM call timed out after ${timeoutMs}ms (model: ${modelId})`);
		this.name = "LlmTimeoutError";
	}
}

export interface ModelCallStep {
	reasoning: string;
	toolCalls: Array<{
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}>;
	toolResults: Array<{
		toolCallId: string;
		toolName: string;
		result: unknown;
	}>;
	finishReason?: string;
	usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentRunResult {
	usage: { promptTokens: number; completionTokens: number };
	durationMs: number;
	steps: ModelCallStep[];
	model: string;
	provider: string;
	tier: string;
	/** Verbatim transcript that hit the model — full prompts for `report: "full"`. */
	historyMessages: ModelMessage[];
	systemPrompt: string;
	userMessage: string;
	replyContent: string;
}

export interface RunAgentInput {
	turn: TurnContext;
	def: AgentDefinition;
	system: string;
	userContent: UserContent;
	tools: AssembledTools;
	historyMessages: ModelMessage[];
}

export interface ExecuteAgentInput {
	/** Partial turn — vars are assembled inside `executeAgent`. */
	turn: Omit<TurnContext, "vars">;
	def: AgentDefinition;
	variables: Variable[];
	history?: HistoryOptions;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * High-level: take a partial turn and run the full agent end-to-end.
 * Assembles context (vars + tools + history), compiles prompts, then calls
 * `runAgent`. Used by both the inbound pipeline and dispatch.
 *
 * Emits a per-turn report (when `turn.config.report !== "none"`) on both
 * success and failure paths — fire-and-forget so reporting never blocks
 * the reply or masks the original error.
 */
export async function executeAgent(
	input: ExecuteAgentInput,
): Promise<AgentRunResult> {
	const startedAt = Date.now();
	const reportLevel = resolveReportLevel(input.turn.config.report);

	let fullTurn: TurnContext = { ...input.turn, vars: {} };

	try {
		const ctx = await assembleContext(input.turn, input.def, {
			variables: input.variables,
			...(input.history ? { history: input.history } : {}),
		});
		fullTurn = { ...input.turn, vars: ctx.vars };

		const promptRaw = await Bun.file(input.def.promptPath).text();
		const promptBody = promptRaw.replace(/^---\n[\s\S]*?\n---\n?/, "");
		const system = buildSystemPrompt(promptBody, ctx.vars);
		const userContent = await buildUserMessage(fullTurn);

		const result = await runAgent({
			turn: fullTurn,
			def: input.def,
			system,
			userContent,
			tools: ctx.tools,
			historyMessages: ctx.history.messages,
		});

		if (input.def.persistence?.mode === "dynamic") {
			await persistDynamic({
				def: input.def,
				turn: fullTurn,
				system,
				historyMessages: ctx.history.messages,
				userContent,
				replyContent: result.replyContent,
				hint: input.def.persistence.hint,
			});
		}

		flushPendingSubReplies(fullTurn);

		if (reportLevel) {
			emitReport({ turn: fullTurn, startedAt, level: reportLevel, result });
		}

		return result;
	} catch (err) {
		if (reportLevel) {
			emitReport({ turn: fullTurn, startedAt, level: reportLevel, error: err });
		}
		throw err;
	}
}

/**
 * After the agent's loop completes, drain the indexed sub-reply slots in
 * dispatch-call order. When this turn is itself a sub (has its own
 * `_replyCollector`), bubble the slots up to the parent. Otherwise this is a
 * top-level run — enqueue each slot entry as its own WhatsApp message.
 *
 * Under `!simulate` at the top level, the sim report already captured the
 * reply intents (via each reply tool's simulate handler logged on the
 * overlay), so we drop the slots without enqueuing.
 */
function flushPendingSubReplies(turn: TurnContext): void {
	if (turn.pendingSubReplies.length === 0) return;

	if (turn._replyCollector) {
		for (const slot of turn.pendingSubReplies) {
			for (const content of slot) turn._replyCollector.push(content);
		}
	} else if (!turn.config?.simulate) {
		for (const slot of turn.pendingSubReplies) {
			for (const content of slot) {
				enqueueMessage({
					chatId: turn.chatId,
					content,
					dedupKey: `${turn.runId}:sub:${crypto.randomUUID()}`,
					label: turn.agent.name,
				});
			}
		}
	}

	turn.pendingSubReplies.length = 0;
}

/** Map the user-facing setting onto the actual emit level (or `null` to skip). */
function resolveReportLevel(
	setting: "full" | "agent" | "none" | undefined,
): "full" | "agent" | null {
	if (setting === "none") return null;
	if (setting === "full") return "full";
	return "agent";
}

/**
 * Low-level: take a fully-prepared turn (config, context, prompts) and
 * drive the Vercel AI SDK to produce an `AgentRunResult`.
 * Most callers want `executeAgent` instead.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
	const { turn, def, system, userContent, tools, historyMessages } = input;

	const providerCfg = resolveProvider(turn.config?.provider);
	const tier: ModelTier =
		turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const modelId = providerCfg[tier];
	const toolChoice = turn.config?.toolChoice;
	const stepLimit = turn.config?.stepLimit ?? settings.agent.maxSteps;
	const sampling = resolveSampling(turn.config, turn.config?.provider);

	log.info(
		`[agent] calling ${modelId} via ${providerCfg.sdk} for @${def.name}`,
	);

	const messages: ModelMessage[] = [
		...historyMessages,
		{ role: "user", content: userContent },
	];

	const hasTools = Object.keys(tools.allTools).length > 0;
	const activeTools =
		toolChoice === "none" ? [REPLY_TOOL_NAME] : tools.initialActive;

	const result = await callModel({
		tier,
		provider: turn.config?.provider,
		agentName: def.name,
		chatId: turn.chatId,
		stepLimit,
		runId: turn.runId,
		system,
		messages,
		...(sampling.temperature !== undefined
			? { temperature: sampling.temperature }
			: {}),
		...(sampling.topP !== undefined ? { topP: sampling.topP } : {}),
		...(sampling.providerOptions
			? { providerOptions: sampling.providerOptions }
			: {}),
		...(toolChoice === "required" ? { toolChoice: "required" as const } : {}),
		...(hasTools
			? {
					tools: tools.allTools,
					activeTools,
					...(toolChoice !== "none" ? { prepareStep: tools.prepareStep } : {}),
				}
			: {}),
	});

	// Fire-and-forget — trace persistence is best-effort, never blocks reply.
	// Skipped under ghost (and therefore under !simulate) so ephemeral runs
	// don't pollute the conversation log.
	if (!turn.config?.ghost && result.steps.length > 0) {
		const traceSteps = toTraceSteps(result.steps);
		if (traceSteps.length > 0) {
			appendTrace(turn.runId, def.name, turn.trigger, traceSteps).catch((err) =>
				log.warn("[agent] failed to persist trace", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}

	const replyContent = result.steps
		.flatMap((s) => s.toolCalls)
		.filter((tc) => tc.toolName === REPLY_TOOL_NAME)
		.map((tc) => {
			const content = tc.args?.content;
			return typeof content === "string" ? content : "";
		})
		.join("\n---\n");

	const userMessageStr =
		typeof userContent === "string" ? userContent : JSON.stringify(userContent);

	return {
		usage: result.usage,
		durationMs: result.durationMs,
		steps: result.steps,
		model: modelId,
		provider: providerCfg.sdk,
		tier,
		historyMessages,
		systemPrompt: system,
		userMessage: userMessageStr,
		replyContent,
	};
}

// ── Model call (private) ───────────────────────────────────────────────────

interface ModelCallOptions {
	tier: ModelTier;
	chatId?: string;
	provider?: string | undefined;
	system?: string;
	messages: ModelMessage[];
	tools?: ToolSet;
	stepLimit?: number;
	runId?: string;
	agentName?: string;
	activeTools?: string[];
	prepareStep?: (steps: StepResult<ToolSet>[]) => string[];
	temperature?: number;
	topP?: number;
	toolChoice?: "none" | "required";
	providerOptions?: Record<string, Record<string, unknown>>;
}

interface ModelCallResult {
	content: string;
	usage: { promptTokens: number; completionTokens: number };
	steps: ModelCallStep[];
	durationMs: number;
}

/** Retryable = transient (network blip, 5xx). Timeouts and rate limits are not. */
function isRetryable(err: unknown): boolean {
	if (err instanceof LlmTimeoutError) return false;
	if (err instanceof Error && /rate.?limit/i.test(err.message)) return false;
	if (err instanceof Error && /prompt is too long/i.test(err.message))
		return false;
	return true;
}

async function callModel(opts: ModelCallOptions): Promise<ModelCallResult> {
	const providerCfg = resolveProvider(opts.provider);
	const modelId = providerCfg[opts.tier];
	const model = createModel(providerCfg.sdk, modelId);

	const startTime = Date.now();
	const timeoutMs = settings.agent.timeout;
	const MAX_ATTEMPTS = settings.agent.retries.max;

	let result: Awaited<ReturnType<typeof generateText>> | undefined;
	let lastErr: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new LlmTimeoutError(modelId, timeoutMs)),
					timeoutMs,
				);
			});
			result = await Promise.race([
				generateText({
					model,
					...(opts.system ? { system: opts.system } : {}),
					messages: opts.messages,
					...(opts.temperature !== undefined
						? { temperature: opts.temperature }
						: {}),
					...(opts.topP !== undefined ? { topP: opts.topP } : {}),
					...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
					...(opts.providerOptions
						? { providerOptions: opts.providerOptions as ProviderOptions }
						: {}),
					...(opts.tools && Object.keys(opts.tools).length > 0
						? {
								tools: opts.tools,
								stopWhen: stepCountIs(
									opts.stepLimit ?? settings.agent.maxSteps,
								),
								...(opts.activeTools
									? { activeTools: opts.activeTools as Array<keyof ToolSet> }
									: {}),
								...(opts.prepareStep
									? {
											prepareStep: ({
												steps,
											}: {
												steps: StepResult<ToolSet>[];
											}) => ({
												activeTools: opts.prepareStep?.(steps) as Array<
													keyof ToolSet
												>,
											}),
										}
									: {}),
							}
						: {}),
				}),
				timeoutPromise,
			]);
			clearTimeout(timeoutId);
			break;
		} catch (err) {
			clearTimeout(timeoutId);
			lastErr = err;
			if (!isRetryable(err)) {
				log.error(`[agent] ${modelId} call failed (non-retryable)`, {
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
				throw err;
			}
			if (attempt < MAX_ATTEMPTS) {
				const delayMs = settings.agent.retries.backoffMs * 2 ** (attempt - 1);
				log.warn(
					`[agent] ${modelId} call failed, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`,
					{ error: err instanceof Error ? err.message : String(err) },
				);
				await new Promise<void>((r) => setTimeout(r, delayMs));
			}
		}
	}

	if (!result) {
		log.error(`[agent] ${modelId} call failed after all retries`, {
			error: lastErr instanceof Error ? lastErr.message : String(lastErr),
			stack: lastErr instanceof Error ? lastErr.stack : undefined,
		});
		throw lastErr;
	}

	const durationMs = Date.now() - startTime;
	const promptTokens = result.steps.reduce(
		(s, st) => s + (st.usage.inputTokens ?? 0),
		0,
	);
	const completionTokens = result.steps.reduce(
		(s, st) => s + (st.usage.outputTokens ?? 0),
		0,
	);
	const steps: ModelCallStep[] = result.steps.map((s) => ({
		reasoning: s.reasoningText ?? "",
		toolCalls: (s.toolCalls ?? []).map((tc) => ({
			toolCallId: tc.toolCallId,
			toolName: tc.toolName,
			args: (tc.input ?? {}) as Record<string, unknown>,
		})),
		toolResults: (s.toolResults ?? []).map((tr) => ({
			toolCallId: tr.toolCallId,
			toolName: tr.toolName,
			result: tr.output,
		})),
		finishReason: s.finishReason,
		usage: {
			inputTokens: s.usage.inputTokens ?? 0,
			outputTokens: s.usage.outputTokens ?? 0,
		},
	}));

	return {
		content: result.text,
		usage: { promptTokens, completionTokens },
		steps,
		durationMs,
	};
}

// ── Trace transform (private) ──────────────────────────────────────────────

/**
 * Convert model steps into persisted trace steps. Drops reply tool calls
 * (they go in the message body) and orphaned calls (would break replay).
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

		const resultIds = new Set(allResults.map((tr) => tr.toolCallId));
		const pairedCalls = allCalls.filter((tc) => resultIds.has(tc.toolCallId));

		const toolCalls = pairedCalls.map((tc) => ({
			toolCallId: tc.toolCallId,
			toolName: tc.toolName,
			args: JSON.stringify(tc.args),
		}));
		const toolResults = pairedCalls.map((tc) => {
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

// ── Dynamic persistence (forced tool call) ─────────────────────────────────

const persistInputSchema = z.object({
	nextRun: z
		.string()
		.describe(
			"When to run again. ISO 8601 datetime (e.g. 2026-04-23T08:00:00Z) or duration like '6h', '30m', '2d'.",
		),
	prompt: z
		.string()
		.describe("Objective/instructions for the next run of this agent."),
	overrides: z
		.array(z.string())
		.optional()
		.describe(
			"Override preset names (e.g. ['voice','large']) for the next run.",
		),
});

interface PersistDynamicInput {
	def: AgentDefinition;
	turn: TurnContext;
	system: string;
	historyMessages: ModelMessage[];
	userContent: UserContent;
	replyContent: string;
	hint: string;
}

/**
 * After the main loop, force the model to call `persist` so a follow-up
 * timer is scheduled. No fallback — if the call fails, the agent's chain
 * breaks and the user/log surfaces the error. That's intentional: silent
 * reschedules hide bugs.
 */
async function persistDynamic(input: PersistDynamicInput): Promise<void> {
	const persistTool = tool({
		description:
			"Schedule the next run of this persistent agent. You MUST call this exactly once.",
		inputSchema: persistInputSchema,
		execute: async (i) => i,
	});

	const providerCfg = resolveProvider(input.turn.config?.provider);
	const tier: ModelTier =
		input.turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const modelId = providerCfg[tier];
	const model = createModel(providerCfg.sdk, modelId);

	const messages: ModelMessage[] = [
		...input.historyMessages,
		{ role: "user", content: input.userContent },
	];
	if (input.replyContent) {
		messages.push({ role: "assistant", content: input.replyContent });
	}
	messages.push({
		role: "user",
		content: `Now schedule your next run by calling the \`persist\` tool. Hint: ${input.hint}`,
	});

	log.info(`[persist] forcing tool call for @${input.def.name}`);

	const result = await generateText({
		model,
		system: input.system,
		messages,
		tools: { persist: persistTool },
		toolChoice: { type: "tool", toolName: "persist" },
	});

	const call = result.steps
		.flatMap((s) => s.toolCalls ?? [])
		.find((tc) => tc.toolName === "persist");

	if (!call) {
		throw new Error(`@${input.def.name}: persist tool was not called`);
	}

	const parsed = persistInputSchema.parse(call.input);
	const runAt = computeNextRun(parsed.nextRun);

	await addTimer({
		id: crypto.randomUUID(),
		agentName: input.def.name,
		chatId: input.turn.chatId,
		objective: parsed.prompt,
		runAt,
		createdBy: "persistent",
		createdAt: new Date().toISOString(),
		...(parsed.overrides && parsed.overrides.length > 0
			? { overrides: parsed.overrides }
			: {}),
	});

	log.info(`[persist] @${input.def.name} rescheduled for ${runAt}`);
}

/**
 * Resolve a `nextRun` string (ISO datetime or duration) into a clamped ISO
 * timestamp. Falls back to `settings.persistence.defaultNextRun` on parse
 * failure — the model occasionally hallucinates formats and we'd rather keep
 * the chain alive than throw.
 */
function computeNextRun(nextRun: string): string {
	const min = settings.persistence.minNextRun;
	const max = settings.persistence.maxNextRun;
	const now = Date.now();

	const iso = Date.parse(nextRun);
	if (!Number.isNaN(iso)) {
		const ms = clamp(iso, now + min, now + max);
		return new Date(ms).toISOString();
	}

	const duration = nextRun.match(/^(\d+)([smhd])$/);
	if (duration) {
		const factors: Record<string, number> = {
			s: 1_000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
		};
		const delta =
			parseInt(duration[1] ?? "0", 10) * (factors[duration[2] ?? ""] ?? 0);
		const ms = clamp(now + delta, now + min, now + max);
		return new Date(ms).toISOString();
	}

	log.warn(
		`[persist] unparseable nextRun "${nextRun}", using default ${settings.persistence.defaultNextRun}`,
	);
	return computeNextRun(settings.persistence.defaultNextRun);
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

// ── SDK factory (private) ──────────────────────────────────────────────────

/**
 * Resolve a Vercel AI SDK model for the given sdk + model ID. `@ai-sdk/<sdk>`
 * is imported dynamically so forkers can add providers by installing the
 * package and adding an entry under `settings.providers`.
 */
function createModel(sdk: string, modelId: string): LanguageModel {
	let factory: ((id: string) => LanguageModel) | undefined;
	try {
		const m = require(`@ai-sdk/${sdk}`);
		factory = m[sdk] ?? m.default;
		if (typeof factory !== "function") {
			throw new Error(
				`@ai-sdk/${sdk} does not export a model factory as "${sdk}" or "default"`,
			);
		}
	} catch (err) {
		if (
			err instanceof Error &&
			"code" in err &&
			(err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
		) {
			throw new Error(
				`AI SDK package @ai-sdk/${sdk} not found. Install it: bun add @ai-sdk/${sdk}`,
			);
		}
		throw err;
	}
	return factory(modelId);
}
