import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let savedDataDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "costs-test-"));
	savedDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const { recordCost, getCostSummary } = await import("@/store/costs");

describe("recordCost + getCostSummary", () => {
	test("records and sums costs for today", async () => {
		await recordCost("llm", 100, 0.05);
		await recordCost("llm", 200, 0.1);
		await recordCost("tts", 50, 0.02);

		const summary = await getCostSummary("today");
		expect(summary.total).toBeCloseTo(0.17);
		expect(summary.byService.llm).toBeCloseTo(0.15);
		expect(summary.byService.tts).toBeCloseTo(0.02);
		expect(summary.periodLabel).toBe("today");
	});

	test("this_month includes today's costs", async () => {
		const summary = await getCostSummary("this_month");
		expect(summary.total).toBeGreaterThan(0);
	});
});
