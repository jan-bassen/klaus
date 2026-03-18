import { describe, expect, test } from "bun:test";
import { formatUserError } from "@/core/errors";
import { LlmTimeoutError } from "@/core/model-router";

describe("formatUserError", () => {
	test("LlmTimeoutError → timeout message", () => {
		const err = new LlmTimeoutError("claude-3-haiku", 30000);
		expect(formatUserError(err)).toBe(
			"The AI model timed out — please try again.",
		);
	});

	test("rate limit error → rate limit message", () => {
		expect(formatUserError(new Error("rate limit exceeded"))).toBe(
			"Too many requests right now — please try again in a moment.",
		);
		expect(formatUserError(new Error("Rate_Limit hit"))).toBe(
			"Too many requests right now — please try again in a moment.",
		);
	});

	test("prompt too long → conversation too long message", () => {
		expect(
			formatUserError(new Error("prompt is too long for this model")),
		).toBe(
			"Your conversation got too long for the model — try starting fresh.",
		);
	});

	test("generic Error → includes first line of message", () => {
		const err = new Error("Connection refused\nat Socket.connect");
		expect(formatUserError(err)).toBe(
			"Something went wrong: Connection refused",
		);
	});

	test("generic Error → truncates at 120 chars", () => {
		const long = "x".repeat(200);
		expect(formatUserError(new Error(long))).toBe(
			`Something went wrong: ${"x".repeat(120)}`,
		);
	});

	test("non-Error value → stringified", () => {
		expect(formatUserError("oops")).toBe("Something went wrong: oops");
		expect(formatUserError(42)).toBe("Something went wrong: 42");
	});
});
