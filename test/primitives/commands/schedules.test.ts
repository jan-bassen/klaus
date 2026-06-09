import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import { addTimer, stopAllTimers } from "../../../src/infra/store/timers.ts";
import type { InboundMessage } from "../../../src/infra/whatsapp/receive.ts";
import { schedulesCommand } from "../../../src/primitives/commands/schedules.ts";
import { initAllStores } from "../../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

const savedLocale = settings.basics.locale;
const savedTimezone = settings.basics.timezone;

function inbound(id: string): InboundMessage {
	return {
		kind: "whatsapp",
		id,
		chatId: "c1",
		senderId: "s1",
		text: "/schedules",
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("primitives/commands/schedules", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initAllStores(tmp);
		enqueueMock.mockReset();
		settings.basics.locale = "en-GB";
		settings.basics.timezone = "Europe/London";
	});

	afterEach(() => {
		stopAllTimers();
		settings.basics.locale = savedLocale;
		settings.basics.timezone = savedTimezone;
		rmTmpDir(tmp);
	});

	it("lists timer run times in the configured timezone", async () => {
		await addTimer({
			id: "timer-1",
			agentName: "dispatch",
			objective: "confirm local time",
			runAt: "2026-06-09T12:50:00.000Z",
			createdBy: "assistant",
			createdAt: "2026-06-09T12:45:00.000Z",
		});

		await schedulesCommand.execute(inbound("m1"), []);

		const content = enqueueMock.mock.calls[0]?.[0].content as string;
		expect(content).toContain("13:50");
		expect(content).toContain("BST");
		expect(content).not.toContain("(at 12:50");
	});
});
