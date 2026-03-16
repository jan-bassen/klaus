import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

/**
 * Append a record to a date-partitioned JSONL file.
 * File pattern: {dir}/{prefix}-YYYY-MM-DD.jsonl
 */
export async function appendJsonl(
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
 * When a schema is provided, each line is validated through zod.
 */
export async function readJsonl<T>(
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
				if (line.trim()) {
					const parsed = JSON.parse(line);
					results.push(schema ? schema.parse(parsed) : (parsed as T));
				}
			}
		} catch {
			// File doesn't exist for this day — skip
		}
	}
	return results;
}
