/**
 * `infra/vault/index.ts` — `checkPermission` three-state behaviour.
 *
 * The new `confirm` ceiling lets agents request elevation: ops above the
 * effective `default` but ≤ the `confirm` level return `"needsConfirm"`. The
 * framework gate (in `pipeline/confirmations.ts`) is what actually blocks
 * the call until the user reacts; this test only covers the permission
 * resolution logic.
 */

import { describe, expect, it } from "vitest";
import type { VaultFolder } from "@/infra/config";
import { checkPermission } from "@/infra/vault";

const FOLDER_PRIVATE: VaultFolder = {
	path: "Private",
	default: "read",
	confirm: "full",
};

const FOLDER_INBOX: VaultFolder = {
	path: "Inbox",
	default: "full",
};

const FOLDER_SECRETS: VaultFolder = {
	path: "Secrets",
	default: "none",
};

describe("infra/vault: checkPermission three-state", () => {
	it("returns 'allowed' when op is at or below default", () => {
		expect(checkPermission(FOLDER_PRIVATE, "read")).toBe("allowed");
		expect(checkPermission(FOLDER_INBOX, "full")).toBe("allowed");
	});

	it("returns 'needsConfirm' when op is above default but ≤ confirm ceiling", () => {
		expect(checkPermission(FOLDER_PRIVATE, "append")).toBe("needsConfirm");
		expect(checkPermission(FOLDER_PRIVATE, "full")).toBe("needsConfirm");
	});

	it("returns 'denied' when no confirm ceiling is declared and op exceeds default", () => {
		expect(checkPermission(FOLDER_INBOX, "full")).toBe("allowed");
		expect(checkPermission(FOLDER_SECRETS, "read")).toBe("denied");
		expect(checkPermission(FOLDER_SECRETS, "full")).toBe("denied");
	});

	it("returns 'denied' when op exceeds the confirm ceiling", () => {
		const folder: VaultFolder = {
			path: "Strict",
			default: "read",
			confirm: "append",
		};
		expect(checkPermission(folder, "full")).toBe("denied");
	});

	it("agent override (bare string) replaces the default and drops any ceiling", () => {
		// Even though FOLDER_PRIVATE has confirm: full, the agent's bare-string
		// override is taken as `{default: "read"}` with no ceiling.
		expect(checkPermission(FOLDER_PRIVATE, "full", { Private: "read" })).toBe(
			"denied",
		);
	});

	it("agent override with {default, confirm} object adjusts both", () => {
		expect(
			checkPermission(FOLDER_PRIVATE, "full", {
				Private: { default: "none", confirm: "full" },
			}),
		).toBe("needsConfirm");

		expect(
			checkPermission(FOLDER_PRIVATE, "read", {
				Private: { default: "none", confirm: "full" },
			}),
		).toBe("needsConfirm");
	});

	it("'*' wildcard applies when no exact match", () => {
		expect(checkPermission(FOLDER_INBOX, "full", { "*": "read" })).toBe(
			"denied",
		);
		expect(checkPermission(FOLDER_INBOX, "read", { "*": "read" })).toBe(
			"allowed",
		);
	});

	it("exact path match wins over wildcard", () => {
		expect(
			checkPermission(FOLDER_INBOX, "full", {
				"*": "read",
				Inbox: "full",
			}),
		).toBe("allowed");
	});
});
