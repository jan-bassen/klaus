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
import { z } from "zod";
import { toJSONSchema } from "zod/v4";
import { type ModelTier, resolveProvider, settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { appendTrace, type TraceStep } from "@/infra/store/history";
import { addTimer } from "@/infra/store/timers";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import { enqueueMessage } from "@/infra/whatsapp/send";
import {
	type AssembledTools,
	assembleContext,
	type FunctionToolSet,
	type HistoryOptions,
} from "@/pipeline/context";
import {
	buildSystemPrompt,
	buildUserMessage,
	resolveSampling,
	type UserContent,
} from "@/pipeline/prompts";
import { emitReport } from "@/pipeline/reports";
import { REPLY_TOOL_NAME } from "@/primitives/tools/reply";
import type { Variable } from "@/primitives/variables";
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
	finishReason?: string | undefined;
	usage?: { inputTokens: number; outputTokens: number } | undefined;
}

export interface AgentRunResult {
	usage: { promptTokens: number; completionTokens: number };
	durationMs: number;
	steps: ModelCallStep[];
	model: string;
	tier: string;
	/** Verbatim transcript that hit the model — full prompts for `report: "full"`. */
	historyMessages: ChatMessage[];
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
	historyMessages: ChatMessage[];
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
 * drive the chat-completions API to produce an `AgentRunResult`.
 * Most callers want `executeAgent` instead.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
	const { turn, def, system, userContent, tools, historyMessages } = input;

	const { config: providerCfg } = resolveProvider();
	const tier: ModelTier =
		turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const modelId = providerCfg[tier];
	const toolChoice = turn.config?.toolChoice;
	const stepLimit = turn.config?.stepLimit ?? settings.agent.maxSteps;
	const sampling = resolveSampling(turn.config);

	log.info(`[agent] calling ${modelId} for @${def.name}`);

	const initialMessages: ChatMessage[] = [
		...historyMessages,
		{ role: "user", content: userContent },
	];

	const result = await runLoop({
		modelId,
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
		tier,
		historyMessages,
		systemPrompt: system,
		userMessage: userMessageStr,
		replyContent,
	};
}

// ── Loop core (private) ────────────────────────────────────────────────────

interface RunLoopOptions {
	modelId: string;
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
				? { temperature: opts.temperature }
				: {}),
			...(opts.topP !== undefined ? { topP: opts.topP } : {}),
			...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
			...(hasTools ? { tools: requestTools } : {}),
			...(hasTools && opts.toolChoice
				? { toolChoice: opts.toolChoice as ChatToolChoice }
				: {}),
		};

		const response = await callWithRetry(requestBody, opts.modelId);
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
		const toolCalls = rawCalls.map((tc) => ({
			toolCallId: tc.id,
			toolName: tc.function.name,
			args: parseArgs(tc.function.arguments),
		}));

		const toolResults = await Promise.all(
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

		const reasoning = typeof msg.reasoning === "string" ? msg.reasoning : "";
		steps.push({
			reasoning,
			toolCalls,
			toolResults,
			finishReason: choice.finishReason ?? undefined,
			usage: { inputTokens, outputTokens },
		});

		if (toolCalls.length === 0) break;

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

async function callWithRetry(body: ChatRequest, modelId: string) {
	const { config: providerCfg, apiKey } = resolveProvider();
	const timeoutMs = settings.agent.timeout;
	const MAX_ATTEMPTS = settings.agent.retries.max;

	const client = new OpenRouter({
		apiKey,
		serverURL: providerCfg.baseURL,
		retryConfig: { strategy: "none" },
	});

	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const ac = new AbortController();
		const timeoutId = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const response = await client.chat.send(
				{ chatRequest: { ...body, stream: false } },
				{ signal: ac.signal },
			);
			clearTimeout(timeoutId);
			return response;
		} catch (err) {
			clearTimeout(timeoutId);
			const isAbort = err instanceof DOMException && err.name === "AbortError";
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

// ── Dynamic persistence (forced tool call) ─────────────────────────────────

const PERSIST_TOOL_NAME = "persist";

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
	historyMessages: ChatMessage[];
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
	const { config: providerCfg, apiKey } = resolveProvider();
	const tier: ModelTier =
		input.turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const modelId = providerCfg[tier];

	const messages: ChatMessage[] = [
		...input.historyMessages,
		{ role: "user", content: input.userContent },
	];
	if (input.replyContent) {
		messages.push({ role: "assistant", content: input.replyContent });
	}
	messages.push({
		role: "user",
		content: `Now schedule your next run by calling the \`${PERSIST_TOOL_NAME}\` tool. Hint: ${input.hint}`,
	});

	log.info(`[persist] forcing tool call for @${input.def.name}`);

	const persistTool: ChatTool = {
		type: "function",
		function: {
			name: PERSIST_TOOL_NAME,
			description:
				"Schedule the next run of this persistent agent. You MUST call this exactly once.",
			parameters: toJSONSchema(persistInputSchema as never) as Record<
				string,
				unknown
			>,
		},
	};

	const client = new OpenRouter({
		apiKey,
		serverURL: providerCfg.baseURL,
		retryConfig: { strategy: "none" },
	});

	const response = await client.chat.send({
		chatRequest: {
			model: modelId,
			messages: [{ role: "system", content: input.system }, ...messages],
			tools: [persistTool],
			toolChoice: { type: "function", function: { name: PERSIST_TOOL_NAME } },
			stream: false,
		},
	});

	const call = response.choices[0]?.message.toolCalls?.find(
		(tc): tc is ChatToolCall =>
			tc.type === "function" && tc.function.name === PERSIST_TOOL_NAME,
	);

	if (!call) {
		throw new Error(`@${input.def.name}: persist tool was not called`);
	}

	const parsed = persistInputSchema.parse(parseArgs(call.function.arguments));
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
