/**
 * Per-turn report builder + emitter.
 *
 * Called from `pipeline/core.ts` once per `executeAgent` invocation when
 * `turn.config.report !== false`. Writes one rendered Markdown report at
 * `{vault}/Klaus/reports/<date>/<filename>.md`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
import { SEND_MESSAGE_TOOL_NAME } from "../primitives/tools/core.ts";
import type { AgentRunResult, TurnContext } from "./core.ts";
import type { TurnConfig } from "./overrides.ts";
import { renderTemplate } from "./templates.ts";

// ── Public API ─────────────────────────────────────────────────────────────

interface EmitReportInput {
	turn: TurnContext;
	startedAt: number;
	result?: AgentRunResult;
	error?: unknown;
	errorPhase?: string;
	userError?: string;
}

interface EmitPipelineErrorReportInput {
	chatId: string;
	startedAt: number;
	error: unknown;
	phase: string;
	userError?: string;
	agent?: string;
	runId?: string;
	trigger?: TurnContext["trigger"];
	message?: InboundMessage;
	overrides?: Record<string, boolean>;
	config?: TurnConfig;
}

interface ReportStep {
	reasoning?: string;
	toolCalls: { tool: string; args: unknown }[];
	toolResults: { tool: string; result: unknown }[];
	serverToolUse?: Record<string, number>;
	citations?: {
		type: "url_citation";
		url: string;
		title?: string;
		content?: string;
		startIndex?: number;
		endIndex?: number;
	}[];
	fallback?: "assistant_content_reply";
	finishReason?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

interface ReportLlm {
	model: string;
	tier: string;
	context: {
		variables: string[];
		tools: string[];
		serverTools: string[];
		toolsets: string[];
		skills: string[];
	};
	durationMs: number;
	usage: {
		promptTokens: number;
		completionTokens: number;
	};
	systemPromptChars: number;
	userMessageChars: number;
	historyMessageCount: number;
	replyChars: number;
	steps: ReportStep[];
	systemPrompt: string;
	userMessage: string;
	assistantMessage: string;
	historyTranscript: unknown[];
}

interface ReportEntry {
	runId: string;
	chatId: string;
	agent: string;
	trigger: TurnContext["trigger"];
	timestamp: string;
	durationMs: number;
	outcome:
		| { kind: "ok" }
		| {
				kind: "error";
				error: {
					name: string;
					message: string;
					phase?: string;
					userMessage?: string;
					stack?: string;
				};
		  };
	overrides: string[];
	config: {
		provider?: string;
		modelTier?: string;
		historyLimit?: number;
		historyScope?: string;
		showTools?: boolean;
		report?: boolean;
	};
	llm?: ReportLlm;
	message?: {
		externalId: string;
		text?: string;
		hasMedia?: boolean;
		mediaType?: string;
	};
}

/**
 * Build the report entry and write it as Markdown into the vault. Catches its
 * own errors — never throws — so report failures are visible in logs without
 * masking the turn result.
 */
export async function emitReport(input: EmitReportInput): Promise<void> {
	try {
		const entry = buildReport(input);
		const filename = reportFilename(entry);
		await writeMarkdownReport(entry, filename);
		log.info("[reports] emitted", {
			name: filename,
		});
	} catch (err) {
		log.warn("[reports] failed to emit", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export async function emitPipelineErrorReport(
	input: EmitPipelineErrorReportInput,
): Promise<void> {
	try {
		const entry = buildPipelineErrorReport(input);
		const filename = reportFilename(entry);
		await writeMarkdownReport(entry, filename);
		log.info("[reports] emitted pipeline error", {
			name: filename,
		});
	} catch (err) {
		log.warn("[reports] failed to emit pipeline error", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Build ──────────────────────────────────────────────────────────────────

function buildReport(input: EmitReportInput): ReportEntry {
	const { turn, startedAt, result, error, errorPhase, userError } = input;
	const durationMs = Date.now() - startedAt;
	const errorDetails: { phase?: string; userMessage?: string } = {};
	if (errorPhase) errorDetails.phase = errorPhase;
	if (userError) errorDetails.userMessage = userError;

	const entry: ReportEntry = {
		runId: turn.runId,
		chatId: turn.chatId,
		agent: turn.agent.name,
		trigger: turn.trigger,
		timestamp: new Date().toISOString(),
		durationMs,
		outcome: error ? errorOutcome(error, errorDetails) : { kind: "ok" },
		overrides: Object.keys(turn.overrides),
		config: pickConfig(turn.config),
	};

	if (result) entry.llm = buildLlmSection(result);
	if (turn.message) entry.message = buildMessageSection(turn.message);

	return entry;
}

function buildPipelineErrorReport(
	input: EmitPipelineErrorReportInput,
): ReportEntry {
	const durationMs = Date.now() - input.startedAt;
	const errorDetails: { phase?: string; userMessage?: string } = {
		phase: input.phase,
	};
	if (input.userError) errorDetails.userMessage = input.userError;

	const entry: ReportEntry = {
		runId: input.runId ?? crypto.randomUUID(),
		chatId: input.chatId,
		agent: input.agent ?? "pipeline",
		trigger: input.trigger ?? {
			kind: "message",
			messageId: input.message?.id ?? "unknown",
		},
		timestamp: new Date().toISOString(),
		durationMs,
		outcome: errorOutcome(input.error, errorDetails),
		overrides: Object.keys(input.overrides ?? {}),
		config: input.config ? pickConfig(input.config) : {},
	};

	if (input.message) entry.message = buildMessageSection(input.message);

	return entry;
}

function errorOutcome(
	err: unknown,
	details: { phase?: string; userMessage?: string } = {},
): ReportEntry["outcome"] {
	const e = err instanceof Error ? err : new Error(String(err));
	return {
		kind: "error",
		error: {
			name: e.name,
			message: sanitizeReportText(e.message),
			...(details.phase ? { phase: details.phase } : {}),
			...(details.userMessage
				? { userMessage: sanitizeReportText(details.userMessage) }
				: {}),
			...(e.stack ? { stack: sanitizeReportText(e.stack) } : {}),
		},
	};
}

function pickConfig(c: TurnConfig): ReportEntry["config"] {
	const out: ReportEntry["config"] = {};
	if (c.modelTier) out.modelTier = c.modelTier;
	if (c.provider) out.provider = c.provider;
	if (c.historyLimit !== undefined) out.historyLimit = c.historyLimit;
	if (c.historyScope) out.historyScope = c.historyScope;
	if (c.showTools !== undefined) out.showTools = c.showTools;
	if (c.report !== undefined) out.report = c.report;
	return out;
}

function buildLlmSection(result: AgentRunResult): ReportLlm {
	const userMessage = sanitizeReportText(result.userMessage);
	const systemPrompt = sanitizeReportText(result.systemPrompt);
	const assistantMessage = sanitizeReportText(result.replyContent);

	return {
		model: result.model,
		tier: result.tier,
		context: result.context,
		durationMs: result.durationMs,
		usage: {
			promptTokens: result.usage.promptTokens,
			completionTokens: result.usage.completionTokens,
		},
		systemPromptChars: result.systemPrompt.length,
		userMessageChars: result.userMessage.length,
		historyMessageCount: result.historyMessages.length,
		replyChars: result.replyContent.length,
		steps: result.steps.map(toReportStep),
		systemPrompt,
		userMessage,
		assistantMessage,
		historyTranscript: sanitizeHistoryTranscript(result.historyMessages),
	};
}

function toReportStep(s: AgentRunResult["steps"][number]): ReportStep {
	const step: ReportStep = {
		toolCalls: s.toolCalls.map((tc) => ({
			tool: tc.toolName,
			args: sanitizeReportValue(reorderReportArgs(tc.toolName, tc.args)),
		})),
		toolResults: s.toolResults.map((tr) => ({
			tool: tr.toolName,
			result: sanitizeReportValue(tr.result),
		})),
	};
	if (s.reasoning) step.reasoning = sanitizeReportText(s.reasoning);
	if (s.serverToolUse) step.serverToolUse = s.serverToolUse;
	if (s.citations) step.citations = s.citations.map(sanitizeCitation);
	if (s.fallback) step.fallback = s.fallback;
	if (s.finishReason) step.finishReason = s.finishReason;
	if (s.usage) step.usage = s.usage;
	return step;
}

function sanitizeCitation(
	citation: NonNullable<AgentRunResult["steps"][number]["citations"]>[number],
): NonNullable<ReportStep["citations"]>[number] {
	return {
		type: citation.type,
		url: sanitizeReportText(citation.url),
		...(citation.title ? { title: sanitizeReportText(citation.title) } : {}),
		...(citation.content
			? { content: sanitizeReportText(citation.content) }
			: {}),
		...(citation.startIndex !== undefined
			? { startIndex: citation.startIndex }
			: {}),
		...(citation.endIndex !== undefined ? { endIndex: citation.endIndex } : {}),
	};
}

function reorderReportArgs(toolName: string, args: unknown): unknown {
	if (
		toolName !== SEND_MESSAGE_TOOL_NAME ||
		!isRecord(args) ||
		!("asVoiceNote" in args)
	) {
		return args;
	}

	const out: Record<string, unknown> = { asVoiceNote: args.asVoiceNote };
	for (const [key, value] of Object.entries(args)) {
		if (key !== "asVoiceNote") out[key] = value;
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeHistoryTranscript(
	messages: AgentRunResult["historyMessages"],
): ReportLlm["historyTranscript"] {
	const sanitized = sanitizeReportValue(messages);
	return Array.isArray(sanitized) ? sanitized : [];
}

function sanitizeReportValue(value: unknown): unknown {
	try {
		return JSON.parse(
			JSON.stringify(value, (_key, inner: unknown) =>
				typeof inner === "string" ? sanitizeReportText(inner) : inner,
			),
		);
	} catch {
		return value;
	}
}

function sanitizeReportText(text: string): string {
	return text.replace(
		/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/g,
		"[base64 data URL omitted from report]",
	);
}

function buildMessageSection(
	msg: InboundMessage,
): NonNullable<ReportEntry["message"]> {
	const out: NonNullable<ReportEntry["message"]> = {
		externalId: msg.id,
	};
	if (msg.text) out.text = msg.text;
	if (msg.media) {
		out.hasMedia = true;
		out.mediaType = msg.media.mimeType;
	}
	return out;
}

// ── Vault write ────────────────────────────────────────────────────────────

function localDateString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date());
}

function localTimeString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return fmt.format(new Date()).replaceAll(":", "-");
}

function reportFilename(entry: ReportEntry): string {
	const time = localTimeString(settings.timezone);
	const shortId = entry.runId.replace(/-/g, "").slice(0, 8);
	return `${time}--${shortId}`;
}

async function writeMarkdownReport(
	entry: ReportEntry,
	filename: string,
): Promise<string> {
	const rendered = renderTemplate("report", entry);
	const date = localDateString(settings.timezone);
	const dir = path.join(settings.vault.reportsDir, date);
	await mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${filename}.md`);
	await writeFile(filePath, `${rendered}\n`);
	return filePath;
}
