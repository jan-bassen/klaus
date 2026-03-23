import { z } from "zod";
import { settings } from "@/settings";
import { appendJsonl, readJsonl } from "./jsonl";

const CostRecordSchema = z.object({
	service: z.string(),
	units: z.number(),
	costUsd: z.number(),
	chatId: z.string().optional(),
	createdAt: z.string(),
});

type CostRecord = z.infer<typeof CostRecordSchema>;

/** Append a cost record to the daily JSONL file. */
export async function recordCost(
	service: string,
	units: number,
	costUsd: number,
	chatId?: string,
): Promise<void> {
	const record: CostRecord = {
		service,
		units,
		costUsd,
		...(chatId ? { chatId } : {}),
		createdAt: new Date().toISOString(),
	};
	await appendJsonl(costsDir(), "costs", record);
}

function costsDir(): string {
	return `${settings.dataDir}/costs`;
}

/** Sum costs by service for a given period. */
export async function getCostSummary(
	period: "today" | "this_month" | "last_month",
): Promise<{
	total: number;
	byService: Record<string, number>;
	periodLabel: string;
}> {
	const now = new Date();
	let days: number;
	let periodLabel: string;

	if (period === "today") {
		days = 1;
		periodLabel = "today";
	} else if (period === "this_month") {
		days = now.getUTCDate();
		periodLabel = "this_month";
	} else {
		// last_month — read ~31 days back, filter by month
		days = 62; // read enough to cover last month
		periodLabel = "last_month";
	}

	const records = await readJsonl<CostRecord>(
		costsDir(),
		"costs",
		days,
		CostRecordSchema,
	);

	const byService: Record<string, number> = {};
	let total = 0;

	for (const r of records) {
		const recordDate = new Date(r.createdAt);

		if (period === "today") {
			if (
				recordDate.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)
			)
				continue;
		} else if (period === "this_month") {
			if (
				recordDate.getUTCFullYear() !== now.getUTCFullYear() ||
				recordDate.getUTCMonth() !== now.getUTCMonth()
			)
				continue;
		} else {
			const lastMonth = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
			const lastYear =
				now.getUTCMonth() === 0
					? now.getUTCFullYear() - 1
					: now.getUTCFullYear();
			if (
				recordDate.getUTCFullYear() !== lastYear ||
				recordDate.getUTCMonth() !== lastMonth
			)
				continue;
		}

		byService[r.service] = (byService[r.service] ?? 0) + r.costUsd;
		total += r.costUsd;
	}

	return { total, byService, periodLabel };
}
