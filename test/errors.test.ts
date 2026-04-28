/**
 * `errors.ts` — formatUserError classification + default fallback messages.
 *
 * In the test environment the `error-message.md` template is not available,
 * so `renderTemplate` throws and `formatUserError` falls back to its built-in
 * default messages. That path is exactly what we test here.
 */

import { describe, expect, it } from "vitest";
import { formatUserError } from "@/errors";
import { LlmTimeoutError } from "@/pipeline/core";

describe("errors: formatUserError", () => {
	it("returns timeout message for LlmTimeoutError", () => {
		const msg = formatUserError(new LlmTimeoutError("m", 30_000));
		expect(msg).toMatch(/timed out/i);
	});

	it("returns rate-limit message for 'rate limit' error text", () => {
		expect(formatUserError(new Error("rate limit exceeded"))).toMatch(
			/too many requests/i,
		);
		expect(formatUserError(new Error("RateLimit hit"))).toMatch(
			/too many requests/i,
		);
	});

	it("returns too-long message for 'prompt is too long' error text", () => {
		expect(
			formatUserError(new Error("prompt is too long for this model")),
		).toMatch(/too long/i);
	});

	it("returns generic message containing first line of error for unknown errors", () => {
		const msg = formatUserError(new Error("something broke\nline two"));
		expect(msg).toContain("something broke");
		expect(msg).not.toContain("line two");
	});

	it("handles non-Error thrown values (string)", () => {
		const msg = formatUserError("plain string error");
		expect(msg).toContain("plain string error");
	});

	it("handles non-Error thrown values (number)", () => {
		const msg = formatUserError(42);
		expect(msg).toContain("42");
	});

	it("caps generic message at 120 characters", () => {
		const longError = new Error("x".repeat(200));
		const msg = formatUserError(longError);
		// The extracted message portion is capped at 120 chars
		const extracted = msg.replace(/^Something went wrong: /, "");
		expect(extracted.length).toBeLessThanOrEqual(120);
	});
});
