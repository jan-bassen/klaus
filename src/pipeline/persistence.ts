import { OpenRouter } from "@openrouter/sdk";
import type {
	ChatMessages as ChatMessage,
	ChatFunctionTool as ChatTool,
	ChatToolCall,
} from "@openrouter/sdk/models";
import { z } from "zod";
import { toJSONSchema } from "zod/v4";
import { type ModelTier, resolveModel, settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { addTimer } from "../infra/store/timers.ts";
import type { AgentDefinition } from "./agents.ts";
import type { TurnContext } from "./core.ts";
import {
	renderTemplate,
	textOnlyUserContent,
	type UserContent,
} from "./templates.ts";

const PERSIST_TOOL_NAME = "persist";

const persistInputSchema = z.object({
	nextRun: z
		.string({
			error: "nextRun must be an ISO datetime or a duration like '6h'.",
		})
		.min(1, {
			error: "nextRun must be an ISO datetime or a duration like '6h'.",
		})
		.describe(
			"When to run again. ISO 8601 datetime (e.g. 2026-04-23T08:00:00Z) or duration like '6h', '30m', '2d'.",
		),
	prompt: z
		.string({
			error: "prompt must describe the objective for the next run.",
		})
		.min(1, {
			error: "prompt must describe the objective for the next run.",
		})
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
	overrides: string[];
	signal?: AbortSignal;
}

/**
 * After the main loop, force the model to call `persist` so a follow-up
 * timer is scheduled. No fallback — if the call fails, the agent's chain
 * breaks and the user/log surfaces the error. That's intentional: silent
 * reschedules hide bugs.
 */
export async function persistDynamic(
	input: PersistDynamicInput,
): Promise<void> {
	const provider = input.turn.config?.provider ?? settings.defaultProvider;
	const tier: ModelTier =
		input.turn.config?.modelTier ?? settings.agentDefaults.modelTier;
	const { baseURL, apiKey, modelId } = resolveModel(provider, tier);

	const messages: ChatMessage[] = [
		...input.historyMessages,
		{ role: "user", content: textOnlyUserContent(input.userContent) },
	];
	if (input.replyContent) {
		messages.push({ role: "assistant", content: input.replyContent });
	}
	messages.push({
		role: "user",
		content: renderTemplate("persistence", {
			toolName: PERSIST_TOOL_NAME,
			hint: input.hint,
		}),
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
		serverURL: baseURL,
		retryConfig: { strategy: "none" },
	});

	const response = await client.chat.send(
		{
			chatRequest: {
				model: modelId,
				messages: [{ role: "system", content: input.system }, ...messages],
				tools: [persistTool],
				toolChoice: { type: "function", function: { name: PERSIST_TOOL_NAME } },
				stream: false,
			},
		},
		input.signal ? { signal: input.signal } : undefined,
	);

	const call = response.choices[0]?.message.toolCalls?.find(
		(tc): tc is ChatToolCall =>
			tc.type === "function" && tc.function.name === PERSIST_TOOL_NAME,
	);

	if (!call) {
		throw new Error(`@${input.def.name}: persist tool was not called`);
	}

	const parsed = persistInputSchema.parse(parseArgs(call.function.arguments));
	const runAt = computeNextRun(parsed.nextRun);
	const overrides = mergeOverrides(input.overrides, parsed.overrides);

	await addTimer({
		id: crypto.randomUUID(),
		agentName: input.def.name,
		objective: parsed.prompt,
		runAt,
		createdBy: "persistent",
		createdAt: new Date().toISOString(),
		...(overrides.length > 0 ? { overrides } : {}),
	});

	log.info(`[persist] @${input.def.name} rescheduled for ${runAt}`);
}

function mergeOverrides(base: string[], next: string[] | undefined): string[] {
	return [...new Set([...base, ...(next ?? [])])];
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

function parseArgs(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		log.warn("[persist] failed to parse tool call arguments JSON", {
			raw: raw.slice(0, 200),
		});
		return {};
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}
