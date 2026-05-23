/**
 * `primitives/tools/reply.ts` — collector branch.
 *
 * The full send path goes through `enqueueMessage`, the message-agent template,
 * and (optionally) TTS. Those are exercised end-to-end in
 * `test/pipeline/{core,index}.test.ts`. Here we only cover the cheap-to-isolate
 * inline-dispatch reply collection branch.
 */

import { describe, expect, it, vi } from "vitest";
import { toJSONSchema } from "zod/v4";
import { replyTool } from "../../../src/primitives/tools/reply.ts";
import { makeTurn } from "../../helpers/turn.ts";

vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: vi.fn(),
}));

describe("primitives/tools/reply: collector branch", () => {
	it("requires content and exposes voice as a delivery choice", () => {
		const schema = toJSONSchema(replyTool.inputSchema);
		expect(schema).toMatchObject({
			properties: {
				content: expect.any(Object),
				voice: expect.any(Object),
				messageRef: expect.any(Object),
			},
			required: ["content"],
		});
		expect(replyTool.inputSchema.safeParse({ voice: true }).success).toBe(
			false,
		);
		expect(
			replyTool.inputSchema.safeParse({
				content: "reply",
				messageRef: "current",
			}).success,
		).toBe(false);
	});

	it("pushes content into the parent's _replyCollector and short-circuits", async () => {
		const collector: string[] = [];
		const turn = makeTurn({ _replyCollector: collector });
		const result = await replyTool.execute({ content: "child reply" }, turn);
		expect(result).toBe("sent");
		expect(collector).toEqual(["child reply"]);
	});

	it("appends across multiple calls in collector mode", async () => {
		const collector: string[] = [];
		const turn = makeTurn({ _replyCollector: collector });
		await replyTool.execute({ content: "one" }, turn);
		await replyTool.execute({ content: "two" }, turn);
		expect(collector).toEqual(["one", "two"]);
	});
});
