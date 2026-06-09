import { afterEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { formatTimerRunAt } from "../../src/primitives/time.ts";

const savedLocale = settings.basics.locale;
const savedTimezone = settings.basics.timezone;

describe("primitives/time", () => {
	afterEach(() => {
		settings.basics.locale = savedLocale;
		settings.basics.timezone = savedTimezone;
	});

	it("formats timer instants in the live Klaus timezone", () => {
		settings.basics.locale = "en-GB";
		settings.basics.timezone = "Europe/London";

		const out = formatTimerRunAt("2026-06-09T12:50:00.000Z");

		expect(out).toContain("13:50");
		expect(out).toContain("BST");
	});

	it("does not cache timezone settings across calls", () => {
		settings.basics.locale = "en-GB";
		settings.basics.timezone = "UTC";

		expect(formatTimerRunAt("2026-06-09T12:50:00.000Z")).toContain("12:50");

		settings.basics.timezone = "Europe/London";

		expect(formatTimerRunAt("2026-06-09T12:50:00.000Z")).toContain("13:50");
	});
});
