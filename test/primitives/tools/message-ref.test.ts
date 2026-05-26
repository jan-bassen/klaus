import { describe, expect, it } from "vitest";
import { imageGenerateTool } from "../../../src/primitives/tools/image.ts";
import { reactTool } from "../../../src/primitives/tools/react.ts";

describe("primitives/tools: numeric message references", () => {
	it("react accepts omitted, current, and numbered refs only as integers", () => {
		expect(reactTool.inputSchema.safeParse({ emoji: "👍" }).success).toBe(true);
		expect(
			reactTool.inputSchema.safeParse({ emoji: "👍", messageRef: 0 }).success,
		).toBe(true);
		expect(
			reactTool.inputSchema.safeParse({ emoji: "👍", messageRef: 3 }).success,
		).toBe(true);
		expect(
			reactTool.inputSchema.safeParse({ emoji: "👍", messageRef: "current" })
				.success,
		).toBe(false);
		expect(
			reactTool.inputSchema.safeParse({ emoji: "👍", messageRef: "3" })
				.success,
		).toBe(false);
	});

	it("image refs accept omitted, current, and numbered refs only as integers", () => {
		expect(
			imageGenerateTool.inputSchema.safeParse({ prompt: "make it warmer" })
				.success,
		).toBe(true);
		expect(
			imageGenerateTool.inputSchema.safeParse({
				prompt: "make it warmer",
				sourceMessageRef: 0,
				messageRef: 3,
			}).success,
		).toBe(true);
		expect(
			imageGenerateTool.inputSchema.safeParse({
				prompt: "make it warmer",
				sourceMessageRef: "current",
			}).success,
		).toBe(false);
		expect(
			imageGenerateTool.inputSchema.safeParse({
				prompt: "make it warmer",
				messageRef: "3",
			}).success,
		).toBe(false);
	});
});
