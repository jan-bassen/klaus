/**
 * Per-turn context assembly: variables, tools, history.
 *
 * One module so the three legs can be reasoned about together — they share
 * the same `turn` and feed the same prompt/agent loop downstream. The
 * orchestrator (`assembleContext`) runs vars + history in parallel; tools
 * are built last because their `execute` closures need the full turn (vars
 * resolved) to render their replies.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
	ChatMessages as ChatMessage,
	ChatFunctionTool as ChatTool,
} from "@openrouter/sdk/models";
import type { z } from "zod";
import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import { findFileByExternalId } from "../infra/store/files.ts";
import { getConversation, getTraces } from "../infra/store/history.ts";
import type {
	ToolDefinition,
	ToolsetDefinition,
} from "../primitives/tools/index.ts";
import {
	generateMetaTool,
	toolRegistry,
	toolsetRegistry,
} from "../primitives/tools/index.ts";
import { getProviderTool } from "../primitives/tools/provider.ts";
import { buildSkillTool, skillRegistry } from "../primitives/tools/skill.ts";
import type { Variable } from "../primitives/variables/index.ts";
import type { AgentDefinition } from "./agents.ts";
import { getDefaultAgent } from "./agents.ts";
import type { ModelCallStep, TurnContext } from "./core.ts";
import { renderTemplate } from "./templates.ts";

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

interface ToolAssembly {
	functionTools: FunctionToolSet;
	serverTools: ChatTool[];
	initialActive: string[];
	wrap(t: ToolDefinition): FunctionTool;
}

async function invokeTool(
	t: ToolDefinition,
	input: unknown,
	turn: TurnContext,
): Promise<unknown> {
	const parsed = t.inputSchema.safeParse(input);
	if (!parsed.success) {
		return {
			error: `Invalid ${t.name} input: ${formatToolInputError(parsed.error)}`,
		};
	}

	return t.execute(parsed.data, turn);
}

function formatToolInputError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.map((segment) => String(segment)).join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}

function createToolAssembly(turn: TurnContext): ToolAssembly {
	const functionTools: FunctionToolSet = {};
	const serverTools: ChatTool[] = [];
	const initialActive: string[] = [];

	return {
		functionTools,
		serverTools,
		initialActive,
		wrap: (t) => ({
			description: t.description,
			inputSchema: t.inputSchema,
			execute: (input: unknown) => invokeTool(t, input, turn),
		}),
	};
}

function addInitialTool(name: string, assembly: ToolAssembly): void {
	const tool = toolRegistry.get(name);
	if (!tool) {
		log.warn(`[context] unknown tool: ${name}`);
		return;
	}
	assembly.functionTools[tool.name] = assembly.wrap(tool);
	assembly.initialActive.push(tool.name);
}

function addProviderTools(def: AgentDefinition, assembly: ToolAssembly): void {
	for (const name of def.providerTools ?? []) {
		const providerTool = getProviderTool(name);
		if (!providerTool) {
			log.warn(`[context] provider tool "${name}" not available`);
			continue;
		}
		assembly.serverTools.push(providerTool);
	}
}

function addToolsetTools(tsName: string, assembly: ToolAssembly): void {
	const toolset = toolsetRegistry.get(tsName);
	if (!toolset) {
		log.warn(`[context] unknown toolset: ${tsName}`);
		return;
	}

	const meta = generateMetaTool(toolset);
	assembly.functionTools[meta.name] = assembly.wrap(meta);
	assembly.initialActive.push(meta.name);
	for (const tool of toolset.tools) {
		assembly.functionTools[tool.name] = assembly.wrap(tool);
	}
}

function addHiddenTool(toolName: string, assembly: ToolAssembly): void {
	const tool = toolRegistry.get(toolName);
	if (!tool) return;
	if (!assembly.functionTools[tool.name]) {
		assembly.functionTools[tool.name] = assembly.wrap(tool);
	}
}

function addSkillTool(
	toolName: string,
	skillName: string,
	assembly: ToolAssembly,
): void {
	const tool = toolRegistry.get(toolName);
	if (!tool) {
		log.warn(`[context] unknown tool "${toolName}" in skill ${skillName}`);
		return;
	}
	if (!assembly.functionTools[tool.name]) {
		assembly.functionTools[tool.name] = assembly.wrap(tool);
	}
}

function addSkillToolset(
	tsName: string,
	skillName: string,
	assembly: ToolAssembly,
): void {
	const toolset = toolsetRegistry.get(tsName);
	if (!toolset) {
		log.warn(`[context] unknown toolset "${tsName}" in skill ${skillName}`);
		return;
	}
	for (const tool of toolset.tools) addHiddenTool(tool.name, assembly);
}

function addSkillTools(def: AgentDefinition, assembly: ToolAssembly): void {
	if (!def.skills?.length) return;

	const skillTool = buildSkillTool(def.skills, settings.vault.skillsDir);
	assembly.functionTools[skillTool.name] = assembly.wrap(skillTool);
	assembly.initialActive.push(skillTool.name);

	for (const skillName of def.skills) {
		const meta = skillRegistry.get(skillName);
		if (!meta) continue;
		for (const toolName of meta.tools) {
			addSkillTool(toolName, skillName, assembly);
		}
		for (const tsName of meta.toolsets) {
			addSkillToolset(tsName, skillName, assembly);
		}
	}
}

function activateToolset(
	active: Set<string>,
	toolset: ToolsetDefinition,
): void {
	active.delete(`load_${toolset.name}`);
	for (const tool of toolset.tools) active.add(tool.name);
}

function activateSkillTools(
	active: Set<string>,
	skillName: string | undefined,
): void {
	const meta = skillName ? skillRegistry.get(skillName) : undefined;
	if (!meta) return;

	for (const toolName of meta.tools) active.add(toolName);
	for (const tsName of meta.toolsets) {
		const toolset = toolsetRegistry.get(tsName);
		if (toolset) activateToolset(active, toolset);
	}
}

function prepareActiveTools(
	initialActive: string[],
	steps: ModelCallStep[],
): string[] {
	const active = new Set(initialActive);
	for (const step of steps) {
		for (const call of step.toolCalls) {
			const name = call.toolName;
			if (name.startsWith("load_")) {
				const toolset = toolsetRegistry.get(name.slice(5));
				if (toolset) activateToolset(active, toolset);
			} else if (name === "read_skill") {
				const skillName =
					typeof call.args?.name === "string" ? call.args.name : undefined;
				activateSkillTools(active, skillName);
			}
		}
	}
	return [...active];
}

/**
 * Build the function-tool set + initial allowlist.
 *
 * Core tools, provider tools, and toolset meta-tools start active. Toolset
 * tools are pre-registered but hidden until `load_<set>` is called. Skills
 * pre-register their tools too; `read_skill` activates them.
 */
function assembleTools(
	def: AgentDefinition,
	turn: TurnContext,
): AssembledTools {
	const assembly = createToolAssembly(turn);

	for (const name of def.tools) {
		addInitialTool(name, assembly);
	}
	addProviderTools(def, assembly);
	for (const tsName of def.toolsets ?? []) {
		addToolsetTools(tsName, assembly);
	}
	addSkillTools(def, assembly);

	return {
		functionTools: assembly.functionTools,
		serverTools: assembly.serverTools,
		initialActive: assembly.initialActive,
		prepareStep: (steps) => prepareActiveTools(assembly.initialActive, steps),
	};
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

type ConversationRow = Awaited<ReturnType<typeof getConversation>>[number];
type TraceMap = Awaited<ReturnType<typeof getTraces>>;

function withoutCurrentMessage(
	rows: ConversationRow[],
	messageId: string | undefined,
): ConversationRow[] {
	if (!messageId) return rows;
	return rows.filter((row) => row.externalId !== messageId);
}

function followedByAgentReply(
	rows: ConversationRow[],
	index: number,
	agentName: string,
): boolean {
	for (let j = index + 1; j < rows.length; j++) {
		const next = rows[j];
		if (next?.role === "assistant") return next.agent === agentName;
	}
	return false;
}

function hasReactionFromAgent(
	row: ConversationRow,
	agentName: string,
): boolean {
	return row.reactions.some(
		(reaction) =>
			reaction.fromMe && (!reaction.agent || reaction.agent === agentName),
	);
}

function filterAgentHistory(
	rows: ConversationRow[],
	agentName: string | undefined,
	scope: HistoryOptions["scope"],
): ConversationRow[] {
	if (scope !== "agent" || !agentName) return rows;
	return rows.filter((row, index, allRows) => {
		if (row.role === "assistant") return row.agent === agentName;
		return (
			followedByAgentReply(allRows, index, agentName) ||
			hasReactionFromAgent(row, agentName)
		);
	});
}

function visibleHistoryRows(
	rows: ConversationRow[],
	limit: number,
): ConversationRow[] {
	return rows
		.filter((row) => (row.content ?? "").trim().length > 0)
		.slice(-limit);
}

function addMessageRef(
	messageRefs: AssembledHistory["messageRefs"],
	label: number,
	row: ConversationRow,
): void {
	if (!row.externalId) return;
	messageRefs[String(label)] = {
		externalId: row.externalId,
		role: row.role,
	};
}

function renderHistoryUserMessage(
	row: ConversationRow,
	label: number,
): ChatMessage {
	const media = row.externalId ? findFileByExternalId(row.externalId) : null;
	const isVoice = media?.mimeType.startsWith("audio/") ?? false;
	const isImage = media?.mimeType.startsWith("image/") ?? false;
	const isDocument = !!media && !isVoice && !isImage;
	const sidecar = isDocument ? `${media.path}.parsed.txt` : null;
	const extractedText =
		sidecar && existsSync(sidecar) ? readFileSync(sidecar, "utf-8") : undefined;
	const reactions = reactionSummary(row);

	return {
		role: "user",
		content: renderTemplate("history-user", {
			label,
			messageText: row.content ?? "",
			...(reactions ? { reactions } : {}),
			isVoice,
			isImage,
			isDocument,
			...(media
				? {
						fileName: path.basename(media.path),
						mimeType: media.mimeType,
					}
				: {}),
			...(extractedText ? { extractedText } : {}),
			...(row.quotedText ? { quotedText: row.quotedText } : {}),
			...(row.quotedRole ? { quotedRole: row.quotedRole } : {}),
		}),
	};
}

function reactionSummary(row: ConversationRow): string {
	return row.reactions
		.map((reaction) => {
			const source = reaction.fromMe ? (reaction.agent ?? "assistant") : "user";
			return `${source} ${reaction.emoji}`;
		})
		.filter((emoji) => emoji.length > 0)
		.join(", ");
}

function renderHistoryAssistantMessage(
	row: ConversationRow,
	label: number,
	defaultAgent: string,
	toolSummary: string | undefined,
): ChatMessage {
	const reactions = reactionSummary(row);
	return {
		role: "assistant",
		content: renderTemplate("history-agent", {
			label,
			message: row.content ?? "",
			agentLabel: row.agent ?? "",
			isVoice: row.voice === true,
			isNotDefaultAgent: row.agent ? row.agent !== defaultAgent : false,
			...(toolSummary ? { toolSummary } : {}),
			...(reactions ? { reactions, reactionEmojis: reactions } : {}),
		}),
	};
}

function renderHistoryRow(
	row: ConversationRow,
	label: number,
	defaultAgent: string,
	toolSummaries: Map<string, string>,
): ChatMessage {
	return row.role === "user"
		? renderHistoryUserMessage(row, label)
		: renderHistoryAssistantMessage(
				row,
				label,
				defaultAgent,
				row.runId ? toolSummaries.get(row.runId) : undefined,
			);
}

function summarizeTraceTools(steps: TraceMap): Map<string, string> {
	const summaries = new Map<string, string>();

	for (const [runId, trace] of steps) {
		const names: string[] = [];
		for (const step of trace.steps) {
			const resultIds = new Set(
				step.toolResults.map((result) => result.toolCallId),
			);
			for (const call of step.toolCalls) {
				if (!resultIds.has(call.toolCallId)) continue;
				if (names.includes(call.toolName)) continue;
				names.push(call.toolName);
			}
		}
		if (names.length > 0) summaries.set(runId, names.join(", "));
	}

	return summaries;
}

/**
 * Read the conversation log, trim to `limit`, and render each chat turn via
 * replay-only `history-user` / `history-agent` templates.
 *
 * Tool args/results are deliberately *not* replayed — past tool scratch
 * doesn't earn its place in future-turn context. When enabled, history only
 * gets a names-only tool summary; full traces stay in reports.
 *
 * Numbering covers user + assistant turns (everything WhatsApp-visible) so the
 * model can quote/react to either side via `messageRefs`.
 */
async function assembleHistory(
	turn: Omit<TurnContext, "vars">,
	opts: HistoryOptions = {},
): Promise<AssembledHistory> {
	if (!turn.message) return { messages: [], messageRefs: {} };

	const limit = opts.limit ?? settings.agentDefaults.historyLimit;
	const scope = opts.scope ?? "full";
	const agentName = turn.agent?.name;
	const defaultAgent = getDefaultAgent(turn.chatId);
	const showTrace = turn.config?.showTrace ?? settings.agentDefaults.showTrace;

	const [allMessages, traces] = await Promise.all([
		getConversation(),
		showTrace ? getTraces() : Promise.resolve<TraceMap>(new Map()),
	]);
	const toolSummaries = summarizeTraceTools(traces);
	const filtered = filterAgentHistory(
		withoutCurrentMessage(allMessages, turn.message.id),
		agentName,
		scope,
	);
	const recent = visibleHistoryRows(filtered, limit);

	const messages: ChatMessage[] = [];
	const messageRefs: Record<string, { externalId: string; role: string }> = {};

	for (let i = 0; i < recent.length; i++) {
		const row = recent[i];
		if (!row) continue;

		const label = i + 1;
		addMessageRef(messageRefs, label, row);
		messages.push(renderHistoryRow(row, label, defaultAgent, toolSummaries));
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

	// Mutate turn state into the caller-owned object. Tool closures and reports
	// must share the same TurnContext identity.
	Object.assign(turn.messageRefs, history.messageRefs);
	const fullTurn = Object.assign(turn, { vars }) as TurnContext;

	const tools = assembleTools(def, fullTurn);

	return { vars, tools, history };
}
