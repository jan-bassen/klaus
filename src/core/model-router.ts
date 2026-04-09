import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { log } from "@/logger";
import { type ModelTier, resolveProvider, settings } from "@/settings";
import { createModel } from "./provider-factory";
import { checkModelRate } from "./rate-limiter";

export class LlmTimeoutError extends Error {
	constructor(modelId: string, timeoutMs: number) {
		super(`LLM call timed out after ${timeoutMs}ms (model: ${modelId})`);
		this.name = "LlmTimeoutError";
	}
}

export interface ModelCallOptions {
	tier: ModelTier;
	chatId?: string;
	/** Override provider name (e.g. "claude", "chatgpt", "gemini") for this call. */
	provider?: string | undefined;
	system?: string;
	messages: ModelMessage[];
	tools?: ToolSet;
	schema?: unknown;
	messageId?: string;
	agentName?: string;
	/** Initial active tool names (allowlist). If omitted, all tools are active. */
	activeTools?: string[];
	/** Called before each step; return updated active tool names to expand the allowlist. */
	prepareStep?: (steps: StepResult<ToolSet>[]) => string[];
	/** Override temperature. Range varies by provider (0–1 for Claude, 0–2 for OpenAI/Gemini). */
	temperature?: number;
	/** Override nucleus sampling (topP). If omitted, uses provider default. */
	topP?: number;
	/** Tool choice constraint: "none" disables tools, "required" forces tool use. */
	toolChoice?: "none" | "required";
	/** Structured output schema (e.g. Output.object). Passed directly to generateText. */
	output?: unknown;
	/** Provider-specific options passed through to the AI SDK's providerOptions. */
	providerOptions?: Record<string, Record<string, unknown>>;
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

export interface ModelCallResult {
	content: string;
	usage: {
		promptTokens: number;
		completionTokens: number;
	};
	steps: ModelCallStep[];
	durationMs: number;
	/** Structured output from Output.object(), if provided. */
	output?: unknown;
}

/**
 * Returns true for transient errors that are safe to retry (network blips, 5xx).
 * Timeouts and rate-limit errors are definitive and must not be retried.
 */
function isRetryable(err: unknown): boolean {
	if (err instanceof LlmTimeoutError) return false;
	if (err instanceof Error && /rate.?limit/i.test(err.message)) return false;
	if (err instanceof Error && /prompt is too long/i.test(err.message))
		return false;
	return true;
}

/**
 * Resolves the model tier to a provider+model, enforces the LLM-level rate limit,
 * calls the Vercel AI SDK, and records the full invocation trace including cost.
 */
export async function callModel(
	opts: ModelCallOptions,
): Promise<ModelCallResult> {
	const rate = checkModelRate();
	if (!rate.allowed) {
		log.warn("[model-router] LLM rate limited", {
			retryAfterMs: rate.retryAfterMs,
		});
		throw new Error(`LLM rate limit exceeded. Retry in ${rate.retryAfterMs}ms`);
	}

	const providerCfg = resolveProvider(opts.provider);
	const modelId = providerCfg[opts.tier];
	const model = createModel(providerCfg.sdk, modelId);

	const startTime = Date.now();
	const timeoutMs = settings.llm.timeoutMs;

	// Retry transient failures (network errors, 5xx) with exponential backoff.
	const MAX_ATTEMPTS = settings.retries.max;
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
					...(opts.output ? { output: opts.output as never } : {}),
					...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
					...(opts.providerOptions
						? {
								providerOptions: opts.providerOptions as ProviderOptions,
							}
						: {}),
					...(opts.tools && Object.keys(opts.tools).length > 0
						? {
								tools: opts.tools,
								stopWhen: stepCountIs(settings.llm.maxSteps),
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
			break; // success — exit retry loop
		} catch (err) {
			clearTimeout(timeoutId);
			lastErr = err;
			if (!isRetryable(err)) {
				log.error("[model-router] generateText failed (non-retryable)", {
					model: modelId,
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
				throw err;
			}
			if (attempt < MAX_ATTEMPTS) {
				const delayMs = settings.retries.backoffMs * 2 ** (attempt - 1);
				log.warn("[model-router] generateText failed, retrying", {
					model: modelId,
					attempt,
					delayMs,
					error: err instanceof Error ? err.message : String(err),
				});
				await new Promise<void>((r) => setTimeout(r, delayMs));
			}
		}
	}
	if (!result) {
		log.error("[model-router] generateText failed after all retries", {
			model: modelId,
			error: lastErr instanceof Error ? lastErr.message : String(lastErr),
			stack: lastErr instanceof Error ? lastErr.stack : undefined,
		});
		throw lastErr;
	}

	const durationMs = Date.now() - startTime;

	// Aggregate token usage across all steps.
	const promptTokens = result.steps.reduce(
		(s, st) => s + (st.usage.inputTokens ?? 0),
		0,
	);
	const completionTokens = result.steps.reduce(
		(s, st) => s + (st.usage.outputTokens ?? 0),
		0,
	);

	const modelSteps: ModelCallStep[] = result.steps.map((s) => ({
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
		steps: modelSteps,
		durationMs,
		...("output" in result && result.output !== undefined
			? { output: result.output }
			: {}),
	};
}
