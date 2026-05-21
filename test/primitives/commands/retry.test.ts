/**
 * `primitives/commands/retry.ts` — retry the latest failed turn only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendMessage } from "../../../src/infra/store/history.ts";
import type { InboundMessage } from "../../../src/infra/whatsapp/receive.ts";
import { enqueueMessage } from "../../../src/infra/whatsapp/send.ts";
import { handleTurn } from "../../../src/pipeline/index.ts";
import { retryCommand } from "../../../src/primitives/commands/retry.ts";
import { initAllStores } from "../../helpers/stores.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

vi.mock("../../../src/pipeline/index.ts", () => ({
	handleTurn: vi.fn(),
}));

vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
}));

describe("primitives/commands/retry", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = makeTmpDir();
		initAllStores(tmpDir);
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("replays the latest failed turn with its agent and overrides", async () => {
		await appendMessage({
			role: "user",
			content: "look this up",
			externalId: "user-1",
			overrides: ["large"],
		});
		await appendMessage({
			role: "assistant",
			content: "Something went wrong.",
			agent: "research",
			runId: "run-1",
			failed: true,
		});

		await retryCommand.execute(makeRetryMessage(), []);

		expect(handleTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat1",
				senderId: "sender1",
				text: "@research !large look this up",
			}),
		);
		expect(enqueueMessage).not.toHaveBeenCalled();
	});

	it("reports when there is no failed turn to retry", async () => {
		await retryCommand.execute(makeRetryMessage(), []);

		expect(handleTurn).not.toHaveBeenCalled();
		expect(enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: "chat1",
				content: "Nothing to retry — no failed turn found.",
			}),
		);
	});
});

function makeRetryMessage(): InboundMessage {
	return {
		kind: "whatsapp",
		id: "retry-1",
		chatId: "chat1",
		senderId: "sender1",
		text: "/retry",
		timestamp: new Date("2026-05-21T10:00:00.000Z"),
		messageKey: {},
	};
}
