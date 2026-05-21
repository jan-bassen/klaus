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
	(tool) => tool.name === "dispatch",
);

describe("parseRunAt", () => {
	it("'30m' → now + 30*60*1000 (±tolerance)", () => {
		const before = Date.now();
		const out = new Date(parseRunAt("30m")).getTime();
		const after = Date.now();
		expect(out).toBeGreaterThanOrEqual(before + 30 * 60_000);
		expect(out).toBeLessThanOrEqual(after + 30 * 60_000 + 50);
	});

	it("'2h' → now + 2*3600*1000", () => {
		const out = new Date(parseRunAt("2h")).getTime();
		expect(out - Date.now()).toBeGreaterThan(2 * 3_600_000 - 100);
		expect(out - Date.now()).toBeLessThanOrEqual(2 * 3_600_000 + 100);
	});

	it("'1d' → now + 86_400_000", () => {
		const out = new Date(parseRunAt("1d")).getTime();
		expect(out - Date.now()).toBeGreaterThan(86_400_000 - 100);
		expect(out - Date.now()).toBeLessThanOrEqual(86_400_000 + 100);
	});

	it("'90s' → now + 90_000", () => {
		const out = new Date(parseRunAt("90s")).getTime();
		expect(out - Date.now()).toBeGreaterThan(90_000 - 100);
		expect(out - Date.now()).toBeLessThanOrEqual(90_000 + 100);
	});

	it("ISO datetime → same instant, normalised to ISO string", () => {
		const iso = "2030-04-25T12:00:00.000Z";
		expect(parseRunAt(iso)).toBe(iso);
	});

	it("garbage input throws with helpful message", () => {
		expect(() => parseRunAt("not a date")).toThrow(/Invalid when value/);
	});
});

describe("dispatch tool", () => {
	it("returns inline child replies to the caller without queueing them for user send", async () => {
		dispatchMock.mockImplementationOnce(async ({ replyCollector }) => {
			replyCollector.push("child result");
			return "child result";
		});

		const turn = makeTurn();
		const result = await dispatchTool?.execute({ prompt: "check this" }, turn);

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
