/**
 * Initialise all file-backed stores against a shared tmp dataDir. Call in a
 * suite's `beforeEach` when your test exercises persistence; the tmp dir
 * itself comes from `makeTmpDir`.
 */

import { initFilesStore } from "@/infra/store/files";
import { initHistoryStore } from "@/infra/store/history";
import { initReportStore } from "@/infra/store/report";
import { initSchedulesStore } from "@/infra/store/schedules";
import { initTimersStore } from "@/infra/store/timers";

export function initAllStores(dataDir: string, timezone = "UTC"): void {
	initHistoryStore({ dataDir });
	initFilesStore({ dataDir });
	initTimersStore({ dataDir });
	initSchedulesStore({ dataDir, timezone });
	initReportStore({ dataDir });
}
