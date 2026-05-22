/**
 * Agent core loop: take a fully-prepared turn (config, context, prompts) and
 * drive an OpenAI-compatible /chat/completions endpoint to produce an
 * `AgentRunResult`.
 *
 * The orchestrator (`pipeline/index.ts`) handles parsing, config, context, and
 * prompt assembly. By the time we get here, everything is in place and we just
 * call the model and post-process.
 */

import { OpenRouter } from "@openrouter/sdk";
import type {
	ChatMessages as ChatMessage,
	ChatRequest,
	ChatFunctionTool as ChatTool,
	ChatToolCall,
	ChatToolChoice,
} from "@openrouter/sdk/models";
import { OpenRouterError } from "@openrouter/sdk/models/errors";
import { toJSONSchema } from "zod/v4";
import { type ModelTier, resolveModel, settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { appendTrace, type TraceStep } from "../infra/store/history.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
import { REPLY_TOOL_NAME } from "../primitives/tools/reply.ts";
import type { Variable } from "../primitives/variables/index.ts";
import type { AgentDefinition } from "./agents.ts";
import {
	type AssembledTools,
	assembleContext,
	type FunctionToolSet,
	type HistoryOptions,
} from "./context.ts";
import type { TurnConfig } from "./overrides.ts";
import { persistDynamic } from "./persistence.ts";
import {
	buildSystemPrompt,
	buildUserMessage,
	resolveSampling,
	textOnlyUserContent,
	type UserContent,
} from "./prompts.ts";
import { emitReport } from "./reports.ts";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * What kicked off this run. Discriminated by `kind`; the source-id field is
 * named for what it points to so destructuring stays self-documenting.
 *
 * - `message`  — a user-typed WhatsApp message
 * - `schedule` — a cron-fired schedule (`Klaus/agents/*.md` frontmatter schedule)
 * - `timer`    — a one-shot timer (incl. dynamic-persistence reschedules)
 * - `dispatch` — another agent invoked us inline via the dispatch tool
 */
export type Trigger =
	| { kind: "message"; messageId: string }
	| { kind: "schedule"; scheduleId: string }
	| { kind: "timer"; timerId: string }
	| { kind: "dispatch"; parentRunId: string };

export interface ScheduleContext {
	id: string;
	pattern: string;
	label?: string;
}

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
	/** The prompt a parent, timer, or tool-created schedule handed to this agent. */
	dispatchContext?: { prompt: string };
	/** Present for generated frontmatter schedules while rendering # Message. */
	schedule?: ScheduleContext;
	/** @internal — collects reply content for inline-dispatched agents instead of sending to WhatsApp */
	_replyCollector?: string[];
}

export class LlmTimeoutError extends Error {
	constructor(modelId: string, timeoutMs: number) {
		super(`LLM call timed out after ${timeoutMs}ms (model: ${modelId})`);
		this.name = "LlmTimeoutError";
	}
}

export function isAbortError(err: unknown): boolean {
	return err instanceof DOMException && err.name === "AbortError";
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
	fallback?: "assistant_content_reply" | undefined;
	finishReason?: string | undefined;
	usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface AgentRunResult {
	usage: { promptTokens: number; completionTokens: number };
	durationMs: number;
	steps: ModelCallStep[];
	model: string;
	tier: string;
	context: {
		variables: string[];
		tools: string[];
		toolsets: string[];
		skills: string[];
	};
	historyMessages: ChatMessage[];
	systemPrompt: string;
	userMessage: string;
	replyContent: string;
}

interface RunAgentInput {
	turn: TurnContext;
	def: AgentDefinition;
	system: string;
	userContent: UserContent;
	variables: Variable[];
	tools: AssembledTools;
	historyMessages: ChatMessage[];
	signal?: AbortSignal;
}

interface ExecuteAgentInput {
	/** Partial turn — vars are assembled inside `executeAgent`. */
	turn: Omit<TurnContext, "vars">;
	def: AgentDefinition;
	variables: Variable[];
	history?: HistoryOptions;
	signal?: AbortSignal;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * High-level: take a partial turn and run the full agent end-to-end.
 * Assembles context (vars + tools + history), compiles prompts, then calls
 * `runAgent`. Used by both the inbound pipeline and dispatch.
 *
 * Emits a per-turn report (when `turn.config.report !== false`) on both
 * success and failure paths. Reporting catches its own errors so it cannot
 * mask the original turn result, but executeAgent waits for it so writes and
 * report logs are flushed before the turn is considered complete.
 */
export async function executeAgent(
	input: ExecuteAgentInput,
): Promise<AgentRunResult> {
	const startedAt = Date.now();
	const reportEnabled = input.turn.config.report !== false;

	let fullTurn: TurnContext = { ...input.turn, vars: {} };

	try {
		const ctx = await assembleContext(input.turn, input.def, {
			variables: input.variables,
			...(input.history ? { history: input.history } : {}),
		});
		fullTurn = input.turn as TurnContext;

		const system = buildSystemPrompt(input.def.prompt.system, ctx.vars);
		const userContent = await buildUserMessage(fullTurn);

		const result = await runAgent({
			turn: fullTurn,
			def: input.def,
			system,
			userContent,
			variables: input.variables,
			tools: ctx.tools,
			historyMessages: ctx.history.messages,
			...(input.signal ? { signal: input.signal } : {}),
		});

		if (input.def.persistence) {
			await persistDynamic({
				def: input.def,
				turn: fullTurn,
				system,
				historyMessages: ctx.history.messages,
				userContent,
				replyContent: result.replyContent,
				hint: input.def.persistence.hint,
				overrides: input.def.persistence.overrides,
				...(input.signal ? { signal: input.signal } : {}),
			});
		}

		if (reportEnabled) {
			await emitReport({ turn: fullTurn, startedAt, result });
		}

		return result;
	} catch (err) {
		if (reportEnabled && !isAbortError(err)) {
			await emitReport({ turn: fullTurn, startedAt, error: err });
		}
		throw err;
	}
}

/**
 * Low-level: take a fully-prepared turn (config, context, prompts) and
 * drive the chat-completions API to produce an `AgentRunResult`.
 * Most callers want `executeAgent` instead.
 */
async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
	const { turn, def, system, userContent, variables, tools, historyMessages } =
		input;

	const provider = turn.config?.provider ?? settings.defaultProvider;
	const tier: ModelTier =
		turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const { baseURL, apiKey, modelId, tempScale } = resolveModel(provider, tier);
	const toolChoice = turn.config?.toolChoice;
	const stepLimit = turn.config?.stepLimit ?? settings.agent.maxSteps;
	const sampling = resolveSampling(turn.config);

	log.info(`[agent] calling ${modelId} (${provider}/${tier}) for @${def.name}`);

	const initialMessages: ChatMessage[] = [
		...historyMessages,
		{ role: "user", content: userContent },
	];

	const result = await runLoop({
		baseURL,
		apiKey,
		modelId,
		tempScale,
		system,
		messages: initialMessages,
		tools,
		stepLimit,
		toolChoice:
			toolChoice === "none"
				? "none"
				: toolChoice === "required"
					? "required"
					: undefined,
		temperature: sampling.temperature,
		topP: sampling.topP,
		reasoning: sampling.reasoning,
		runId: turn.runId,
		agentName: def.name,
		...(input.signal ? { signal: input.signal } : {}),
	});

	// Fire-and-forget — trace persistence is best-effort, never blocks reply.
	// Skipped under ghost so ephemeral runs don't pollute the conversation log.
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
		.flatMap((step) => acceptedReplyContents(step))
		.join("\n---\n");

	const userMessageStr = textOnlyUserContent(userContent);

	return {
		usage: result.usage,
		durationMs: result.durationMs,
		steps: result.steps,
		model: modelId,
		tier,
		context: {
			variables: sortedUnique(variables.map((v) => v.key)),
			tools: sortedUnique([
				...def.tools.filter((name) => tools.functionTools[name] !== undefined),
				...tools.serverTools.map((t) => t.type),
			]),
			toolsets: sortedUnique(
				(def.toolsets ?? []).filter((name) =>
					tools.initialActive.includes(`load_${name}`),
				),
			),
			skills: sortedUnique(def.skills ?? []),
		},
		historyMessages,
		systemPrompt: system,
		userMessage: userMessageStr,
		replyContent,
	};
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function acceptedReplyContents(step: ModelCallStep): string[] {
	return step.toolCalls.flatMap((call) => {
		if (call.toolName !== REPLY_TOOL_NAME) return [];

		const result = step.toolResults.find(
			(toolResult) => toolResult.toolCallId === call.toolCallId,
		);
		if (isToolError(result?.result)) return [];

		const content = call.args.content;
		return typeof content === "string" && content.trim() ? [content] : [];
	});
}

function isToolError(result: unknown): boolean {
	return (
		typeof result === "object" &&
		result !== null &&
		"error" in result &&
		typeof result.error === "string"
	);
}

// ── Loop core (private) ────────────────────────────────────────────────────

interface RunLoopOptions {
	baseURL: string;
	apiKey: string;
	modelId: string;
	/** Native temperature scale of the provider — opts.temperature is multiplied by this before send. */
	tempScale: number;
	system: string;
	messages: ChatMessage[];
	tools: AssembledTools;
	stepLimit: number;
	toolChoice?: "none" | "required" | undefined;
	temperature?: number | undefined;
	topP?: number | undefined;
	reasoning?: { effort: "low" | "high" } | undefined;
	runId: string;
	agentName: string;
	signal?: AbortSignal;
}

interface RunLoopResult {
	usage: { promptTokens: number; completionTokens: number };
	steps: ModelCallStep[];
	durationMs: number;
}

async function runLoop(opts: RunLoopOptions): Promise<RunLoopResult> {
	const startTime = Date.now();
	const { tools } = opts;

	const messages: ChatMessage[] = [...opts.messages];
	let active =
		opts.toolChoice === "none" ? [REPLY_TOOL_NAME] : tools.initialActive;
	const steps: ModelCallStep[] = [];
	let totalIn = 0;
	let totalOut = 0;

	for (let i = 0; i < opts.stepLimit; i++) {
		if (opts.signal?.aborted) break;

		const requestTools = buildRequestTools(
			tools.functionTools,
			tools.serverTools,
			active,
		);
		const hasTools = requestTools.length > 0;

		const requestBody: ChatRequest = {
			model: opts.modelId,
			messages: [
				...(opts.system
					? [{ role: "system" as const, content: opts.system }]
					: []),
				...messages,
			],
			...(opts.temperature !== undefined
				? { temperature: opts.temperature * opts.tempScale }
				: {}),
			...(opts.topP !== undefined ? { topP: opts.topP } : {}),
			...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
			...(hasTools ? { tools: requestTools } : {}),
			...(hasTools && opts.toolChoice
				? { toolChoice: opts.toolChoice as ChatToolChoice }
				: {}),
		};

		const response = await callWithRetry(
			requestBody,
			opts.modelId,
			opts.baseURL,
			opts.apiKey,
			opts.signal,
		);
		const choice = response.choices[0];
		if (!choice) {
			throw new Error(
				`[agent] ${opts.modelId} returned no choices for @${opts.agentName}`,
			);
		}
		const msg = choice.message;
		const inputTokens = response.usage?.promptTokens ?? 0;
		const outputTokens = response.usage?.completionTokens ?? 0;
		totalIn += inputTokens;
		totalOut += outputTokens;

		// Narrow to function-type tool calls (the only kind we care about — custom
		// tool calls aren't part of Klaus's surface).
		const rawCalls = (msg.toolCalls ?? []).filter(
			(tc): tc is ChatToolCall => tc.type === "function",
		);
		let toolCalls = rawCalls.map((tc) => ({
			toolCallId: tc.id,
			toolName: tc.function.name,
			args: parseArgs(tc.function.arguments),
		}));

		let fallback: ModelCallStep["fallback"];
		if (toolCalls.length === 0) {
			const fallbackReply = directReplyFallback(
				msg.content,
				active,
				opts.toolChoice,
				steps.some((step) =>
					step.toolCalls.some((call) => call.toolName === REPLY_TOOL_NAME),
				),
			);
			if (fallbackReply) {
				log.warn(
					`[agent] @${opts.agentName} returned direct assistant content; sending as fallback reply`,
				);
				toolCalls = [
					{
						toolCallId: `fallback-reply-${i + 1}`,
						toolName: REPLY_TOOL_NAME,
						args: { content: fallbackReply },
					},
				];
				fallback = "assistant_content_reply";
			}
		}

		const toolResults = await executeToolCalls(toolCalls, tools);

		const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
		steps.push({
			reasoning,
			toolCalls,
			toolResults,
			fallback,
			finishReason: choice.finishReason ?? undefined,
			usage: { inputTokens, outputTokens },
		});

		if (toolCalls.length === 0 || fallback) break;

		// Append assistant message + tool responses to the running conversation
		// for the next step. Pass through the raw toolCalls (unparsed args) to
		// preserve the wire-shape the model produced.
		messages.push({
			role: "assistant",
			content: typeof msg.content === "string" ? msg.content : "",
			toolCalls: rawCalls,
		});
		for (const tr of toolResults) {
			messages.push({
				role: "tool",
				toolCallId: tr.toolCallId,
				content:
					typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
			});
		}

		active = tools.prepareStep(steps);
	}

	return {
		usage: { promptTokens: totalIn, completionTokens: totalOut },
		steps,
		durationMs: Date.now() - startTime,
	};
}

async function executeToolCalls(
	toolCalls: ModelCallStep["toolCalls"],
	tools: AssembledTools,
): Promise<ModelCallStep["toolResults"]> {
	return Promise.all(
		toolCalls.map(async (tc) => {
			const t = tools.functionTools[tc.toolName];
			if (!t) {
				return {
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					result: { error: `Unknown tool: ${tc.toolName}` },
				};
			}
			try {
				const result = await t.execute(tc.args);
				return { toolCallId: tc.toolCallId, toolName: tc.toolName, result };
			} catch (err) {
				return {
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					result: {
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		}),
	);
}

function directReplyFallback(
	content: unknown,
	activeTools: string[],
	toolChoice: RunLoopOptions["toolChoice"],
	hasPriorReply: boolean,
): string | undefined {
	if (
		hasPriorReply ||
		toolChoice === "none" ||
		!activeTools.includes(REPLY_TOOL_NAME)
	) {
		return undefined;
	}
	if (typeof content !== "string") return undefined;
	const trimmed = content.trim();
	return trimmed ? trimmed : undefined;
}

function parseArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		log.warn("[agent] failed to parse tool call arguments JSON", {
			raw: raw.slice(0, 200),
		});
		return {};
	}
}

function buildRequestTools(
	functionTools: FunctionToolSet,
	serverTools: ChatTool[],
	active: string[],
): ChatTool[] {
	const out: ChatTool[] = [];
	for (const name of active) {
		const t = functionTools[name];
		if (!t) continue;
		out.push({
			type: "function",
			function: {
				name,
				description: t.description,
				// zod schemas cross a runtime-compatible but TS-incompatible boundary
				// between zod v3 (used elsewhere) and v4's toJSONSchema (only here).
				parameters: toJSONSchema(t.inputSchema as never) as Record<
					string,
					unknown
				>,
			},
		});
	}
	out.push(...serverTools);
	return out;
}

/** Retryable = transient (network blip, 5xx). Timeouts and rate limits are not. */
function isRetryable(err: unknown): boolean {
	if (err instanceof LlmTimeoutError) return false;
	if (err instanceof OpenRouterError) {
		if (err.statusCode === 429) return false;
		if (err.statusCode >= 400 && err.statusCode < 500) return false;
		return true;
	}
	if (err instanceof Error && /rate.?limit/i.test(err.message)) return false;
	if (err instanceof Error && /prompt is too long/i.test(err.message))
		return false;
	return true;
}

async function callWithRetry(
	body: ChatRequest,
	modelId: string,
	baseURL: string,
	apiKey: string,
	signal?: AbortSignal,
) {
	const timeoutMs = settings.agent.timeout;
	const MAX_ATTEMPTS = settings.agent.retries.max;

	const client = new OpenRouter({
		apiKey,
		serverURL: baseURL,
		retryConfig: { strategy: "none" },
	});

	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const timeoutAc = new AbortController();
		const timeoutId = setTimeout(() => timeoutAc.abort(), timeoutMs);
		const combinedSignal = signal
			? AbortSignal.any([timeoutAc.signal, signal])
			: timeoutAc.signal;
		try {
			const response = await client.chat.send(
				{ chatRequest: { ...body, stream: false } },
				{ signal: combinedSignal },
			);
			clearTimeout(timeoutId);
			return response;
		} catch (err) {
			clearTimeout(timeoutId);
			if (isAbortError(err) && signal?.aborted) {
				throw err;
			}
			const isAbort = isAbortError(err);
			const wrapped = isAbort ? new LlmTimeoutError(modelId, timeoutMs) : err;
			lastErr = wrapped;
			if (!isRetryable(wrapped)) {
				log.error(`[agent] ${modelId} call failed (non-retryable)`, {
					error: wrapped instanceof Error ? wrapped.message : String(wrapped),
				});
				throw wrapped;
			}
			if (attempt < MAX_ATTEMPTS) {
				const delayMs = settings.agent.retries.backoffMs * 2 ** (attempt - 1);
				log.warn(
					`[agent] ${modelId} call failed, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`,
					{
						error: wrapped instanceof Error ? wrapped.message : String(wrapped),
					},
				);
				await new Promise<void>((r) => setTimeout(r, delayMs));
			}
		}
	}

	log.error(`[agent] ${modelId} call failed after all retries`, {
		error: lastErr instanceof Error ? lastErr.message : String(lastErr),
	});
	throw lastErr;
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
