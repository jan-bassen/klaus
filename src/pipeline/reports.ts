/**
 * Per-turn report builder + emitter.
 *
 * Called from `pipeline/core.ts` once per `executeAgent` invocation when
 * `turn.config.report !== false`. Always writes a single full report:
 *
 *   1. Always: a JSON file at `{dataDir}/logs/<date>/<filename>.json`.
 *   2. If `settings.reports.vaultMarkdown` is on: a rendered markdown file at
 *      `{vault}/Klaus/reports/<date>/<filename>.md`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { settings } from "../infra/config.ts";
import { log } from "../infra/logger.ts";
import {
	localDateString,
	type ReportEntry,
	type ReportLlm,
	type ReportStep,
	reportFilename,
	writeReport,
} from "../infra/store/report.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
import { REPLY_TOOL_NAME } from "../primitives/tools/reply.ts";
import type { AgentRunResult, TurnContext } from "./core.ts";
import type { TurnConfig } from "./overrides.ts";
import { renderTemplate } from "./prompts.ts";

// ── Public API ─────────────────────────────────────────────────────────────

interface EmitReportInput {
	turn: TurnContext;
	startedAt: number;
	result?: AgentRunResult;
	error?: unknown;
}

/**
 * Build the report entry, write it to disk, and (when enabled) mirror it as
 * markdown into the vault. Catches its own errors — never throws — so report
 * failures are visible in logs without masking the turn result.
 */
export async function emitReport(input: EmitReportInput): Promise<void> {
	try {
		const entry = buildReport(input);
		const filename = reportFilename(entry);
		await writeReport(entry, filename);
		let vaultPath: string | undefined;
		if (settings.reports.vaultMarkdown) {
			vaultPath = await mirrorToVault(entry, filename);
		}
		log.info("[reports] emitted", {
			name: filename,
			...(vaultPath ? { vaultMirror: true } : {}),
		});
	} catch (err) {
		log.warn("[reports] failed to emit", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Build ──────────────────────────────────────────────────────────────────

function buildReport(input: EmitReportInput): ReportEntry {
	const { turn, startedAt, result, error } = input;
	const durationMs = Date.now() - startedAt;

	const entry: ReportEntry = {
		runId: turn.runId,
		chatId: turn.chatId,
		agent: turn.agent.name,
		trigger: turn.trigger,
		timestamp: new Date().toISOString(),
		durationMs,
		outcome: error ? errorOutcome(error) : { kind: "ok" },
		overrides: Object.keys(turn.overrides),
		config: pickConfig(turn.config),
	};

	if (result) entry.llm = buildLlmSection(result);
	if (turn.message) entry.message = buildMessageSection(turn.message);

	return entry;
}

function errorOutcome(err: unknown): ReportEntry["outcome"] {
	const e = err instanceof Error ? err : new Error(String(err));
	return { kind: "error", error: { name: e.name, message: e.message } };
}

function pickConfig(c: TurnConfig): ReportEntry["config"] {
	const out: ReportEntry["config"] = {};
	if (c.modelTier) out.modelTier = c.modelTier;
	if (c.provider) out.provider = c.provider;
	if (c.historyLimit !== undefined) out.historyLimit = c.historyLimit;
	if (c.historyScope) out.historyScope = c.historyScope;
	if (c.showTrace !== undefined) out.showTrace = c.showTrace;
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
	if (s.fallback) step.fallback = s.fallback;
	if (s.finishReason) step.finishReason = s.finishReason;
	if (s.usage) step.usage = s.usage;
	return step;
}

function reorderReportArgs(toolName: string, args: unknown): unknown {
	if (toolName !== REPLY_TOOL_NAME || !isRecord(args) || !("voice" in args)) {
		return args;
	}

	const out: Record<string, unknown> = { voice: args.voice };
	for (const [key, value] of Object.entries(args)) {
		if (key !== "voice") out[key] = value;
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

function buildMessageSection(msg: InboundMessage): ReportEntry["message"] {
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

// ── Vault mirror ───────────────────────────────────────────────────────────

async function mirrorToVault(
	entry: ReportEntry,
	filename: string,
): Promise<string> {
	const rendered = renderTemplate(
		"report",
		entry as unknown as Record<string, unknown>,
	);
	const date = localDateString(settings.timezone);
	const dir = path.join(settings.vault.reportsDir, date);
	await mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${filename}.md`);
	await writeFile(filePath, `${rendered}\n`);
	return filePath;
}
