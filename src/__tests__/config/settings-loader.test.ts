import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

const TEST_DIR = path.join(import.meta.dir, "__settings-test-tmp");
const SETTINGS_PATH = path.join(TEST_DIR, "settings.yml");

mock.module("@/config/env", () => ({
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
	await import("@/config/schema");

// A minimal complete settings object matching the (defaults-free) schema —
// every required field must appear. Used as a base for partial overrides.
function completeSettings(over: Record<string, unknown> = {}): unknown {
	const base = {
		providers: {
			active: "claude",
			claude: {
				sdk: "anthropic",
				small: "claude-haiku",
				medium: "claude-sonnet",
				large: "claude-opus",
			},
			chatgpt: {
				sdk: "openai",
				small: "gpt-small",
				medium: "gpt-medium",
				large: "gpt-large",
			},
			gemini: {
				sdk: "google",
				small: "gemini-small",
				medium: "gemini-medium",
				large: "gemini-large",
			},
		},
		context: {
			conversationChars: 80000,
			defaultConversationLimit: 20,
			traceDepth: 3,
			conversationLookbackDays: 7,
		},
		rateLimits: {
			messages: { max: 30, windowMs: 60000 },
			modelCalls: { max: 60, windowMs: 60000 },
		},
		tts: { model: "eleven_ttv_v3", voiceId: "" },
		stt: { model: "scribe_v2", timeoutMs: 30000, agentTriggers: ["hey"] },
		retries: { max: 3, backoffMs: 1000 },
		send: { interMessageDelayMs: 1500 },
		llm: { timeoutMs: 120000, maxSteps: 10 },
		defaultAgent: "assistant",
		locale: "en-GB",
		timezone: "Europe/London",
		dispatch: { maxChainDepth: 10 },
		persistent: {
			minNextRunMs: 60000,
			maxNextRunMs: 604800000,
			defaultNextRun: "1h",
		},
		trail: { enabled: true, retentionDays: 3 },
		watcher: { debounceMs: 1000 },
		vision: { maxImageDimension: 2048 },
		document: { maxChars: 40000, ocrEnabled: true },
		web: {
			maxChars: 12000,
			timeoutMs: 10000,
			maxUrls: 3,
			maxBodyBytes: 5242880,
		},
		whatsapp: {
			selfMode: false,
			systemLabel: "System",
			maxDownloadBytes: 67108864,
			mediaDownloadTimeoutMs: 30000,
			offlineWindowMs: 300000,
			maxSeenSize: 10000,
			confirmTimeoutMs: 60000,
		},
		vault: {
			folders: [{ path: "", default: "full" }],
			internalPermission: { default: "read", request: "full" },
			maxListEntries: 200,
		},
	};
	return { ...base, ...over };
}

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	_resetForTest();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SettingsSchema", () => {
	test("rejects empty object — every top-level field is required", () => {
		const result = SettingsSchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test("accepts a complete settings object", () => {
		const result = SettingsSchema.safeParse(completeSettings());
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.providers.active).toBe("claude");
		expect(result.data.locale).toBe("en-GB");
		expect(result.data.defaultAgent).toBe("assistant");
	});

	test("rejects unknown top-level keys", () => {
		const result = SettingsSchema.safeParse(completeSettings({ bogus: true }));
		expect(result.success).toBe(false);
	});

	test("accepts custom provider entries via catchall", () => {
		const withCustom = completeSettings();
		(withCustom as { providers: Record<string, unknown> }).providers = {
			...(withCustom as { providers: Record<string, unknown> }).providers,
			custom: {
				sdk: "openai",
				small: "a",
				medium: "b",
				large: "c",
			},
		};
		const result = SettingsSchema.safeParse(withCustom);
		expect(result.success).toBe(true);
	});

	test("validates vault folder permissions", () => {
		const result = SettingsSchema.safeParse(
			completeSettings({
				vault: {
					folders: [{ path: "Test", default: "invalid" }],
					internalPermission: { default: "read", request: "full" },
					maxListEntries: 200,
				},
			}),
		);
		expect(result.success).toBe(false);
	});
});

describe("loadSettingsFromDisk", () => {
	test("falls back to bundled defaults when file missing", async () => {
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(true);
		// Bundled default ships with the repo's Klaus/settings.yml.
		expect(getYamlSettings().locale).toBe("en-GB");
		expect(getYamlSettings().defaultAgent).toBe("assistant");
	});

	test("loads valid YAML that overrides fields of the bundled default", async () => {
		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml(completeSettings({ locale: "en-US" })),
		);
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(true);
		expect(getYamlSettings().locale).toBe("en-US");
	});

	test("returns error for invalid YAML values", async () => {
		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml(
				completeSettings({
					providers: {
						active: "claude",
						claude: { sdk: 123, small: "a", medium: "b", large: "c" },
						chatgpt: {
							sdk: "openai",
							small: "a",
							medium: "b",
							large: "c",
						},
						gemini: {
							sdk: "google",
							small: "a",
							medium: "b",
							large: "c",
						},
					},
				}),
			),
		);
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("providers");
	});

	test("returns error for unknown keys", async () => {
		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml(completeSettings({ unknownKey: "value" })),
		);
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
	});

	test("keeps last valid state on reload failure", async () => {
		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml(completeSettings({ locale: "fr-FR" })),
		);
		await loadSettingsFromDisk();
		expect(getYamlSettings().locale).toBe("fr-FR");

		writeFileSync(
			SETTINGS_PATH,
			stringifyYaml(completeSettings({ bogusKey: true })),
		);
		const result = await loadSettingsFromDisk();
		expect(result.ok).toBe(false);
		expect(getYamlSettings().locale).toBe("fr-FR");
	});
});
