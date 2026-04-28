/**
 * Per-turn report store.
 *
 * One JSONL line per agent run, day-partitioned under `{dataDir}/logs/`.
 * Written from `pipeline/core.ts` whenever `turn.config.report !== "none"`.
 *
 * Two report levels (decided by `turn.config.report`):
 *   - `"agent"` — only the LLM call: model, tokens, steps, tool calls.
 *   - `"full"`  — also routing, overrides, variables summary, message metadata.
 *
 * Reports are operational telemetry, not part of conversation state — they
 * never feed back into history or context. Surfaced via `/reports` and via
 * an optional vault-markdown mirror when `settings.reports.vaultMarkdown` is on.
 */

import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Trigger } from "../../pipeline/core.ts";
import { settings } from "../config.ts";
import { log } from "../logger.ts";
import { readText } from "../runtime.ts";
import { TriggerSchema } from "./history.ts";
import { localDateString } from "./index.ts";

// ── Types ──────────────────────────────────────────────────────────────────

const ReportStepSchema = z.object({
	reasoning: z.string().optional(),
	toolCalls: z.array(
		z.object({
			tool: z.string(),
			args: z.unknown(),
		}),
	),
	toolResults: z.array(
		z.object({
			tool: z.string(),
			result: z.unknown(),
		}),
	),
	finishReason: z.string().optional(),
	usage: z
		.object({
			inputTokens: z.number(),
			outputTokens: z.number(),
		})
		.optional(),
});

const ReportLlmSchema = z.object({
	model: z.string(),
	tier: z.string(),
	durationMs: z.number(),
	usage: z.object({
		promptTokens: z.number(),
		completionTokens: z.number(),
	}),
	systemPromptChars: z.number(),
	userMessageChars: z.number(),
	historyMessageCount: z.number(),
	replyChars: z.number(),
	steps: z.array(ReportStepSchema),
	/**
	 * Verbatim prompts as the model saw them — only present when
	 * `level === "full"`. Useful for spotting injection, formatting bugs,
	 * or unexpected variable expansion.
	 */
	systemPrompt: z.string().optional(),
	userMessage: z.string().optional(),
	historyTranscript: z.array(z.unknown()).optional(),
});

const ReportConfigSchema = z.object({
	modelTier: z.string().optional(),
	historyLimit: z.number().optional(),
	historyScope: z.string().optional(),
	showTrace: z.boolean().optional(),
	report: z.string().optional(),
});

const ReportMessageSchema = z.object({
	externalId: z.string().optional(),
	text: z.string().optional(),
	hasMedia: z.boolean().optional(),
	mediaType: z.string().optional(),
});

const ReportOutcomeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ok") }),
	z.object({
		kind: z.literal("error"),
		error: z.object({ name: z.string(), message: z.string() }),
	}),
]);

const SimulatedActionSchema = z.object({
	tool: z.string(),
	sideEffect: z.enum(["external", "stateful", "pure"]),
	args: z.unknown(),
	intent: z.string(),
	result: z.unknown(),
});

const ReportEntrySchema = z.object({
	runId: z.string(),
	chatId: z.string(),
	agent: z.string(),
	trigger: TriggerSchema,
	timestamp: z.string(),
	durationMs: z.number(),
	level: z.enum(["agent", "full"]),
	outcome: ReportOutcomeSchema,
	overrides: z.array(z.string()),
	config: ReportConfigSchema,
	llm: ReportLlmSchema.optional(),
	/** Present when `level === "full"`. */
	message: ReportMessageSchema.optional(),
	/** Present when `level === "full"`. Map of var key → JSON-stringified char count. */
	variablesSummary: z.record(z.string(), z.number()).optional(),
	/** True when the run was a `!simulate` dry-run — surfaced in templates. */
	simulation: z.boolean().optional(),
	/** Faked actions captured by the simulation overlay (only when `simulation`). */
	simulatedActions: z.array(SimulatedActionSchema).optional(),
});

export type ReportEntry = z.infer<typeof ReportEntrySchema>;
export type ReportStep = z.infer<typeof ReportStepSchema>;
export type ReportLlm = z.infer<typeof ReportLlmSchema>;

// ── Store ──────────────────────────────────────────────────────────────────

let _logsDir: string | null = null;

export function initReportStore(env: { dataDir: string }): void {
	_logsDir = path.join(env.dataDir, "logs");
}

function logsDir(): string {
	if (!_logsDir) throw new Error("[report] store not initialized");
	return _logsDir;
}

function fileFor(date: string): string {
	return path.join(logsDir(), `${date}.jsonl`);
}

export async function writeReport(entry: ReportEntry): Promise<void> {
	await mkdir(logsDir(), { recursive: true });
	const date = localDateString(settings.timezone);
	await appendFile(fileFor(date), `${JSON.stringify(entry)}\n`);
}

interface ReadReportsOptions {
	days?: number;
	agent?: string;
	chatId?: string;
	runId?: string;
	limit?: number;
}

/** Most-recent first. Defaults to `settings.reports.lookbackDays`. */
export async function readReports(
	opts: ReadReportsOptions = {},
): Promise<ReportEntry[]> {
	const days = opts.days ?? settings.reports.lookbackDays;
	const limit = opts.limit;
	const dir = logsDir();

	let files: string[];
	try {
		files = (await readdir(dir))
			.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort()
			.slice(-days)
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}

	const out: ReportEntry[] = [];
	for (const filePath of files) {
		let text: string;
		try {
			text = await readText(filePath);
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = ReportEntrySchema.parse(JSON.parse(line));
				if (opts.agent && entry.agent !== opts.agent) continue;
				if (opts.chatId && entry.chatId !== opts.chatId) continue;
				if (opts.runId && entry.runId !== opts.runId) continue;
				out.push(entry);
			} catch {
				log.warn("[report] skipping corrupt line", {
					line: line.slice(0, 100),
				});
			}
		}
	}

	out.reverse();
	return limit ? out.slice(0, limit) : out;
}

/** Convenience: rebuild a `Trigger` for templates without exposing internals. */
type ReportTrigger = Trigger;
