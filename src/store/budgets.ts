import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "@/config";
import { BudgetConfigSchema } from "./schemas";

export interface BudgetConfig {
	chatId: string;
	dailyLimitUsd?: number;
	monthlyLimitUsd?: number;
}

/** In-memory budget configs */
const budgetConfigs = new Map<string, BudgetConfig>();

function budgetsPath(): string {
	return path.join(config.dataDir, "budgets.json");
}

/** Load budget configs from disk. Call at startup. */
export async function loadBudgets(): Promise<void> {
	try {
		const text = await Bun.file(budgetsPath()).text();
		const entries = z
			.array(BudgetConfigSchema)
			.parse(JSON.parse(text)) as BudgetConfig[];
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
	await mkdir(config.dataDir, { recursive: true });
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
