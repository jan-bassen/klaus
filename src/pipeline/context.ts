/**
 * Per-turn context assembly: variables, tools, history.
 *
 * One module so the three legs can be reasoned about together — they share
 * the same `turn` and feed the same prompt/agent loop downstream. The
 * orchestrator (`assembleContext`) runs vars + history in parallel; tools
 * are built last because their `execute` closures need the full turn (vars
 * resolved) to render their replies.
 */

import { type ModelMessage, type StepResult, type ToolSet, tool } from "ai";
import { resolveProvider, settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { fakeExternal, fakeStateful, getOverlay } from "@/infra/simulation";
import {
	type AgentTrace,
	getConversation,
	getTraces,
} from "@/infra/store/history";
import { renderTemplate } from "@/pipeline/prompts";
import {
	generateMetaTool,
	toolRegistry,
	toolsetRegistry,
} from "@/primitives/tools";
import { getProviderTool } from "@/primitives/tools/provider";
import { REPLY_TOOL_NAME } from "@/primitives/tools/reply";
import { buildSkillTool, skillRegistry } from "@/primitives/tools/skill";
import type { Variable } from "@/primitives/variables";
import type { AgentDefinition } from "@/pipeline/agents";
import type { TurnContext } from "@/pipeline/agent";
import type { ToolDefinition } from "@/primitives/tools";

// ── Variables ──────────────────────────────────────────────────────────────

/**
 * Run all variables in parallel; defer those marked `after: true` to a second
 * pass that sees the partial namespace via `turn.vars` (used by `snippets`
 * to compile against the full variable set).
 */
export async function assembleVariables(
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

export interface AssembledTools {
	allTools: ToolSet;
	initialActive: string[];
	prepareStep: (steps: StepResult<ToolSet>[]) => string[];
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
	// pure read tools (e.g. vault.read) consult the overlay so they see
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
 * Build the SDK tool set + initial allowlist.
 *
 * Core tools, provider tools, and toolset meta-tools start active. Toolset
 * tools are pre-registered but hidden until `use_<set>` is called. Skills
 * pre-register their tools too; `skill_get` activates them.
 */
export function assembleTools(
	def: AgentDefinition,
	turn: TurnContext,
): AssembledTools {
	const wrap = (t: ToolDefinition) =>
		tool({
			description: t.description,
			inputSchema: t.inputSchema,
			execute: async (input) => invokeTool(t, input, turn),
		});

	const allTools: ToolSet = {};
	const initialActive: string[] = [];

	for (const name of def.tools) {
		const t = toolRegistry.get(name);
		if (!t) {
			log.warn(`[context] unknown tool: ${name}`);
			continue;
		}
		const sdkName = t.name.replace(/\./g, "_");
		allTools[sdkName] = wrap(t);
		initialActive.push(sdkName);
	}

	const providerCfg = resolveProvider(turn.config?.provider);
	for (const name of def.providerTools ?? []) {
		const pt = getProviderTool(name, providerCfg.sdk);
		if (!pt) {
			log.warn(
				`[context] provider tool "${name}" not available for ${providerCfg.sdk}`,
			);
			continue;
		}
		allTools[name] = pt;
		initialActive.push(name);
	}

	for (const tsName of def.toolsets ?? []) {
		const ts = toolsetRegistry.get(tsName);
		if (!ts) {
			log.warn(`[context] unknown toolset: ${tsName}`);
			continue;
		}
		const meta = generateMetaTool(ts);
		allTools[meta.name] = wrap(meta);
		initialActive.push(meta.name);
		for (const t of ts.tools) {
			allTools[t.name.replace(/\./g, "_")] = wrap(t);
		}
	}

	if (def.skills?.length) {
		const skillTool = buildSkillTool(def.skills, settings.vault.skillsDir);
		const sdkToolName = skillTool.name.replace(/\./g, "_");
		allTools[sdkToolName] = wrap(skillTool);
		initialActive.push(sdkToolName);

		for (const sName of def.skills) {
			const meta = skillRegistry.get(sName);
			if (!meta) continue;
			for (const toolName of meta.tools) {
				const t = toolRegistry.get(toolName);
				if (!t) {
					log.warn(`[context] unknown tool "${toolName}" in skill ${sName}`);
					continue;
				}
				const n = t.name.replace(/\./g, "_");
				if (!allTools[n]) allTools[n] = wrap(t);
			}
			for (const tsName of meta.toolsets) {
				const ts = toolsetRegistry.get(tsName);
				if (!ts) {
					log.warn(`[context] unknown toolset "${tsName}" in skill ${sName}`);
					continue;
				}
				for (const t of ts.tools) {
					const n = t.name.replace(/\./g, "_");
					if (!allTools[n]) allTools[n] = wrap(t);
				}
			}
		}
	}

	const prepareStep = (steps: StepResult<ToolSet>[]): string[] => {
		const active = new Set(initialActive);
		for (const step of steps) {
			for (const call of step.toolCalls) {
				const name = call.toolName as string;
				if (name.startsWith("use_")) {
					const tsName = name.slice(4);
					const ts = toolsetRegistry.get(tsName);
					if (!ts) continue;
					active.delete(`use_${tsName}`);
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

	return { allTools, initialActive, prepareStep };
}

// ── History ────────────────────────────────────────────────────────────────

/** Fallback caps when a tool doesn't specify its own. Tools may override
 * via `maxResultChars` / `maxArgSnippetChars` on their `ToolDefinition`. */
const DEFAULT_TOOL_RESULT_CHARS = 2_000;
const DEFAULT_TOOL_ARG_SNIPPET_CHARS = 40;

/**
 * Trace lines reference tools by their SDK name (dots replaced with
 * underscores at registration). The registry is keyed by the original name,
 * so try the trace name first then the dot-restored form.
 */
function findToolByTraceName(traceName: string) {
	return (
		toolRegistry.get(traceName) ??
		toolRegistry.get(traceName.replace(/_/g, "."))
	);
}

/** Per-call view exposed to `message-agent.md` / `message-tool.md`. */
export interface TemplateCall {
	tool: string;
	args: unknown;
	argSnippet: string;
	result: unknown;
}

/** Per-step view exposed to `message-agent.md`. */
export interface TemplateStep {
	reasoning?: string;
	calls: TemplateCall[];
}

export interface HistoryOptions {
	/** Max past messages included; defaults to settings.agentDefaults.historyLimit. */
	limit?: number;
	/**
	 * `"full"` includes everyone's turns; `"agent"` keeps only the conversation
	 * between the user and the running agent (user messages whose following
	 * reply was from this agent, plus this agent's replies).
	 */
	scope?: "full" | "agent";
	/** Render the per-turn `[Used X, Y → replied]` summary in history? */
	showTrace?: boolean;
}

export interface AssembledHistory {
	messages: ModelMessage[];
	messageRefs: Record<string, { externalId: string; role: string }>;
}

/**
 * Read the conversation log, trim to `limit`, and reconstruct ModelMessages
 * via the templates. History is text-only — every past turn renders to a
 * single string per role; provider-specific structural replay is gone.
 */
export async function assembleHistory(
	turn: Omit<TurnContext, "vars">,
	opts: HistoryOptions = {},
): Promise<AssembledHistory> {
	if (!turn.message) return { messages: [], messageRefs: {} };

	const limit = opts.limit ?? settings.agentDefaults.historyLimit;
	const showTrace = opts.showTrace ?? settings.agentDefaults.showTrace;
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

	const messages: ModelMessage[] = [];
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
		const steps = trace ? shapeTrace(trace) : [];

		messages.push({
			role: "assistant",
			content: renderTemplate("message-agent", {
				agent: row.agent,
				text: row.content ?? "",
				showTrace,
				steps,
			}),
		});
	}

	return { messages, messageRefs };
}

/**
 * Convert the persisted `TraceStep[]` into the friendly shape templates see.
 * Drops the reply tool (it's the message body, not a side effect), strips
 * orphaned calls, and pre-computes argSnippet + capped result per call.
 */
function shapeTrace(trace: AgentTrace): TemplateStep[] {
	return trace.steps
		.map((step): TemplateStep => {
			const resultMap = new Map(
				step.toolResults.map((tr) => [tr.toolCallId, tr]),
			);
			const calls: TemplateCall[] = [];

			for (const tc of step.toolCalls) {
				if (tc.toolName === REPLY_TOOL_NAME) continue;
				const tr = resultMap.get(tc.toolCallId);
				if (!tr) continue;

				calls.push({
					tool: tc.toolName,
					args: tryParse(tc.args),
					argSnippet: computeArgSnippet(tc.toolName, tc.args),
					result: capResult(tr.toolName, tr.result),
				});
			}

			return {
				...(step.reasoning
					? {
							reasoning: step.reasoning.slice(
								0,
								settings.agent.maxReasoningChars,
							),
						}
					: {}),
				calls,
			};
		})
		.filter((s) => s.reasoning || s.calls.length > 0);
}

function tryParse(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return json;
	}
}

function computeArgSnippet(toolName: string, argsJson: string): string {
	const parsed = tryParse(argsJson);
	if (typeof parsed !== "object" || parsed === null) return "";
	const firstVal = Object.values(parsed as Record<string, unknown>)[0];
	if (firstVal === undefined) return "";
	const s = String(firstVal);
	const cap =
		findToolByTraceName(toolName)?.maxArgSnippetChars ??
		DEFAULT_TOOL_ARG_SNIPPET_CHARS;
	return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function capResult(toolName: string, raw: string): unknown {
	const cap =
		findToolByTraceName(toolName)?.maxResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
	const truncated = raw.length > cap ? raw.slice(0, cap) : raw;
	const parsed = tryParse(truncated);
	return parsed === truncated ? truncated : parsed;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export interface AssembledContext {
	vars: Record<string, unknown>;
	tools: AssembledTools;
	history: AssembledHistory;
}

export interface ContextOptions {
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
		...(turn.config?.showTrace !== undefined
			? { showTrace: turn.config.showTrace }
			: {}),
	};

	const [vars, history] = await Promise.all([
		assembleVariables(turn, opts.variables),
		skipHistory
			? Promise.resolve<AssembledHistory>({ messages: [], messageRefs: {} })
			: assembleHistory(turn, historyOpts),
	]);

	// Mutate refs into the caller's messageRefs object — tools close over `turn`
	// and need to see history-derived refs at execute time.
	Object.assign(turn.messageRefs, history.messageRefs);

	const fullTurn: TurnContext = { ...turn, vars };
	const tools = assembleTools(def, fullTurn);

	return { vars, tools, history };
}
