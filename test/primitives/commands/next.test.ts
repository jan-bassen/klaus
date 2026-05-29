import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../../../src/infra/whatsapp/receive.ts";
import { clearNextPrefix, getNextPrefix } from "../../../src/pipeline/next.ts";
import { nextCommand } from "../../../src/primitives/commands/next.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

function inbound(id: string): InboundMessage {
	return {
		kind: "whatsapp",
		id,
		chatId: "c1",
		senderId: "s1",
		text: "/next",
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("primitives/commands/next", () => {
	beforeEach(() => {
		clearNextPrefix("c1");
		enqueueMock.mockReset();
	});

	it("sets a prefix for the current chat", async () => {
		await nextCommand.execute(inbound("m1"), ["@meta", "!ghost"]);

		expect(getNextPrefix("c1")).toBe("@meta !ghost");
		expect(enqueueMock.mock.calls[0]?.[0]).toMatchObject({
			chatId: "c1",
			content: "Next prefix set: @meta !ghost",
			dedupKey: "m1:next-set",
		});
	});

	it("shows the pending prefix", async () => {
		await nextCommand.execute(inbound("m1"), ["@research"]);
		enqueueMock.mockReset();

		await nextCommand.execute(inbound("m2"), []);

		expect(enqueueMock.mock.calls[0]?.[0].content).toBe(
			"Next prefix: @research",
		);
	});

	it("clears a pending prefix", async () => {
		await nextCommand.execute(inbound("m1"), ["@research"]);
		enqueueMock.mockReset();

		await nextCommand.execute(inbound("m2"), ["cancel"]);

		expect(getNextPrefix("c1")).toBeUndefined();
		expect(enqueueMock.mock.calls[0]?.[0].content).toBe("Next prefix cleared.");
	});
});
