/**
 * `infra/store/report.ts` — writeReport/readReports round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initReportStore,
	type ReportEntry,
	readReports,
	reportFilename,
	writeReport,
} from "../../../src/infra/store/report.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

function makeEntry(overrides: Partial<ReportEntry> = {}): ReportEntry {
	const base: ReportEntry = {
		runId: crypto.randomUUID(),
		chatId: "c1",
		agent: "fitness",
		trigger: { kind: "message", messageId: "m-1" },
		timestamp: new Date().toISOString(),
		durationMs: 42,
		outcome: { kind: "ok" },
		overrides: [],
		config: {},
	};
	return { ...base, ...overrides };
}

async function persist(entry: ReportEntry): Promise<string> {
	return writeReport(entry, reportFilename(entry));
}

describe("infra/store/report", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initReportStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("round-trip: writeReport then readReports returns the entry", async () => {
		const e = makeEntry();
		await persist(e);
		const out = await readReports({ days: 1 });
		expect(out).toHaveLength(1);
		expect(out[0]?.runId).toBe(e.runId);
	});

	it("filters by agent / chatId / runId", async () => {
		const a = makeEntry({ agent: "fitness", chatId: "c1" });
		const b = makeEntry({ agent: "coach", chatId: "c2" });
		await persist(a);
		await persist(b);

		const byAgent = await readReports({ agent: "coach" });
		expect(byAgent.map((e) => e.agent)).toEqual(["coach"]);

		const byChat = await readReports({ chatId: "c1" });
		expect(byChat.map((e) => e.chatId)).toEqual(["c1"]);

		const byRun = await readReports({ runId: a.runId });
		expect(byRun).toHaveLength(1);
		expect(byRun[0]?.runId).toBe(a.runId);
	});

	it("limit caps the number returned", async () => {
		for (let i = 0; i < 5; i++) await persist(makeEntry());
		const out = await readReports({ limit: 2 });
		expect(out).toHaveLength(2);
	});

	it("error outcome round-trips", async () => {
		const e = makeEntry({
			outcome: { kind: "error", error: { name: "Boom", message: "nope" } },
		});
		await persist(e);
		const out = await readReports({ runId: e.runId });
		expect(out[0]?.outcome).toEqual({
			kind: "error",
			error: { name: "Boom", message: "nope" },
		});
	});

	it("simulatedActions round-trips with arbitrary args + results", async () => {
		const e = makeEntry({
			simulation: true,
			simulatedActions: [
				{
					tool: "vault.write",
					sideEffect: "stateful",
					args: { path: "Notes/x.md", content: "hi" },
					intent: "Would write Notes/x.md",
					result: "(sim) ok",
				},
			],
		});
		await persist(e);
		const out = await readReports({ runId: e.runId });
		expect(out[0]?.simulation).toBe(true);
		expect(out[0]?.simulatedActions).toEqual(e.simulatedActions);
	});

	it("verbatim systemPrompt / userMessage / historyTranscript round-trip", async () => {
		const e = makeEntry({
			llm: {
				model: "gpt",
				tier: "medium",
				durationMs: 10,
				usage: { promptTokens: 1, completionTokens: 2 },
				systemPromptChars: 5,
				userMessageChars: 3,
				historyMessageCount: 2,
				replyChars: 1,
				steps: [],
				systemPrompt: "SYS",
				userMessage: "USR",
				historyTranscript: [{ role: "user", content: "hi" }],
			},
		});
		await persist(e);
		const out = await readReports({ runId: e.runId });
		expect(out[0]?.llm?.systemPrompt).toBe("SYS");
		expect(out[0]?.llm?.userMessage).toBe("USR");
		expect(out[0]?.llm?.historyTranscript).toEqual([
			{ role: "user", content: "hi" },
		]);
	});

	it("corrupt files are skipped, valid entries around them still return", async () => {
		const e = makeEntry();
		await persist(e);
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const root = path.join(tmpDir, "logs");
		const dateDir = path.join(root, (await fs.readdir(root))[0] as string);
		await fs.writeFile(path.join(dateDir, "garbage.json"), "{not json");

		const out = await readReports({ days: 1 });
		expect(out.map((x) => x.runId)).toContain(e.runId);
	});
});
