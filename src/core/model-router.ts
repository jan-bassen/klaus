import { anthropic } from "@ai-sdk/anthropic";
import type { ModelMessage, StepResult, ToolSet } from "ai";
import { generateText, stepCountIs } from "ai";
import { config, type ModelTier } from "@/config";
import { log } from "@/logger";
import { recordCost } from "@/store/costs";
import { recordInvocation } from "@/store/invocations";
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
	system?: string;
	messages: ModelMessage[];
	tools?: ToolSet;
	schema?: unknown;
	messageId?: string;
	taskId?: string;
	agentName?: string;
	/** Initial active tool names (allowlist). If omitted, all tools are active. */
	activeTools?: string[];
	/** Called before each step; return updated active tool names to expand the allowlist. */
	prepareStep?: (steps: StepResult<ToolSet>[]) => string[];
}

export interface ModelCallResult {
	content: string;
	usage: {
		promptTokens: number;
		completionTokens: number;
		costUsd: number;
	};
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

	const modelId = config.models[opts.tier];
	const model = anthropic(modelId);

	const startTime = Date.now();
	const timeoutMs = config.llm.timeoutMs;

	// Retry transient failures (network errors, 5xx) with exponential backoff.
	const MAX_ATTEMPTS = 3;
	let result: Awaited<ReturnType<typeof generateText>> | undefined;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new LlmTimeoutError(modelId, timeoutMs)),
					timeoutMs,
				),
			);
			result = await Promise.race([
				generateText({
					model,
					...(opts.system ? { system: opts.system } : {}),
					messages: opts.messages,
					...(opts.tools && Object.keys(opts.tools).length > 0
						? {
								tools: opts.tools,
								stopWhen: stepCountIs(10),
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
			break; // success — exit retry loop
		} catch (err) {
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
				const delayMs = 1_000 * 2 ** (attempt - 1); // 1s, 2s
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
	const modelPricing = config.pricing[modelId];
	const costUsd = modelPricing
		? (promptTokens / 1_000_000) * modelPricing.inputPerMTok +
			(completionTokens / 1_000_000) * modelPricing.outputPerMTok
		: 0;
	if (!modelPricing) {
		log.warn("[model-router] no pricing entry for model — recording 0", {
			model: modelId,
		});
	}

	// Serialize steps for debugging.
	const steps = result.steps.map((s) => ({
		text: s.text,
		reasoning: s.reasoning,
		toolCalls: s.toolCalls,
		toolResults: s.toolResults,
		finishReason: s.finishReason,
		usage: s.usage,
	}));

	const userMessage =
		opts.messages.length > 0
			? typeof opts.messages[0]?.content === "string"
				? opts.messages[0]?.content
				: JSON.stringify(opts.messages[0]?.content)
			: undefined;

	recordInvocation({
		agent: opts.agentName ?? "unknown",
		model: modelId,
		...(opts.messageId ? { messageId: opts.messageId } : {}),
		...(opts.taskId ? { taskId: opts.taskId } : {}),
		...(opts.system ? { systemPrompt: opts.system } : {}),
		...(userMessage ? { userMessage } : {}),
		steps,
		promptTokens,
		completionTokens,
		durationMs,
	}).catch((err) =>
		log.warn("[model-router] failed to record invocation", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);

	if (costUsd > 0) {
		recordCost(
			"llm",
			promptTokens + completionTokens,
			costUsd,
			opts.chatId,
		).catch((err) =>
			log.warn("[cost] failed to record llm cost", {
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}

	return {
		content: result.text,
		usage: { promptTokens, completionTokens, costUsd },
	};
}
