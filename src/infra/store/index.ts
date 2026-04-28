import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { log } from "@/infra/logger";

// -- Date utilities --

/**
 * Returns the current local date as YYYY-MM-DD in the given timezone.
 * Uses Intl.DateTimeFormat to correctly handle DST transitions.
 */
export function localDateString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date());
}

// -- JSONL utilities --

/**
 * Append a record to a date-partitioned JSONL file.
 * File pattern: {dir}/{prefix}-YYYY-MM-DD.jsonl
 */
async function appendJsonl(
	dir: string,
	prefix: string,
	record: unknown,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	const date = new Date().toISOString().slice(0, 10);
	const filePath = path.join(dir, `${prefix}-${date}.jsonl`);
	await appendFile(filePath, `${JSON.stringify(record)}\n`);
}

/**
 * Read JSONL records from the last N days for a given prefix.
 * Returns parsed records in chronological order.
 *
 * @param schema — If omitted, parsed JSON is cast to T without runtime validation.
 */
async function readJsonl<T>(
	dir: string,
	prefix: string,
	days: number,
	schema?: z.ZodType<T>,
): Promise<T[]> {
	const results: T[] = [];
	const now = Date.now();
	for (let d = days - 1; d >= 0; d--) {
		const date = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
		const filePath = path.join(dir, `${prefix}-${date}.jsonl`);
		try {
			const text = await Bun.file(filePath).text();
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					results.push(schema ? schema.parse(parsed) : (parsed as T));
				} catch {
					log.warn("[jsonl] skipping corrupt line", {
						prefix,
						line: line.slice(0, 100),
					});
				}
			}
		} catch {
			// File doesn't exist for this day — skip
		}
	}
	return results;
}
