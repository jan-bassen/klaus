import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { config } from "@/config";
import { log } from "@/logger";

const VaultPermissionSchema = z.enum(["none", "read", "append", "full"]);

const VaultFolderSchema = z
	.object({
		path: z.string(),
		default: VaultPermissionSchema,
		request: VaultPermissionSchema.optional(),
	})
	.strict();

const ProviderSchema = z
	.object({
		sdk: z.string(),
		small: z.string(),
		medium: z.string(),
		large: z.string(),
		vision: z.string(),
		temperature: z.number().optional(),
		coldTemperature: z.number().optional(),
		hotTemperature: z.number().optional(),
		topP: z.number().optional(),
		creativeTopP: z.number().optional(),
		rigidTopP: z.number().optional(),
	})
	.strict();

const ProvidersSchema = z
	.object({
		active: z.string().default("claude"),
		claude: ProviderSchema.default({
			sdk: "anthropic",
			small: "claude-haiku-3-20250307",
			medium: "claude-sonnet-4-20250514",
			large: "claude-opus-4-20250514",
			vision: "claude-sonnet-4-20250514",
			coldTemperature: 0,
			hotTemperature: 1,
			creativeTopP: 0.95,
			rigidTopP: 0.1,
		}),
		chatgpt: ProviderSchema.default({
			sdk: "openai",
			small: "gpt-4o-mini",
			medium: "gpt-4o",
			large: "o3",
			vision: "gpt-4o",
			coldTemperature: 0,
			hotTemperature: 1.5,
			creativeTopP: 0.95,
			rigidTopP: 0.1,
		}),
		gemini: ProviderSchema.default({
			sdk: "google",
			small: "gemini-2.0-flash-lite",
			medium: "gemini-2.5-pro",
			large: "gemini-2.5-pro",
			vision: "gemini-2.5-pro",
			coldTemperature: 0,
			hotTemperature: 1.5,
			creativeTopP: 0.95,
			rigidTopP: 0.1,
		}),
	})
	.catchall(ProviderSchema)
	.default({});

const ContextSchema = z
	.object({
		totalTokens: z.number().default(100_000),
		conversationTokens: z.number().default(20_000),
		activeTasksTokens: z.number().default(5_000),
		defaultConversationLimit: z.number().default(20),
		charsPerToken: z.number().default(4),
		maxReasoningChars: z.number().default(2_000),
		maxToolResultChars: z.number().default(2_000),
		traceDepth: z.number().default(3),
		conversationLookbackDays: z.number().default(7),
	})
	.strict()
	.default({});

const RateLimitEntrySchema = z
	.object({
		max: z.number(),
		windowMs: z.number(),
	})
	.strict();

const RateLimitsSchema = z
	.object({
		messages: RateLimitEntrySchema.default({ max: 30, windowMs: 60_000 }),
		modelCalls: RateLimitEntrySchema.default({ max: 60, windowMs: 60_000 }),
	})
	.strict()
	.default({});

const TtsSchema = z
	.object({
		model: z.string().default("eleven_multilingual_v2"),
		voiceId: z.string().default("Qqi8SzIZjZsatCWjDOp7"),
	})
	.strict()
	.default({});

const SttSchema = z
	.object({
		model: z.string().default("scribe_v1"),
		timeoutMs: z.number().default(30_000),
		agentTriggers: z
			.array(z.string())
			.default(["hey", "at", "an", "to", "dear"]),
		flagTriggers: z
			.array(z.string())
			.default(["flagged with", "tagged with", "flags", "tags", "flag", "tag"]),
	})
	.strict()
	.default({});

const RetriesSchema = z
	.object({
		max: z.number().default(3),
		backoffMs: z.number().default(1_000),
	})
	.strict()
	.default({});

const SendSchema = z
	.object({
		interMessageDelayMs: z.number().default(1_500),
	})
	.strict()
	.default({});

const LlmSchema = z
	.object({
		timeoutMs: z.number().default(120_000),
		maxSteps: z.number().default(10),
	})
	.strict()
	.default({});

const DispatchSchema = z
	.object({
		maxChainDepth: z.number().default(10),
	})
	.strict()
	.default({});

const PersistentSchema = z
	.object({
		minNextRunMs: z.number().default(60_000),
		maxNextRunMs: z.number().default(7 * 86_400_000),
		defaultNextRun: z.string().default("1h"),
	})
	.strict()
	.default({});

const TrailSchema = z
	.object({
		enabled: z.boolean().default(true),
		retentionDays: z.number().default(3),
	})
	.strict()
	.default({});

const WatcherSchema = z
	.object({
		debounceMs: z.number().default(1_000),
	})
	.strict()
	.default({});

const VisionSchema = z
	.object({
		maxImageDimension: z.number().default(2048),
	})
	.strict()
	.default({});

const WhatsAppSchema = z
	.object({
		maxDownloadBytes: z.number().default(67_108_864),
		mediaDownloadTimeoutMs: z.number().default(30_000),
		offlineWindowMs: z.number().default(300_000),
		maxSeenSize: z.number().default(10_000),
		confirmTimeoutMs: z.number().default(60_000),
	})
	.strict()
	.default({});

const VaultYamlSchema = z
	.object({
		folders: z.array(VaultFolderSchema).default([
			{ path: "Leben", default: "full" },
			{ path: "Projekte", default: "full" },
			{ path: "Sammlung", default: "read", request: "full" },
			{ path: "Wissen", default: "read" },
			{ path: "", default: "full" },
		]),
		internalPermission: z
			.object({
				default: VaultPermissionSchema.default("read"),
				request: VaultPermissionSchema.optional(),
			})
			.strict()
			.default({ default: "read", request: "full" }),
		maxListEntries: z.number().default(200),
	})
	.strict()
	.default({});

export const SettingsSchema = z
	.object({
		providers: ProvidersSchema,
		context: ContextSchema,
		rateLimits: RateLimitsSchema,
		tts: TtsSchema,
		stt: SttSchema,
		retries: RetriesSchema,
		send: SendSchema,
		llm: LlmSchema,
		defaultAgent: z.string().default("klaus"),
		locale: z.string().default("de-DE"),
		timezone: z.string().default("Europe/Berlin"),
		dispatch: DispatchSchema,
		persistent: PersistentSchema,
		trail: TrailSchema,
		watcher: WatcherSchema,
		vision: VisionSchema,
		whatsapp: WhatsAppSchema,
		vault: VaultYamlSchema,
	})
	.strict()
	.default({});

export type YamlSettings = z.output<typeof SettingsSchema>;

let _current: YamlSettings = SettingsSchema.parse({});

export function getYamlSettings(): YamlSettings {
	return _current;
}

/** For tests only — override settings in memory. */
export function _setForTest(override: Partial<YamlSettings>): void {
	_current = { ..._current, ...override };
}

/** For tests only — reset to schema defaults. */
export function _resetForTest(): void {
	_current = SettingsSchema.parse({});
}

export async function loadSettingsFromDisk(): Promise<
	{ ok: true } | { ok: false; error: string }
> {
	const filePath = config.vault.settingsPath;

	if (!existsSync(filePath)) {
		await generateDefaultSettings(filePath);
		return { ok: true };
	}

	try {
		const raw = await Bun.file(filePath).text();
		const parsed = parseYaml(raw);
		const result = SettingsSchema.safeParse(parsed ?? {});

		if (!result.success) {
			const issues = result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			return { ok: false, error: issues };
		}

		_current = result.data;
		log.info("[settings] loaded from disk", { path: filePath });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

async function generateDefaultSettings(filePath: string): Promise<void> {
	const defaults = SettingsSchema.parse({});
	const yaml = stringifyYaml(defaults, { lineWidth: 120 });
	await Bun.write(filePath, yaml);
	log.info("[settings] generated default settings.yml", { path: filePath });
}

let _watcher: FSWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function watchSettings(): void {
	const filePath = config.vault.settingsPath;
	if (!existsSync(filePath)) return;

	_watcher = watch(filePath, () => {
		if (_debounceTimer) clearTimeout(_debounceTimer);
		_debounceTimer = setTimeout(async () => {
			_debounceTimer = null;
			const result = await loadSettingsFromDisk();
			if (!result.ok) {
				log.warn("[settings] reload failed, keeping last valid config", {
					error: result.error,
				});
				warnViaWhatsApp(result.error);
			}
		}, 1_000);
	});

	log.info("[settings] watching for changes", { path: filePath });
}

export function stopSettingsWatcher(): void {
	if (_watcher) {
		_watcher.close();
		_watcher = null;
	}
	if (_debounceTimer) {
		clearTimeout(_debounceTimer);
		_debounceTimer = null;
	}
}

function warnViaWhatsApp(error: string): void {
	const chatId = process.env.ALLOWED_CHAT_ID;
	if (!chatId) return;

	// Lazy import to avoid circular dependency (send.ts imports settings.ts)
	import("@/whatsapp/send").then(({ enqueueMessage }) => {
		enqueueMessage({
			chatId,
			content: `*Settings warning*: settings.yml has validation errors. Keeping last valid config.\n\n${error}`,
			dedupKey: `settings-invalid:${Date.now()}`,
		});
	});
}
