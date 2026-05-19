/**
 * Per-turn report store.
 *
 * One JSON file per agent run, day-partitioned under `{dataDir}/logs/<date>/`.
 * Written from `pipeline/reports.ts` whenever `turn.config.report !== false`.
 *
 * Reports are operational telemetry, not part of conversation state — they
 * never feed back into history or context. An optional vault-markdown mirror
 * (`settings.reports.vaultMarkdown`) writes the same content as a rendered
 * `.md` next to the JSON for human reading in Obsidian.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "../config.ts";
import { log } from "../logger.ts";
import { readText } from "../runtime.ts";
import { TriggerSchema } from "./history.ts";
import { localDateString, localTimeString } from "./index.ts";

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
	fallback: z.enum(["assistant_content_reply"]).optional(),
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
	systemPrompt: z.string(),
	userMessage: z.string(),
	assistantMessage: z.string(),
	historyTranscript: z.array(z.unknown()),
});

const ReportConfigSchema = z.object({
	provider: z.string().optional(),
	modelTier: z.string().optional(),
	historyLimit: z.number().optional(),
	historyScope: z.string().optional(),
	showTrace: z.boolean().optional(),
	report: z.boolean().optional(),
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
	outcome: ReportOutcomeSchema,
	overrides: z.array(z.string()),
	config: ReportConfigSchema,
	llm: ReportLlmSchema.optional(),
	message: ReportMessageSchema.optional(),
	/** Map of var key → JSON-stringified char count. */
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

/** Sortable per-run filename: `<HH-MM-SS>--<runIdShort>`. */
export function reportFilename(entry: ReportEntry): string {
	const time = localTimeString(settings.timezone);
	const shortId = entry.runId.replace(/-/g, "").slice(0, 8);
	return `${time}--${shortId}`;
}

export async function writeReport(
	entry: ReportEntry,
	filename: string,
): Promise<string> {
	const date = localDateString(settings.timezone);
	const dir = path.join(logsDir(), date);
	await mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${filename}.json`);
	await writeFile(filePath, JSON.stringify(entry, null, 2));
	return filePath;
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
	const root = logsDir();

	let dateDirs: string[];
	try {
		dateDirs = (await readdir(root))
			.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f))
			.sort()
			.slice(-days);
	} catch {
		return [];
	}

	const out: ReportEntry[] = [];
	for (const date of dateDirs) {
		const dir = path.join(root, date);
		let files: string[];
		try {
			files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const filePath = path.join(dir, file);
			let text: string;
			try {
				text = await readText(filePath);
			} catch {
				continue;
			}
			try {
				const entry = ReportEntrySchema.parse(JSON.parse(text));
				if (opts.agent && entry.agent !== opts.agent) continue;
				if (opts.chatId && entry.chatId !== opts.chatId) continue;
				if (opts.runId && entry.runId !== opts.runId) continue;
				out.push(entry);
			} catch {
				log.warn("[report] skipping corrupt file", { file: filePath });
			}
		}
	}

	out.reverse();
	return limit ? out.slice(0, limit) : out;
}
