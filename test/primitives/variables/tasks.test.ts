/**
 * `primitives/variables/tasks.ts` — pending timers surfaced to templates.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addTimer,
	initTimersStore,
	stopAllTimers,
} from "@/infra/store/timers";
import type { TurnContext } from "@/pipeline/core";
import { tasksVariable } from "@/primitives/variables/tasks";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";
import { makeTurn } from "../../helpers/turn";

interface RunArg extends Omit<TurnContext, "vars"> {
	vars?: Record<string, unknown>;
}

async function run(): Promise<{
	active: Array<{ kind: string; objective: string; runAt?: string }>;
}> {
	const turn = makeTurn() as unknown as RunArg;
	turn.vars = {};
	return (await tasksVariable.run(turn)) as {
		active: Array<{ kind: string; objective: string; runAt?: string }>;
	};
}

describe("primitives/variables/tasks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initTimersStore({ dataDir: tmp });
	});

	afterEach(() => {
		stopAllTimers();
		rmTmpDir(tmp);
	});

	it("returns empty active list when no timers are scheduled", async () => {
		const out = await run();
		expect(out.active).toEqual([]);
	});

	it("surfaces queued timers as { kind, objective, runAt }", async () => {
		const runAt = new Date(Date.now() + 60_000).toISOString();
		await addTimer({
			id: "t-1",
			agentName: "coach",
			chatId: "c1",
			objective: "morning checkin",
			runAt,
			createdBy: "user",
			createdAt: new Date().toISOString(),
		});
		const out = await run();
		expect(out.active).toEqual([
			{ kind: "timer", objective: "morning checkin", runAt },
		]);
	});

	it("does not include timer fields beyond the public shape", async () => {
		await addTimer({
			id: "t-2",
			agentName: "coach",
			chatId: "c1",
			objective: "x",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "user",
			createdAt: new Date().toISOString(),
			overrides: ["voice"],
		});
		const out = await run();
		expect(out.active[0]).toEqual({
			kind: "timer",
			objective: "x",
			runAt: expect.any(String),
		});
		expect(Object.keys(out.active[0] ?? {}).sort()).toEqual([
			"kind",
			"objective",
			"runAt",
		]);
	});
});
