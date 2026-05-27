import { describe, expect, it, vi } from "vitest";
import {
	dispatchToolset,
	parseRunAt,
} from "../../../../src/primitives/tools/sets/dispatch.ts";
import { makeTurn } from "../../../helpers/turn.ts";

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/pipeline/dispatch.ts", () => ({
	dispatch: dispatchMock,
}));

const dispatchTool = dispatchToolset.tools.find(
	(tool) => tool.name === "run_agent",
);

describe("parseRunAt", () => {
	it.each([
		["30m", 30 * 60_000],
		["2h", 2 * 3_600_000],
		["1d", 86_400_000],
		["90s", 90_000],
	])("%s → now + duration", (input, expectedMs) => {
		const before = Date.now();
		const out = new Date(parseRunAt(input)).getTime();
		const after = Date.now();
		expect(out).toBeGreaterThanOrEqual(before + expectedMs - 100);
		expect(out).toBeLessThanOrEqual(after + expectedMs + 100);
	});

	it("ISO datetime → same instant, normalised to ISO string", () => {
		const iso = "2030-04-25T12:00:00.000Z";
		expect(parseRunAt(iso)).toBe(iso);
	});

	it("garbage input throws with helpful message", () => {
		expect(() => parseRunAt("not a date")).toThrow(/Invalid runAt value/);
	});
});

describe("run_agent tool", () => {
	it("returns child messages to the caller without queueing them for user send", async () => {
		dispatchMock.mockImplementationOnce(async ({ replyCollector }) => {
			replyCollector.push("child result");
			return "child result";
		});

		const turn = makeTurn();
		const result = await dispatchTool?.execute({ task: "check this" }, turn);

		expect(result).toBe("child result");
		expect(dispatchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				agent: "dispatch",
				prompt: "check this",
				chatId: "c1",
				trigger: { kind: "dispatch", parentRunId: "r-test" },
				replyCollector: expect.any(Array),
			}),
		);
	});
});
