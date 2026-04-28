/**
 * `primitives/tools/index.ts` — registration validation + meta-tool generation.
 *
 * Pure TS tests. Registries are cleared in test/setup.ts afterEach.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	generateMetaTool,
	registerTool,
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
		sideEffect: "pure",
		kind: "builtin",
		capability: "tool",
	};
}

describe("primitives/tools: sideEffect enforcement", () => {
	it("registerTool with invalid sideEffect throws", () => {
		const bad = {
			...pureTool("bad"),
			sideEffect: "invalid" as unknown as "pure",
		};
		expect(() => registerTool(bad)).toThrow(/sideEffect/);
	});

	it("accepts external | stateful | pure", () => {
		registerTool({ ...pureTool("a"), sideEffect: "external" });
		registerTool({ ...pureTool("b"), sideEffect: "stateful" });
		registerTool({ ...pureTool("c"), sideEffect: "pure" });
		expect(toolRegistry.has("a")).toBe(true);
		expect(toolRegistry.has("b")).toBe(true);
		expect(toolRegistry.has("c")).toBe(true);
	});

	it("generateMetaTool produces a tool with sideEffect: 'pure'", () => {
		const ts: ToolsetDefinition = {
			name: "files",
			description: "files toolset",
			tools: [pureTool("files.read")],
		};
		const meta = generateMetaTool(ts);
		expect(meta.name).toBe("use_files");
		expect(meta.sideEffect).toBe("pure");
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

	it("toolset with invalid sideEffect throws at register time", () => {
		const ts: ToolsetDefinition = {
			name: "broken",
			description: "broken",
			tools: [
				{
					...pureTool("broken.x"),
					sideEffect: "weird" as unknown as "pure",
				},
			],
		};
		expect(() => registerToolset(ts)).toThrow(/sideEffect/);
	});
});
