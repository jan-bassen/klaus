/**
 * `primitives/tools/send-message.ts` — collector branch.
 *
 * The full send path goes through `enqueueMessage`, the message-agent template,
 * and (optionally) TTS. Those are exercised end-to-end in
 * `test/pipeline/{core,index}.test.ts`. Here we only cover the cheap-to-isolate
 * inline-dispatch send_message collection branch.
 */

import { describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod/v4";
import { sendMessageTool } from "../../../src/primitives/tools/send-message.ts";
import { makeTurn } from "../../helpers/turn.ts";

vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
}));

describe("primitives/tools/send_message: collector branch", () => {
	it("requires text and exposes voice as a delivery choice", () => {
		const schema = toJSONSchema(sendMessageTool.inputSchema);
		expect(schema).toMatchObject({
			properties: {
				text: expect.any(Object),
				asVoiceNote: expect.any(Object),
				quoteMessageLabel: expect.any(Object),
			},
			required: ["text"],
		});
		expect(
			sendMessageTool.inputSchema.safeParse({ asVoiceNote: true }).success,
		).toBe(false);
		expect(
			sendMessageTool.inputSchema.safeParse({
				text: "send_message",
				quoteMessageLabel: "current",
			}).success,
		).toBe(false);
		expect(
			sendMessageTool.inputSchema.safeParse({
				text: "send_message",
				quoteMessageLabel: "3",
			}).success,
		).toBe(false);
		expect(
			sendMessageTool.inputSchema.safeParse({
				text: "send_message",
				quoteMessageLabel: 0,
			}).success,
		).toBe(true);
		expect(
			sendMessageTool.inputSchema.safeParse({
				text: "send_message",
				quoteMessageLabel: 3,
			}).success,
		).toBe(true);
	});

	it("pushes text into the parent's _replyCollector and short-circuits", async () => {
		const collector: string[] = [];
		const turn = makeTurn({ _replyCollector: collector });
		const result = await sendMessageTool.execute(
			{ text: "child send_message" },
			turn,
		);
		expect(result).toBe("sent");
		expect(collector).toEqual(["child send_message"]);
	});

	it("appends across multiple calls in collector mode", async () => {
		const collector: string[] = [];
		const turn = makeTurn({ _replyCollector: collector });
		await sendMessageTool.execute({ text: "one" }, turn);
		await sendMessageTool.execute({ text: "two" }, turn);
		expect(collector).toEqual(["one", "two"]);
	});
});
