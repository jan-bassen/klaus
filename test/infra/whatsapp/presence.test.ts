import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import {
	setPresenceKind,
	startPresence,
	stopPresence,
} from "../../../src/infra/whatsapp/presence.ts";

const socket = vi.hoisted(() => ({
	sendPresenceUpdate: vi.fn(async () => {}),
}));
const testPresenceRefreshMs = 3000;

vi.mock("../../../src/infra/whatsapp/connection.ts", () => ({
	getSocket: () => socket,
}));

describe("infra/whatsapp/presence", () => {
	let savedPresenceRefreshMs: number;

	beforeEach(() => {
		vi.useFakeTimers();
		savedPresenceRefreshMs = settings.whatsapp.presenceRefreshMs;
		settings.whatsapp.presenceRefreshMs = testPresenceRefreshMs;
		socket.sendPresenceUpdate.mockClear();
	});

	afterEach(async () => {
		await stopPresence("chat1");
		settings.whatsapp.presenceRefreshMs = savedPresenceRefreshMs;
		vi.useRealTimers();
	});

	it("refreshes composing presence until stopped", async () => {
		startPresence("chat1", "composing");

		await vi.advanceTimersByTimeAsync(settings.whatsapp.presenceRefreshMs * 2);

		expect(socket.sendPresenceUpdate).toHaveBeenCalledTimes(3);
		expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
			1,
			"composing",
			"chat1",
		);
		expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
			2,
			"composing",
			"chat1",
		);
		expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
			3,
			"composing",
			"chat1",
		);
	});

	it("uses the latest presence kind on the next refresh", async () => {
		startPresence("chat1", "composing");
		setPresenceKind("chat1", "recording");

		await vi.advanceTimersByTimeAsync(settings.whatsapp.presenceRefreshMs);

		expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
			2,
			"recording",
			"chat1",
		);
		expect(socket.sendPresenceUpdate).toHaveBeenNthCalledWith(
			3,
			"recording",
			"chat1",
		);
	});

	it("clears presence when stopped", async () => {
		startPresence("chat1", "composing");
		await stopPresence("chat1");

		socket.sendPresenceUpdate.mockClear();
		await vi.advanceTimersByTimeAsync(settings.whatsapp.presenceRefreshMs);

		expect(socket.sendPresenceUpdate).not.toHaveBeenCalled();
	});
});
