import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod/v4";
import { returnResultTool } from "../../../src/primitives/tools/core.ts";
import { makeTurn } from "../../helpers/turn.ts";

describe("primitives/tools/return_result", () => {
	it("requires text", () => {
		const schema = toJSONSchema(returnResultTool.inputSchema);
		expect(schema).toMatchObject({
			properties: {
				text: expect.any(Object),
			},
			required: ["text"],
		});
		expect(returnResultTool.inputSchema.safeParse({}).success).toBe(false);
		expect(
			returnResultTool.inputSchema.safeParse({ text: "done" }).success,
		).toBe(true);
	});

	it("pushes text into the inline result collector", async () => {
		const collector: string[] = [];
		const turn = makeTurn({
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			_resultCollector: collector,
		});

		const result = await returnResultTool.execute(
			{ text: "child result" },
			turn,
		);

		expect(result).toBe("returned");
		expect(collector).toEqual(["child result"]);
	});

	it("returns an error outside inline dispatch", async () => {
		const collector: string[] = [];
		const turn = makeTurn({ _resultCollector: collector });

		const result = await returnResultTool.execute({ text: "nope" }, turn);

		expect(result).toEqual({
			error: "return_result only works during inline dispatch",
		});
		expect(collector).toEqual([]);
	});
});
