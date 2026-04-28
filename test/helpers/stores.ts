/**
 * Initialise all file-backed stores against a shared tmp dataDir. Call in a
 * suite's `beforeEach` when your test exercises persistence; the tmp dir
 * itself comes from `makeTmpDir`.
 */

import { initFilesStore } from "../../src/infra/store/files.ts";
import { initHistoryStore } from "../../src/infra/store/history.ts";
import { initReportStore } from "../../src/infra/store/report.ts";
import { initSchedulesStore } from "../../src/infra/store/schedules.ts";
import { initTimersStore } from "../../src/infra/store/timers.ts";

export function initAllStores(dataDir: string, timezone = "UTC"): void {
	initHistoryStore({ dataDir });
	initFilesStore({ dataDir });
	initTimersStore({ dataDir });
	initSchedulesStore({ dataDir, timezone });
	initReportStore({ dataDir });
}
