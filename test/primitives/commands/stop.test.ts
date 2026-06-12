import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeFutureWorkIfReady } from "../../../src/infra/future.ts";
import {
	addSchedule,
	getSchedules,
} from "../../../src/infra/store/schedules.ts";
import { addTimer, listTimers } from "../../../src/infra/store/timers.ts";
import { registerActiveRun } from "../../../src/pipeline/runs.ts";
import { abortCommand } from "../../../src/primitives/commands/abort.ts";
import { pauseCommand } from "../../../src/primitives/commands/pause.ts";
import { resumeCommand } from "../../../src/primitives/commands/resume.ts";
import { stopCommand } from "../../../src/primitives/commands/stop.ts";
import { initAllStores } from "../../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

function inbound(id: string) {
	return {
		kind: "whatsapp" as const,
		id,
		chatId: "c1",
		senderId: "s1",
		text: "/stop",
		timestamp: new Date(),
		messageKey: {},
	};
}

function resumeInbound(id: string) {
	return {
		...inbound(id),
		text: "/resume",
	};
}

describe("primitives/commands/stop", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initAllStores(tmp);
		enqueueMock.mockReset();
	});

	afterEach(() => {
		resumeFutureWorkIfReady();
		rmTmpDir(tmp);
	});

	it("aborts active runs without pausing future work", async () => {
		const controller = new AbortController();
		const unregister = registerActiveRun(controller);
		await addTimer({
			id: "timer-1",
			agentName: "assistant",
			objective: "loop later",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});
		await addSchedule({
			id: "schedule-1",
			agentName: "assistant",
			pattern: "0 8 * * *",
			objective: "loop daily",
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});

		await abortCommand.execute({ ...inbound("m0"), text: "/abort" }, []);
		unregister();

		expect(controller.signal.aborted).toBe(true);
		expect(listTimers()).toHaveLength(1);
		expect(getSchedules()).toHaveLength(1);
		expect(enqueueMock).toHaveBeenCalledWith({
			chatId: "c1",
			content: "Aborted active runs: 1",
			dedupKey: "m0:abort",
			label: "System",
		});
	});

	it("pauses future work without aborting active runs", async () => {
		const controller = new AbortController();
		const unregister = registerActiveRun(controller);
		await addTimer({
			id: "timer-1",
			agentName: "assistant",
			objective: "loop later",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});
		await addSchedule({
			id: "schedule-1",
			agentName: "assistant",
			pattern: "0 8 * * *",
			objective: "loop daily",
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});

		await pauseCommand.execute({ ...inbound("m0"), text: "/pause" }, []);
		unregister();

		expect(controller.signal.aborted).toBe(false);
		expect(listTimers()).toHaveLength(1);
		expect(getSchedules()).toHaveLength(1);
		expect(enqueueMock).toHaveBeenCalledWith({
			chatId: "c1",
			content: [
				"Future work paused.",
				"Paused timers: 1",
				"Paused schedules: 1",
				"Use /resume to restart future work.",
			].join("\n"),
			dedupKey: "m0:pause",
			label: "System",
		});
	});

	it("aborts active runs and pauses future work without clearing state", async () => {
		const controller = new AbortController();
		const unregister = registerActiveRun(controller);
		await addTimer({
			id: "timer-1",
			agentName: "assistant",
			objective: "loop later",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});
		await addSchedule({
			id: "schedule-1",
			agentName: "assistant",
			pattern: "0 8 * * *",
			objective: "loop daily",
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});

		await stopCommand.execute(inbound("m1"), []);
		unregister();

		expect(controller.signal.aborted).toBe(true);
		expect(listTimers()).toHaveLength(1);
		expect(getSchedules()).toHaveLength(1);
		expect(enqueueMock).toHaveBeenCalledWith({
			chatId: "c1",
			content: [
				"Panic stop armed.",
				"Aborted active runs: 1",
				"Paused timers: 1",
				"Paused schedules: 1",
				"Use /resume to restart future work.",
			].join("\n"),
			dedupKey: "m1:stop",
			label: "System",
		});
	});

	it("resumes future work without recreating state", async () => {
		await addTimer({
			id: "timer-1",
			agentName: "assistant",
			objective: "loop later",
			runAt: new Date(Date.now() + 60_000).toISOString(),
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});
		await addSchedule({
			id: "schedule-1",
			agentName: "assistant",
			pattern: "0 8 * * *",
			objective: "loop daily",
			createdBy: "test",
			createdAt: new Date().toISOString(),
		});

		await stopCommand.execute(inbound("m2"), []);
		enqueueMock.mockReset();

		await resumeCommand.execute(resumeInbound("m3"), []);

		expect(listTimers()).toHaveLength(1);
		expect(getSchedules()).toHaveLength(1);
		expect(enqueueMock).toHaveBeenCalledWith({
			chatId: "c1",
			content: [
				"Future work unpaused, but waiting for setup or WhatsApp connection.",
				"Timers ready: 1",
				"Schedules ready: 1",
			].join("\n"),
			dedupKey: "m3:resume",
			label: "System",
		});
	});
});
