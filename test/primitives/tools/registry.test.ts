/**
 * `primitives/tools/index.ts` — tool registration validation.
 *
 * Pure TS tests. The registry is module-level but cleared in test/setup.ts
 * afterEach, so registrations don't leak between tests.
 */

import { describe, it } from "vitest";

// import { z } from "zod";
// import { registerTool, generateMetaTool } from "@/primitives/tools";
// import type { ToolDefinition } from "@/primitives/tools";

describe("primitives/tools: sideEffect enforcement", () => {
	it.todo(
		"registerTool with missing sideEffect throws",
	);

	it.todo(
		"registerTool with sideEffect: 'invalid' throws",
	);

	it.todo(
		"registerTool accepts 'external' | 'stateful' | 'pure'",
	);

	it.todo(
		"generateMetaTool produces a tool with sideEffect: 'pure'",
	);
});

describe("primitives/tools: registerToolset", () => {
	it.todo(
		"registers each contained tool + validates sideEffect on each",
	);

	it.todo(
		"a toolset containing a tool with missing sideEffect throws at register time",
	);
});
