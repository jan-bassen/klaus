import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "@/store/jsonl";

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "jsonl-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("appendJsonl + readJsonl", () => {
	test("appends and reads records from today", async () => {
		const dir = join(tmpDir, "test1");
		await appendJsonl(dir, "log", { a: 1 });
		await appendJsonl(dir, "log", { a: 2 });

		const records = await readJsonl<{ a: number }>(dir, "log", 1);
		expect(records).toHaveLength(2);
		expect(records[0]?.a).toBe(1);
		expect(records[1]?.a).toBe(2);
	});

	test("returns empty array when no files exist", async () => {
		const dir = join(tmpDir, "empty");
		const records = await readJsonl<unknown>(dir, "log", 1);
		expect(records).toHaveLength(0);
	});

	test("creates directory if it does not exist", async () => {
		const dir = join(tmpDir, "nested", "deep");
		await appendJsonl(dir, "test", { x: true });
		const records = await readJsonl<{ x: boolean }>(dir, "test", 1);
		expect(records).toHaveLength(1);
		expect(records[0]?.x).toBe(true);
	});
});
