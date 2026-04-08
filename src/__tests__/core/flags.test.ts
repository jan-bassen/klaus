import { describe, expect, test } from "bun:test";
import { resolveOverrides } from "@/core/flags";

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

	test("small flag sets modelTier to small", () => {
		expect(resolveOverrides({ small: true })).toEqual({ modelTier: "small" });
	});

	test("medium flag sets modelTier to medium", () => {
		expect(resolveOverrides({ medium: true })).toEqual({
			modelTier: "medium",
		});
	});

	test("large flag sets modelTier to large", () => {
		expect(resolveOverrides({ large: true })).toEqual({ modelTier: "large" });
	});

	test("accept flag sets autoAccept", () => {
		expect(resolveOverrides({ accept: true })).toEqual({ autoAccept: true });
	});

	test("cold flag sets temperaturePreset", () => {
		expect(resolveOverrides({ cold: true })).toEqual({
			temperaturePreset: "cold",
		});
	});

	test("hot flag sets temperaturePreset", () => {
		expect(resolveOverrides({ hot: true })).toEqual({
			temperaturePreset: "hot",
		});
	});

	test("creative flag sets topPPreset", () => {
		expect(resolveOverrides({ creative: true })).toEqual({
			topPPreset: "creative",
		});
	});

	test("rigid flag sets topPPreset", () => {
		expect(resolveOverrides({ rigid: true })).toEqual({
			topPPreset: "rigid",
		});
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
			modelTier: "large",
		});
	});

	test("combines all original flags", () => {
		expect(resolveOverrides({ voice: true, clean: true, small: true })).toEqual(
			{
				forceVoice: true,
				skipHistory: true,
				modelTier: "small",
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
		expect(result.modelTier).toBe("large");
	});

	test("last temperature flag wins (hot after cold)", () => {
		const result = resolveOverrides({ cold: true, hot: true });
		expect(result.temperaturePreset).toBe("hot");
	});

	test("last topP flag wins (rigid after creative)", () => {
		const result = resolveOverrides({ creative: true, rigid: true });
		expect(result.topPPreset).toBe("rigid");
	});

	test("last toolChoice flag wins (use-tools after no-tools)", () => {
		const result = resolveOverrides({
			"no-tools": true,
			"use-tools": true,
		});
		expect(result.toolChoice).toBe("required");
	});

	test("low flag sets reasoningEffort to low", () => {
		expect(resolveOverrides({ low: true })).toEqual({
			reasoningEffort: "low",
		});
	});

	test("high flag sets reasoningEffort to high", () => {
		expect(resolveOverrides({ high: true })).toEqual({
			reasoningEffort: "high",
		});
	});

	test("fast flag sets fast", () => {
		expect(resolveOverrides({ fast: true })).toEqual({ fast: true });
	});

	test("last reasoning effort flag wins (high after low)", () => {
		const result = resolveOverrides({ low: true, high: true });
		expect(result.reasoningEffort).toBe("high");
	});

	test("combines reasoning effort with other flags", () => {
		expect(resolveOverrides({ low: true, fast: true, voice: true })).toEqual({
			reasoningEffort: "low",
			fast: true,
			forceVoice: true,
		});
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
