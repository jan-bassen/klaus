/**
 * `primitives/tools/message.ts` — schema and inline guard.
 *
 * The full send path goes through `enqueueMessage`, the message-agent template,
 * and (optionally) TTS. Those are exercised end-to-end in
 * `test/pipeline/{core,index}.test.ts`. Here we only cover cheap-to-isolate
 * schema and context behaviour.
 */

import { describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod/v4";
import { sendMessageTool } from "../../../src/primitives/tools/message.ts";
import { makeTurn } from "../../helpers/turn.ts";

vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
}));

describe("primitives/tools/send_message", () => {
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

	it("returns an error during inline dispatch", async () => {
		const turn = makeTurn({
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
		});
		const result = await sendMessageTool.execute(
			{ text: "child send_message" },
			turn,
		);
		expect(result).toEqual({
			error: expect.stringContaining("use return_result instead"),
		});
	});
});
