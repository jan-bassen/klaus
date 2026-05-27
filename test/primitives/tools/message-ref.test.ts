import { describe, expect, it } from "vitest";
import { sendImageTool } from "../../../src/primitives/tools/image.ts";
import { setReactionTool } from "../../../src/primitives/tools/react.ts";

describe("primitives/tools: numeric message references", () => {
	it("set_reaction accepts omitted, current, and numbered labels only as integers", () => {
		expect(setReactionTool.inputSchema.safeParse({ emoji: "👍" }).success).toBe(
			true,
		);
		expect(
			setReactionTool.inputSchema.safeParse({ emoji: "👍", messageLabel: 0 })
				.success,
		).toBe(true);
		expect(
			setReactionTool.inputSchema.safeParse({ emoji: "👍", messageLabel: 3 })
				.success,
		).toBe(true);
		expect(
			setReactionTool.inputSchema.safeParse({
				emoji: "👍",
				messageLabel: "current",
			}).success,
		).toBe(false);
		expect(
			setReactionTool.inputSchema.safeParse({ emoji: "👍", messageLabel: "3" })
				.success,
		).toBe(false);
	});

	it("send_image labels accept omitted, current, and numbered labels only as integers", () => {
		expect(
			sendImageTool.inputSchema.safeParse({ prompt: "make it warmer" }).success,
		).toBe(true);
		expect(
			sendImageTool.inputSchema.safeParse({
				prompt: "make it warmer",
				inputMessageLabel: 0,
				quoteMessageLabel: 3,
			}).success,
		).toBe(true);
		expect(
			sendImageTool.inputSchema.safeParse({
				prompt: "make it warmer",
				inputMessageLabel: "current",
			}).success,
		).toBe(false);
		expect(
			sendImageTool.inputSchema.safeParse({
				prompt: "make it warmer",
				quoteMessageLabel: "3",
			}).success,
		).toBe(false);
	});
});
