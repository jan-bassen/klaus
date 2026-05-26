import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	generateMetaTool,
	registerToolset,
	type ToolDefinition,
	type ToolsetDefinition,
	toolRegistry,
} from "../../../src/primitives/tools/index.ts";

function pureTool(name: string): ToolDefinition<z.ZodTypeAny> {
	return {
		name,
		description: "x",
		inputSchema: z.object({}),
		execute: async () => "ok",
	};
}

describe("primitives/tools: meta-tools", () => {
	it("generateMetaTool produces a loader tool", () => {
		const ts: ToolsetDefinition = {
			name: "files",
			description: "files toolset",
			tools: [pureTool("files.read")],
		};
		const meta = generateMetaTool(ts);
		expect(meta.name).toBe("load_files");
		expect(meta.description).toContain("files toolset");
	});
});

describe("primitives/tools: registerToolset", () => {
	it("registers each contained tool", () => {
		const ts: ToolsetDefinition = {
			name: "demo",
			description: "demo",
			tools: [pureTool("demo.a"), pureTool("demo.b")],
		};
		registerToolset(ts);
		expect(toolRegistry.has("demo.a")).toBe(true);
		expect(toolRegistry.has("demo.b")).toBe(true);
	});
});
