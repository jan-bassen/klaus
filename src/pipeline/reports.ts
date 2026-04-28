/**
 * Per-turn report builder + emitter.
 *
 * Called from `pipeline/core.ts` once per `executeAgent` invocation. Decides
 * the report level from `turn.config.report`:
 *   - `"none"`  → skip
 *   - `"agent"` → LLM-only fields (model, tokens, steps, tool calls)
 *   - `"full"`  → also message metadata, overrides, variables summary
 *
 * Two write paths, both fire-and-forget so reporting never blocks the reply:
 *   1. Always: append a JSON line to `{dataDir}/logs/<date>.jsonl`.
 *   2. If `settings.reports.vaultMarkdown` is on: append a rendered
 *      `report-full.md` block to `{vault}/reports/<date>.md`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import { getOverlay } from "@/infra/simulation";
import { localDateString } from "@/infra/store";
import {
	type ReportEntry,
	type ReportLlm,
	type ReportStep,
	writeReport,
} from "@/infra/store/report";
import type { InboundMessage } from "@/infra/whatsapp/receive";
import type { TurnContext } from "@/pipeline/core";
import { renderTemplate } from "@/pipeline/prompts";
import type { AgentRunResult } from "./core";
import type { TurnConfig } from "./overrides";

// ── Public API ─────────────────────────────────────────────────────────────

interface EmitReportInput {
	turn: TurnContext;
	startedAt: number;
	/** Effective `report` level for this turn — already resolved by the caller. */
	level: "agent" | "full";
	result?: AgentRunResult;
	error?: unknown;
}

/**
 * Build the report entry, write it to JSONL, and (when enabled) mirror it as
 * markdown into the vault. Catches its own errors — never throws — so the
 * caller can fire-and-forget without try/catch noise.
 */
export async function emitReport(input: EmitReportInput): Promise<void> {
	try {
		const entry = buildReport(input);
		await writeReport(entry);
		if (settings.reports.vaultMarkdown) {
			await mirrorToVault(entry);
		}
	} catch (err) {
		log.warn("[reports] failed to emit", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

// ── Build ──────────────────────────────────────────────────────────────────

function buildReport(input: EmitReportInput): ReportEntry {
	const { turn, startedAt, level, result, error } = input;
	const durationMs = Date.now() - startedAt;

	const entry: ReportEntry = {
		runId: turn.runId,
		chatId: turn.chatId,
		agent: turn.agent.name,
		trigger: turn.trigger,
		timestamp: new Date().toISOString(),
		durationMs,
		level,
		outcome: error ? errorOutcome(error) : { kind: "ok" },
		overrides: Object.keys(turn.overrides),
		config: pickConfig(turn.config),
	};

	if (result) entry.llm = buildLlmSection(result, level);

	if (level === "full") {
		if (turn.message) entry.message = buildMessageSection(turn.message);
		if (turn.vars && Object.keys(turn.vars).length > 0) {
			entry.variablesSummary = summarizeVars(turn.vars);
		}
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
	if (c.historyLimit !== undefined) out.historyLimit = c.historyLimit;
	if (c.historyScope) out.historyScope = c.historyScope;
	if (c.showTrace !== undefined) out.showTrace = c.showTrace;
	if (c.report) out.report = c.report;
	return out;
}

function buildLlmSection(
	result: AgentRunResult,
	level: "agent" | "full",
): ReportLlm {
	const llm: ReportLlm = {
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
	};
	if (level === "full") {
		llm.systemPrompt = result.systemPrompt;
		llm.userMessage = result.userMessage;
		llm.historyTranscript = result.historyMessages;
	}
	return llm;
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

async function mirrorToVault(entry: ReportEntry): Promise<void> {
	const dir = settings.vault.reportsDir;
	await mkdir(dir, { recursive: true });
	const date = localDateString(settings.timezone);
	const filePath = path.join(dir, `${date}.md`);
	const rendered = renderTemplate(
		"report-full",
		entry as unknown as Record<string, unknown>,
	);
	await appendFile(filePath, `${rendered}\n\n---\n\n`);
}
