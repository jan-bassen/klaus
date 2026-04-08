import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

const TEST_DIR = path.join(import.meta.dir, "__settings-test-tmp");
const SETTINGS_PATH = path.join(TEST_DIR, "settings.yml");

mock.module("@/config", () => ({
	config: {
		vault: {
			root: TEST_DIR,
			internal: "Klaus",
			internalPath: TEST_DIR,
			agentsDir: path.join(TEST_DIR, "agents"),
			skillsDir: path.join(TEST_DIR, "skills"),
			snippetsDir: path.join(TEST_DIR, "snippets"),
			settingsPath: SETTINGS_PATH,
		},
		dataDir: TEST_DIR,
		log: { format: "json" },
		startup: { connectionWarnAfterMs: 60_000 },
	},
}));

const { SettingsSchema, loadSettingsFromDisk, getYamlSettings, _resetForTest } =
	await import("@/core/settings-loader");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	_resetForTest();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SettingsSchema", () => {
	test("parses empty object to full defaults", () => {
		const result = SettingsSchema.safeParse({});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.providers.active).toBe("claude");
		expect(result.data.providers.claude.medium).toBe(
			"claude-sonnet-4-20250514",
		);
		expect(result.data.locale).toBe("de-DE");
		expect(result.data.context.totalTokens).toBe(100_000);
		expect(result.data.defaultAgent).toBe("klaus");
	});

	test("accepts partial overrides", () => {
		const result = SettingsSchema.safeParse({
			providers: {
				claude: {
					sdk: "anthropic",
					small: "custom-small",
					medium: "custom-medium",
					large: "custom-large",
					vision: "custom-vision",
				},
			},
			locale: "en-US",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.providers.claude.medium).toBe("custom-medium");
		expect(result.data.providers.chatgpt.medium).toBe("gpt-4o");
		expect(result.data.locale).toBe("en-US");
	});

	test("rejects unknown top-level keys", () => {
		const result = SettingsSchema.safeParse({ bogus: true });
		expect(result.success).toBe(false);
	});

	test("accepts custom provider entries via catchall", () => {
		const result = SettingsSchema.safeParse({
			providers: {
				custom: {
					sdk: "openai",
					small: "a",
					medium: "b",
					large: "c",
					vision: "d",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("validates vault folder permissions", () => {
		const result = SettingsSchema.safeParse({
			vault: {
				folders: [{ path: "Test", default: "invalid" }],
			},
		});
		expect(result.success).toBe(false);
	});
});

describe("loadSettingsFromDisk", () => {
	test("generates default file when missing", async () => {
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(true);
		expect(Bun.file(SETTINGS_PATH).size).toBeGreaterThan(0);
	});

	test("loads valid YAML", async () => {
		writeFileSync(SETTINGS_PATH, stringifyYaml({ locale: "en-US" }));
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(true);
		expect(getYamlSettings().locale).toBe("en-US");
	});

	test("returns error for invalid YAML values", async () => {
		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml({
				providers: { claude: { sdk: 123 } },
			}),
		);
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("providers");
	});

	test("returns error for unknown keys", async () => {
		writeFileSync(SETTINGS_PATH, stringifyYaml({ unknownKey: "value" }));
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
	});

	test("keeps last valid state on reload failure", async () => {
		writeFileSync(SETTINGS_PATH, stringifyYaml({ locale: "fr-FR" }));
		await loadSettingsFromDisk();
		expect(getYamlSettings().locale).toBe("fr-FR");

		writeFileSync(SETTINGS_PATH, stringifyYaml({ bogusKey: true }));
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
		expect(getYamlSettings().locale).toBe("fr-FR");
	});
});
