import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "@/config";
import { log } from "@/logger";
import { settings } from "@/settings";
import { localDateString } from "./date-utils";
import type { TurnLog } from "./turn-log";

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function localTime(isoString: string, timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return fmt.format(new Date(isoString));
}

/** Format a turn log entry as a compact markdown block. */
export function formatTrailEntry(entry: TurnLog, timezone: string): string {
	const time = localTime(entry.createdAt, timezone);
	const lines: string[] = [];

	lines.push("---");
	lines.push(`### ${time} · ${entry.agent} · ${entry.model} (${entry.tier})`);

	if (entry.rawText) {
		lines.push(`**In**: ${truncate(entry.rawText, 200)}`);
	}

	const meta: string[] = [];
	if (entry.flags.length > 0) meta.push(`**Flags**: ${entry.flags.join(", ")}`);
	meta.push(`**Tokens**: ${entry.promptTokens}→${entry.completionTokens}`);
	meta.push(`**Duration**: ${(entry.durationMs / 1000).toFixed(1)}s`);
	lines.push(meta.join(" · "));

	for (const step of entry.steps) {
		if (step.reasoning) {
			lines.push(`> ${truncate(step.reasoning, 100)}`);
		}
		for (const tc of step.toolCalls) {
			const matchingResult = step.toolResults.find(
				(tr) => tr.toolName === tc.toolName,
			);
			const resultStr = matchingResult
				? ` → ${truncate(matchingResult.result, 100)}`
				: "";
			lines.push(
				`- \`${tc.toolName}\` → ${truncate(tc.args, 100)}${resultStr}`,
			);
		}
	}

	if (entry.error) {
		lines.push(`**Error**: ${truncate(entry.error, 200)}`);
	} else if (entry.replyContent) {
		lines.push(`**Out**: ${truncate(entry.replyContent, 300)}`);
	}

	lines.push("");
	return lines.join("\n");
}

/** Append a formatted trail entry to today's markdown file in the vault. */
export async function appendTrail(
	record: Omit<TurnLog, "createdAt">,
): Promise<void> {
	if (!settings.trail.enabled) return;

	const trailDir = config.vault.trailDir;
	await mkdir(trailDir, { recursive: true });

	const today = localDateString(settings.timezone);
	const filePath = path.join(trailDir, `trail-${today}.md`);

	const entry: TurnLog = { ...record, createdAt: new Date().toISOString() };

	if (!existsSync(filePath)) {
		await Bun.write(filePath, `# Trail ${today}\n\n`);
	}

	await appendFile(filePath, formatTrailEntry(entry, settings.timezone));

	cleanupOldTrails(trailDir, settings.trail.retentionDays, today).catch((err) =>
		log.warn("[trail] cleanup failed", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

const TRAIL_FILE_RE = /^trail-(\d{4}-\d{2}-\d{2})\.md$/;

/** Remove trail files older than retentionDays. */
export async function cleanupOldTrails(
	dir: string,
	retentionDays: number,
	today: string,
): Promise<void> {
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();
	const cutoffMs = todayMs - retentionDays * 86_400_000;

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		const match = TRAIL_FILE_RE.exec(entry);
		if (!match) continue;
		const fileDate = new Date(`${match[1]}T00:00:00Z`).getTime();
		if (fileDate < cutoffMs) {
			await unlink(path.join(dir, entry)).catch(() => {});
		}
	}
}
