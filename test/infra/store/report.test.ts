/**
 * `infra/store/report.ts` — writeReport/readReports round-trip + filters.
 *
 * Call `initReportStore({dataDir: tmpDir})` per suite. The Zod schema
 * (`ReportEntrySchema`) validates on read, so round-trip also proves schema
 * compatibility.
 */

import { afterEach, beforeEach, describe, it } from "vitest";

// import { initReportStore, writeReport, readReports, type ReportEntry } from "@/infra/store/report";
// import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";

describe("infra/store/report", () => {
	let tmpDir: string;

	beforeEach(() => {
		// tmpDir = makeTmpDir();
		// initReportStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		// rmTmpDir(tmpDir);
	});

	it.todo(
		"round-trip: writeReport then readReports({days:1}) returns the same entry (schema-validated)",
	);

	it.todo(
		"readReports returns most-recent first",
	);

	it.todo(
		"filter by agent narrows results",
	);

	it.todo(
		"filter by chatId narrows results",
	);

	it.todo(
		"filter by runId returns at most one entry",
	);

	it.todo(
		"limit caps the number returned",
	);

	it.todo(
		"simulatedActions round-trip preserves arbitrary JSON args + results",
	);

	it.todo(
		"level: 'full' entries preserve systemPrompt, userMessage, historyTranscript",
	);

	it.todo(
		"corrupt lines are skipped (not thrown) — valid entries around them still return",
	);
});
