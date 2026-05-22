import { evaluate } from "mathjs";
import { z } from "zod";
import type { ToolDefinition } from "./index.ts";

const schema = z.object({
	expression: z
		.string()
		.describe(
			"A mathjs expression to evaluate. Supports arithmetic, units, matrices, statistics, calculus, and named variables via `scope`.",
		),
	scope: z
		.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
		.optional()
		.describe(
			"Optional named variables referenced in the expression, e.g. { x: 3, y: 4 } for `x^2 + y^2`.",
		),
});

export const mathTool: ToolDefinition<typeof schema> = {
	name: "math",
	description:
		"Evaluate a math expression via mathjs. Use for arithmetic, unit conversions (`5 km in mile`), symbolic-ish work (`derivative('x^2', 'x')`), statistics (`mean([1,2,3])`), and matrices. Prefer this over mental math whenever precision matters.",
	inputSchema: schema,
	execute: async ({ expression, scope }) => {
		try {
			const result = evaluate(expression, scope ?? {});
			return { result: formatResult(result) };
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
};

function formatResult(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === "object" && "toString" in value) {
		return (value as { toString(): string }).toString();
	}
	return String(value);
}
