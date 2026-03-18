import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "@/settings";

export const BudgetConfigSchema = z.object({
	chatId: z.string(),
	dailyLimitUsd: z.number().optional(),
	monthlyLimitUsd: z.number().optional(),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/** In-memory budget configs */
const budgetConfigs = new Map<string, BudgetConfig>();

function budgetsPath(): string {
	return path.join(settings.dataDir, "budgets.json");
}

/** Load budget configs from disk. Call at startup. */
export async function loadBudgets(): Promise<void> {
	try {
		const text = await Bun.file(budgetsPath()).text();
		const entries = z.array(BudgetConfigSchema).parse(JSON.parse(text));
		for (const entry of entries) {
			budgetConfigs.set(entry.chatId, entry);
		}
	} catch {
		// No budgets file yet
	}
}

/** Get budget config for a chat. */
export function getBudget(chatId: string): BudgetConfig | null {
	return budgetConfigs.get(chatId) ?? null;
}

/** Save budget configs to disk. */
async function persist(): Promise<void> {
	await mkdir(settings.dataDir, { recursive: true });
	await Bun.write(
		budgetsPath(),
		JSON.stringify([...budgetConfigs.values()], null, 2),
	);
}

/** Set budget config for a chat. */
export async function setBudget(budget: BudgetConfig): Promise<void> {
	budgetConfigs.set(budget.chatId, budget);
	await persist();
}
