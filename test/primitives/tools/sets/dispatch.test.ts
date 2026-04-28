/**
 * `primitives/tools/sets/dispatch.ts` — `parseRunAt` (the only piece worth
 * unit-testing without dragging in the dispatch + executeAgent stack).
 *
 * The dispatch tool execute paths involve mocks of `src/pipeline/dispatch.ts` +
 * `src/infra/store/timers.ts` + `src/infra/store/schedules.ts` and don't pay for
 * themselves as sanity checks for tinkering — the tool's logic is mostly
 * forwarding. We cover end-to-end behaviour separately via the store tests.
 */

import { describe, expect, it } from "vitest";
import { parseRunAt } from "../../../../src/primitives/tools/sets/dispatch.ts";

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
