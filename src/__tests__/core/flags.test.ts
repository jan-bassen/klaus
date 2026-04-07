import { describe, expect, mock, test } from "bun:test";

mock.module("@/settings", () => ({
	settings: {
		llm: { coldTemperature: 0, hotTemperature: 1 },
	},
}));

const { resolveOverrides } = await import("@/core/flags");

describe("resolveOverrides", () => {
	test("returns empty object for no flags", () => {
		expect(resolveOverrides({})).toEqual({});
	});

	test("voice flag sets forceVoice", () => {
		expect(resolveOverrides({ voice: true })).toEqual({ forceVoice: true });
	});

	test("clean flag sets skipHistory", () => {
		expect(resolveOverrides({ clean: true })).toEqual({ skipHistory: true });
	});

	test("small flag sets modelTier to low", () => {
		expect(resolveOverrides({ small: true })).toEqual({ modelTier: "low" });
	});

	test("medium flag sets modelTier to default", () => {
		expect(resolveOverrides({ medium: true })).toEqual({
			modelTier: "default",
		});
	});

	test("large flag sets modelTier to high", () => {
		expect(resolveOverrides({ large: true })).toEqual({ modelTier: "high" });
	});

	test("accept flag sets autoAccept", () => {
		expect(resolveOverrides({ accept: true })).toEqual({ autoAccept: true });
	});

	test("cold flag sets temperature from settings", () => {
		expect(resolveOverrides({ cold: true })).toEqual({ temperature: 0 });
	});

	test("hot flag sets temperature from settings", () => {
		expect(resolveOverrides({ hot: true })).toEqual({ temperature: 1 });
	});

	test("no-tools flag sets toolChoice to none", () => {
		expect(resolveOverrides({ "no-tools": true })).toEqual({
			toolChoice: "none",
		});
	});

	test("use-tools flag sets toolChoice to required", () => {
		expect(resolveOverrides({ "use-tools": true })).toEqual({
			toolChoice: "required",
		});
	});

	test("ghost flag sets ghost and skipHistory", () => {
		expect(resolveOverrides({ ghost: true })).toEqual({
			ghost: true,
			skipHistory: true,
		});
	});

	test("combines multiple flags", () => {
		expect(resolveOverrides({ voice: true, large: true })).toEqual({
			forceVoice: true,
			modelTier: "high",
		});
	});

	test("combines all original flags", () => {
		expect(resolveOverrides({ voice: true, clean: true, small: true })).toEqual(
			{
				forceVoice: true,
				skipHistory: true,
				modelTier: "low",
			},
		);
	});

	test("ignores false flags", () => {
		expect(resolveOverrides({ voice: false, clean: false })).toEqual({});
	});

	test("ignores unknown flags", () => {
		expect(resolveOverrides({ unknown: true })).toEqual({});
	});

	test("last model tier flag wins", () => {
		const result = resolveOverrides({ small: true, large: true });
		expect(result.modelTier).toBe("high");
	});

	test("last temperature flag wins (hot after cold)", () => {
		const result = resolveOverrides({ cold: true, hot: true });
		expect(result.temperature).toBe(1);
	});

	test("last toolChoice flag wins (use-tools after no-tools)", () => {
		const result = resolveOverrides({
			"no-tools": true,
			"use-tools": true,
		});
		expect(result.toolChoice).toBe("required");
	});

	test("ghost combined with other flags", () => {
		const result = resolveOverrides({
			ghost: true,
			voice: true,
			accept: true,
		});
		expect(result).toEqual({
			ghost: true,
			skipHistory: true,
			forceVoice: true,
			autoAccept: true,
		});
	});
});
