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
import { getOverlay } from "../infra/simulation.ts";
import { localDateString } from "../infra/store/index.ts";
import {
	type ReportEntry,
	type ReportLlm,
	type ReportStep,
	reportFilename,
	writeReport,
} from "../infra/store/report.ts";
import type { InboundMessage } from "../infra/whatsapp/receive.ts";
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
		const jsonPath = await writeReport(entry, filename);
		let vaultPath: string | undefined;
		if (settings.reports.vaultMarkdown) {
			vaultPath = await mirrorToVault(entry, filename);
		}
		log.info("[reports] emitted", {
			runId: entry.runId,
			agent: entry.agent,
			jsonPath,
			...(vaultPath ? { vaultPath } : {}),
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
	if (turn.vars && Object.keys(turn.vars).length > 0) {
		entry.variablesSummary = summarizeVars(turn.vars);
	}

	if (turn.config?.simulate) {
		entry.simulation = true;
		const overlay = getOverlay(turn);
		if (overlay.actions.length > 0) entry.simulatedActions = overlay.actions;
	}

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
	return {
		model: result.model,
		tier: result.tier,
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
		systemPrompt: result.systemPrompt,
		userMessage: result.userMessage,
		historyTranscript: result.historyMessages,
	};
}

function toReportStep(s: AgentRunResult["steps"][number]): ReportStep {
	const step: ReportStep = {
		toolCalls: s.toolCalls.map((tc) => ({
			tool: tc.toolName,
			args: tc.args,
		})),
		toolResults: s.toolResults.map((tr) => ({
			tool: tr.toolName,
			result: tr.result,
		})),
	};
	if (s.reasoning) step.reasoning = s.reasoning;
	if (s.finishReason) step.finishReason = s.finishReason;
	if (s.usage) step.usage = s.usage;
	return step;
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

function summarizeVars(vars: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(vars)) {
		try {
			out[k] = JSON.stringify(v ?? null).length;
		} catch {
			out[k] = 0;
		}
	}
	return out;
}

// ── Vault mirror ───────────────────────────────────────────────────────────

async function mirrorToVault(
	entry: ReportEntry,
	filename: string,
): Promise<string> {
	const date = localDateString(settings.timezone);
	const dir = path.join(settings.vault.reportsDir, date);
	await mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${filename}.md`);
	const rendered = renderTemplate(
		"report",
		entry as unknown as Record<string, unknown>,
	);
	await writeFile(filePath, `${rendered}\n`);
	return filePath;
}
