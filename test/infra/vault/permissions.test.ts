import { describe, expect, it } from "vitest";
import { checkPermission } from "../../../src/infra/vault/index.ts";

describe("infra/vault: checkPermission", () => {
	it("denies when no access rule matches", () => {
		expect(checkPermission("Notes/today.md", "read")).toBe("denied");
	});

	it("uses '*' as the fallback access rule", () => {
		expect(checkPermission("Inbox/today.md", "read", { "*": "read" })).toBe(
			"allowed",
		);
		expect(checkPermission("Inbox/today.md", "full", { "*": "read" })).toBe(
			"denied",
		);
	});

	it("longest matching path wins over wildcard and shorter paths", () => {
		const access = {
			"*": "read",
			Projects: "none",
			"Projects/Klaus": "full",
		} as const;

		expect(checkPermission("Daily.md", "read", access)).toBe("allowed");
		expect(checkPermission("Projects/Secret.md", "read", access)).toBe(
			"denied",
		);
		expect(checkPermission("Projects/Klaus/Plan.md", "full", access)).toBe(
			"allowed",
		);
	});

	it("requires full access for append operations", () => {
		expect(checkPermission("Inbox/today.md", "append", { "*": "read" })).toBe(
			"denied",
		);
		expect(checkPermission("Inbox/today.md", "append", { "*": "full" })).toBe(
			"allowed",
		);
	});
});
