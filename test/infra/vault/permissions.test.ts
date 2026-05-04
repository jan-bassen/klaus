/**
 * `infra/vault/index.ts` — `checkPermission` allow/deny behaviour.
 */

import { describe, expect, it } from "vitest";
import type { VaultFolder } from "../../../src/infra/config.ts";
import { checkPermission } from "../../../src/infra/vault/index.ts";

const FOLDER_PRIVATE: VaultFolder = {
	path: "Private",
	default: "read",
};

const FOLDER_INBOX: VaultFolder = {
	path: "Inbox",
	default: "full",
};

const FOLDER_SECRETS: VaultFolder = {
	path: "Secrets",
	default: "none",
};

describe("infra/vault: checkPermission", () => {
	it("returns 'allowed' when op is at or below default", () => {
		expect(checkPermission(FOLDER_PRIVATE, "read")).toBe("allowed");
		expect(checkPermission(FOLDER_INBOX, "full")).toBe("allowed");
	});

	it("returns 'denied' when op exceeds default", () => {
		expect(checkPermission(FOLDER_INBOX, "full")).toBe("allowed");
		expect(checkPermission(FOLDER_SECRETS, "read")).toBe("denied");
		expect(checkPermission(FOLDER_SECRETS, "full")).toBe("denied");
	});

	it("agent override replaces the default", () => {
		expect(checkPermission(FOLDER_PRIVATE, "full", { Private: "read" })).toBe(
			"denied",
		);
		expect(
			checkPermission(FOLDER_PRIVATE, "full", {
				Private: "full",
			}),
		).toBe("allowed");
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
