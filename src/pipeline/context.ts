/**
 * Per-turn context assembly: variables, tools, history.
 *
 * One module so the three legs can be reasoned about together — they share
 * the same `turn` and feed the same prompt/agent loop downstream. The
 * orchestrator (`assembleContext`) runs vars + history in parallel; tools
 * are built last because their `execute` closures need the full turn (vars
 * resolved) to render their replies.
 */

import type {
	ChatMessages as ChatMessage,
	ChatFunctionTool as ChatTool,
} from "@openrouter/sdk/models";
import type { z } from "zod";
import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { fakeExternal, fakeStateful, getOverlay } from "../infra/simulation.ts";
import { getConversation, getTraces } from "../infra/store/history.ts";
import type { ToolDefinition } from "../primitives/tools/index.ts";
import {
	generateMetaTool,
	toolRegistry,
	toolsetRegistry,
} from "../primitives/tools/index.ts";
import { getProviderTool } from "../primitives/tools/provider.ts";
import { REPLY_TOOL_NAME } from "../primitives/tools/reply.ts";
import { buildSkillTool, skillRegistry } from "../primitives/tools/skill.ts";
import type { Variable } from "../primitives/variables/index.ts";
import type { AgentDefinition } from "./agents.ts";
import type { ModelCallStep, TurnContext } from "./core.ts";
import { renderTemplate } from "./prompts.ts";

// ── Variables ──────────────────────────────────────────────────────────────

/**
 * Run all variables in parallel; defer those marked `after: true` to a second
 * pass that sees the partial namespace via `turn.vars` (used by `snippets`
 * to compile against the full variable set).
 */
async function assembleVariables(
	turn: Omit<TurnContext, "vars">,
	variables: Variable[],
): Promise<Record<string, unknown>> {
	const result: Record<string, unknown> = {};
	const first = variables.filter((v) => !v.after);
	const second = variables.filter((v) => v.after);

	await runVariablePhase(turn, first, result, "variable");

	const enriched = { ...turn, vars: result };
	await runVariablePhase(enriched, second, result, "after-variable");

	return result;
}

async function runVariablePhase(
	turn: Omit<TurnContext, "vars"> & { vars?: Record<string, unknown> },
	variables: Variable[],
	out: Record<string, unknown>,
	label: string,
): Promise<void> {
	const settled = await Promise.allSettled(
		variables.map(async (v) => ({ key: v.key, value: await v.run(turn) })),
	);
	for (const outcome of settled) {
		if (outcome.status === "fulfilled") {
			out[outcome.value.key] = outcome.value.value;
		} else {
			log.error(`[context] ${label} failed`, {
				error:
					outcome.reason instanceof Error
						? outcome.reason.message
						: String(outcome.reason),
			});
		}
	}
}

// ── Tools ──────────────────────────────────────────────────────────────────

/**
 * Internal client-executable tool shape — what the loop needs to dispatch a
 * function tool call. The zod `inputSchema` flows out as JSON Schema for the
 * outgoing request; `execute` is a closure that already binds the turn.
 */
interface FunctionTool {
	description: string;
	inputSchema: z.ZodTypeAny;
	execute(input: unknown): Promise<unknown>;
}

export type FunctionToolSet = Record<string, FunctionTool>;

export interface AssembledTools {
	/** Client-executable function tools, keyed by SDK-safe (underscored) name. */
	functionTools: FunctionToolSet;
	/** Server tools (e.g. openrouter:web_search). Always included verbatim. */
	serverTools: ChatTool[];
	/** Function-tool names exposed in the first request. */
	initialActive: string[];
	/** After each step, returns the updated active function-tool name list. */
	prepareStep: (steps: ModelCallStep[]) => string[];
}

/**
 * Per-call tool dispatcher. Honours `turn.config.simulate`:
 *   - external → never invoke real `execute`; return a plausible fake
 *   - stateful → call the tool's `simulate` handler if declared; else fake
 *   - pure     → pass through
 *
 * Every faked call is recorded on the turn's overlay so the report can
 * surface exactly what would have happened.
 */
async function invokeTool(
	t: ToolDefinition,
	input: unknown,
	turn: TurnContext,
): Promise<unknown> {
	if (!turn.config?.simulate) {
		return t.execute(input, turn);
	}

	const overlay = getOverlay(turn);

	// Tool-declared simulate handler wins regardless of category. This lets
	// pure read tools (e.g. vault_read) consult the overlay so they see
	// writes made earlier in the same turn.
	if (t.simulate) {
		const result = await t.simulate(input, turn);
		overlay.actions.push({
			tool: t.name,
			sideEffect: t.sideEffect,
			args: input,
			intent: `Custom simulate handler`,
			result,
		});
		return result;
	}

	// No handler: pure passes through; external/stateful get generic fakes.
	if (t.sideEffect === "pure") {
		return t.execute(input, turn);
	}

	const { result, intent } =
		t.sideEffect === "external"
			? fakeExternal(t.name, input)
			: fakeStateful(t.name, input);
	overlay.actions.push({
		tool: t.name,
		sideEffect: t.sideEffect,
		args: input,
		intent,
		result,
	});
	log.info(`[sim] ${t.name} (${t.sideEffect}) — ${intent}`);
	return result;
}

/**
 * Build the function-tool set + initial allowlist.
 *
 * Core tools, provider tools, and toolset meta-tools start active. Toolset
 * tools are pre-registered but hidden until `load_<set>` is called. Skills
 * pre-register their tools too; `skill_get` activates them.
 */
function assembleTools(
	def: AgentDefinition,
	turn: TurnContext,
): AssembledTools {
	const wrap = (t: ToolDefinition): FunctionTool => ({
		description: t.description,
		inputSchema: t.inputSchema,
		execute: (input: unknown) => invokeTool(t, input, turn),
	});

	const functionTools: FunctionToolSet = {};
	const initialActive: string[] = [];

	for (const name of def.tools) {
		const t = toolRegistry.get(name);
		if (!t) {
			log.warn(`[context] unknown tool: ${name}`);
			continue;
		}
		functionTools[t.name] = wrap(t);
		initialActive.push(t.name);
	}

	const serverTools: ChatTool[] = [];
	for (const name of def.providerTools ?? []) {
		const pt = getProviderTool(name);
		if (!pt) {
			log.warn(`[context] provider tool "${name}" not available`);
			continue;
		}
		serverTools.push(pt);
	}

	for (const tsName of def.toolsets ?? []) {
		const ts = toolsetRegistry.get(tsName);
		if (!ts) {
			log.warn(`[context] unknown toolset: ${tsName}`);
			continue;
		}
		const meta = generateMetaTool(ts);
		functionTools[meta.name] = wrap(meta);
		initialActive.push(meta.name);
		for (const t of ts.tools) {
			functionTools[t.name] = wrap(t);
		}
	}

	if (def.skills?.length) {
		const skillTool = buildSkillTool(def.skills, settings.vault.skillsDir);
		functionTools[skillTool.name] = wrap(skillTool);
		initialActive.push(skillTool.name);

		for (const sName of def.skills) {
			const meta = skillRegistry.get(sName);
			if (!meta) continue;
			for (const toolName of meta.tools) {
				const t = toolRegistry.get(toolName);
				if (!t) {
					log.warn(`[context] unknown tool "${toolName}" in skill ${sName}`);
					continue;
				}
				if (!functionTools[t.name]) functionTools[t.name] = wrap(t);
			}
			for (const tsName of meta.toolsets) {
				const ts = toolsetRegistry.get(tsName);
				if (!ts) {
					log.warn(`[context] unknown toolset "${tsName}" in skill ${sName}`);
					continue;
				}
				for (const t of ts.tools) {
					if (!functionTools[t.name]) functionTools[t.name] = wrap(t);
				}
			}
		}
	}

	const prepareStep = (steps: ModelCallStep[]): string[] => {
		const active = new Set(initialActive);
		for (const step of steps) {
			for (const call of step.toolCalls) {
				const name = call.toolName;
				if (name.startsWith("load_")) {
					const tsName = name.slice(5);
					const ts = toolsetRegistry.get(tsName);
					if (!ts) continue;
					active.delete(`load_${tsName}`);
					for (const t of ts.tools) active.add(t.name);
				} else if (name === "skill_get") {
					const sName =
						typeof call.args?.name === "string" ? call.args.name : undefined;
					const meta = sName ? skillRegistry.get(sName) : undefined;
					if (!meta) continue;
					for (const toolName of meta.tools) {
						active.add(toolName);
					}
					for (const tsName of meta.toolsets) {
						const ts = toolsetRegistry.get(tsName);
						if (!ts) continue;
						for (const t of ts.tools) active.add(t.name);
					}
				}
			}
		}
		return [...active];
	};

	return { functionTools, serverTools, initialActive, prepareStep };
}

// ── History ────────────────────────────────────────────────────────────────

export interface HistoryOptions {
	/** Max past messages included; defaults to settings.agentDefaults.historyLimit. */
	limit?: number;
	/**
	 * `"full"` includes everyone's turns; `"agent"` keeps only the conversation
	 * between the user and the running agent (user messages whose following
	 * reply was from this agent, plus this agent's replies).
	 */
	scope?: "full" | "agent";
}

interface AssembledHistory {
	messages: ChatMessage[];
	messageRefs: Record<string, { externalId: string; role: string }>;
}

/**
 * Read the conversation log, trim to `limit`, and reconstruct ChatMessages.
 *
 * **Structured replay**: assistant turns expand into the OpenAI-shape
 * `assistant` (with `tool_calls`) → `role: "tool"` (per call) → final
 * `assistant` (with `content`) sequence, mirroring what the model produced.
 * Reply tool calls (REPLY_TOOL_NAME) stay filtered out of the trace; the
 * final assistant `content` is the persisted reply text from the conversation
 * log. This keeps existing JSONL files backward-compatible.
 */
async function assembleHistory(
	turn: Omit<TurnContext, "vars">,
	opts: HistoryOptions = {},
): Promise<AssembledHistory> {
	if (!turn.message) return { messages: [], messageRefs: {} };

	const limit = opts.limit ?? settings.agentDefaults.historyLimit;
	const scope = opts.scope ?? "full";
	const agentName = turn.agent?.name;

	const allMessages = await getConversation();
	const traceMap = await getTraces();

	let filtered = turn.message.id
		? allMessages.filter((m) => m.externalId !== turn.message?.id)
		: allMessages;
	if (scope === "agent" && agentName) {
		filtered = filtered.filter((m, idx, arr) => {
			if (m.role === "assistant") return m.agent === agentName;
			// user message: keep only when the next assistant reply was this agent's
			for (let j = idx + 1; j < arr.length; j++) {
				const next = arr[j];
				if (next?.role === "assistant") return next.agent === agentName;
			}
			return false;
		});
	}
	const recent = filtered.slice(-limit);

	const messages: ChatMessage[] = [];
	const messageRefs: Record<string, { externalId: string; role: string }> = {};

	for (let i = 0; i < recent.length; i++) {
		const row = recent[i];
		if (!row) continue;

		const label = i + 1;
		if (row.externalId) {
			messageRefs[String(label)] = {
				externalId: row.externalId,
				role: row.role,
			};
		}

		if (row.role === "user") {
			messages.push({
				role: "user",
				content: renderTemplate("message-user", {
					label,
					messageText: row.content ?? "",
				}),
			});
			continue;
		}

		const trace = row.runId ? traceMap.get(row.runId) : undefined;
		const replyText = row.content ?? "";

		if (trace) {
			for (const step of trace.steps) {
				const calls = step.toolCalls.filter(
					(tc) => tc.toolName !== REPLY_TOOL_NAME,
				);
				if (calls.length === 0) continue;

				const resultMap = new Map(
					step.toolResults
						.filter((tr) => tr.toolName !== REPLY_TOOL_NAME)
						.map((tr) => [tr.toolCallId, tr]),
				);
				// Skip steps where every call is orphaned (replay would be malformed).
				const paired = calls.filter((tc) => resultMap.has(tc.toolCallId));
				if (paired.length === 0) continue;

				messages.push({
					role: "assistant",
					content: "",
					toolCalls: paired.map((tc) => ({
						id: tc.toolCallId,
						type: "function",
						function: { name: tc.toolName, arguments: tc.args },
					})),
				});
				for (const tc of paired) {
					const tr = resultMap.get(tc.toolCallId);
					if (!tr) continue;
					messages.push({
						role: "tool",
						toolCallId: tc.toolCallId,
						content: tr.result,
					});
				}
			}
		}

		messages.push({ role: "assistant", content: replyText });
	}

	return { messages, messageRefs };
}

// ── Orchestrator ───────────────────────────────────────────────────────────

interface AssembledContext {
	vars: Record<string, unknown>;
	tools: AssembledTools;
	history: AssembledHistory;
}

interface ContextOptions {
	variables: Variable[];
	/** Manual override; otherwise derived from `turn.config.history*`. */
	history?: HistoryOptions;
}

/**
 * Resolve everything the agent loop needs in one call:
 *   1. variables + history run concurrently (both touch I/O)
 *   2. tools build last — their execute closures need the resolved vars
 *
 * Honours `turn.config.skipHistory` so callers don't have to branch, and
 * derives `HistoryOptions` from `turn.config.history*` when not given.
 */
export async function assembleContext(
	turn: Omit<TurnContext, "vars">,
	def: AgentDefinition,
	opts: ContextOptions,
): Promise<AssembledContext> {
	const skipHistory = turn.config?.skipHistory ?? false;
	const historyOpts: HistoryOptions = opts.history ?? {
		...(turn.config?.historyLimit !== undefined
			? { limit: turn.config.historyLimit }
			: {}),
		...(turn.config?.historyScope ? { scope: turn.config.historyScope } : {}),
	};

	const [vars, history] = await Promise.all([
		assembleVariables(turn, opts.variables),
		skipHistory
			? Promise.resolve<AssembledHistory>({ messages: [], messageRefs: {} })
			: assembleHistory(turn, historyOpts),
	]);

	// Mutate turn state into the caller-owned object. Tool closures, reports, and
	// simulation overlays must all share the same TurnContext identity.
	Object.assign(turn.messageRefs, history.messageRefs);
	const fullTurn = Object.assign(turn, { vars }) as TurnContext;

	const tools = assembleTools(def, fullTurn);

	return { vars, tools, history };
}
