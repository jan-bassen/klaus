import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { log } from "@/logger";
import { config } from "./env";

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
		active: z.string(),
		claude: ProviderSchema,
		chatgpt: ProviderSchema,
		gemini: ProviderSchema,
	})
	.catchall(ProviderSchema);

const ContextSchema = z
	.object({
		/** Char budget for conversation history messages (user + assistant turns incl. traces). */
		conversationChars: z.number(),
		defaultConversationLimit: z.number(),
		/** How many of the most recent user turns keep full tool traces; older turns get compact summaries. */
		traceDepth: z.number(),
		conversationLookbackDays: z.number(),
	})
	.strict();

const RateLimitEntrySchema = z
	.object({
		max: z.number(),
		windowMs: z.number(),
	})
	.strict();

const RateLimitsSchema = z
	.object({
		messages: RateLimitEntrySchema,
		modelCalls: RateLimitEntrySchema,
	})
	.strict();

const TtsSchema = z
	.object({
		model: z.string(),
		voiceId: z.string(),
	})
	.strict();

const SttSchema = z
	.object({
		model: z.string(),
		timeoutMs: z.number(),
		agentTriggers: z.array(z.string()),
	})
	.strict();

const RetriesSchema = z
	.object({
		max: z.number(),
		backoffMs: z.number(),
	})
	.strict();

const SendSchema = z
	.object({
		interMessageDelayMs: z.number(),
	})
	.strict();

const LlmSchema = z
	.object({
		timeoutMs: z.number(),
		maxSteps: z.number(),
	})
	.strict();

const DispatchSchema = z
	.object({
		maxChainDepth: z.number(),
	})
	.strict();

const PersistentSchema = z
	.object({
		minNextRunMs: z.number(),
		maxNextRunMs: z.number(),
		defaultNextRun: z.string(),
	})
	.strict();

const TrailSchema = z
	.object({
		enabled: z.boolean(),
		retentionDays: z.number(),
	})
	.strict();

const WatcherSchema = z
	.object({
		debounceMs: z.number(),
	})
	.strict();

const VisionSchema = z
	.object({
		maxImageDimension: z.number(),
	})
	.strict();

const DocumentSchema = z
	.object({
		/** Max chars of parsed text kept inline in the user message or returned by files.read */
		maxChars: z.number(),
		/** OCR for scanned PDFs / image-only pages */
		ocrEnabled: z.boolean(),
	})
	.strict();

const WebSchema = z
	.object({
		/** Max chars of fetched content kept inline per URL */
		maxChars: z.number(),
		/** Fetch timeout per URL in ms */
		timeoutMs: z.number(),
		/** Max number of URLs to auto-fetch per message */
		maxUrls: z.number(),
		/** Max response body size in bytes before aborting */
		maxBodyBytes: z.number(),
	})
	.strict();

const WhatsAppSchema = z
	.object({
		selfMode: z.boolean(),
		systemLabel: z.string(),
		maxDownloadBytes: z.number(),
		mediaDownloadTimeoutMs: z.number(),
		offlineWindowMs: z.number(),
		maxSeenSize: z.number(),
		confirmTimeoutMs: z.number(),
	})
	.strict();

const VaultYamlSchema = z
	.object({
		folders: z.array(VaultFolderSchema),
		internalPermission: z
			.object({
				default: VaultPermissionSchema,
				request: VaultPermissionSchema.optional(),
			})
			.strict(),
		maxListEntries: z.number(),
	})
	.strict();

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
		allowedChatId: z.string().optional(),
		defaultAgent: z.string(),
		locale: z.string(),
		timezone: z.string(),
		dispatch: DispatchSchema,
		persistent: PersistentSchema,
		trail: TrailSchema,
		watcher: WatcherSchema,
		vision: VisionSchema,
		document: DocumentSchema,
		web: WebSchema,
		whatsapp: WhatsAppSchema,
		vault: VaultYamlSchema,
	})
	.strict();

export type YamlSettings = z.output<typeof SettingsSchema>;

/**
 * Bundled default settings.yml shipped with the repo. This is the single
 * source of truth for defaults — the Zod schema only validates; it carries no
 * `.default()` fallbacks. `_current` is initialized from this file at module
 * load, and `loadSettingsFromDisk()` later overrides with the vault copy at
 * runtime (after `ensureDefaults()` has copied the bundled file into the
 * vault on first run).
 */
const BUNDLED_SETTINGS_PATH = path.join(
	import.meta.dir,
	"..",
	"..",
	"Klaus",
	"settings.yml",
);

function loadBundledDefaults(): YamlSettings {
	let raw: string;
	try {
		raw = readFileSync(BUNDLED_SETTINGS_PATH, "utf8");
	} catch (err) {
		throw new Error(
			`Bundled default settings file missing or unreadable at ${BUNDLED_SETTINGS_PATH}. ` +
				`This is a deployment bug — the repo's Klaus/settings.yml must ship with the binary. ` +
				`Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const parsed = parseYaml(raw);
	const result = SettingsSchema.safeParse(parsed ?? {});
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
		throw new Error(
			`Bundled default settings at ${BUNDLED_SETTINGS_PATH} failed validation: ${issues}`,
		);
	}
	return result.data;
}

let _current: YamlSettings = loadBundledDefaults();

export function getYamlSettings(): YamlSettings {
	return _current;
}

/** For tests only — override settings in memory. */
export function _setForTest(override: Partial<YamlSettings>): void {
	_current = { ..._current, ...override };
}

/** For tests only — reset to the bundled default settings. */
export function _resetForTest(): void {
	_current = loadBundledDefaults();
}

export async function loadSettingsFromDisk(): Promise<
	{ ok: true } | { ok: false; error: string }
> {
	const filePath = config.vault.settingsPath;

	if (!existsSync(filePath)) {
		log.info("[settings] no settings.yml in vault, using bundled defaults");
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
		log.info("[settings] loaded from disk");
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
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
				log.warn("[settings] reload failed, keeping last valid config");
				warnViaWhatsApp(result.error);
			}
		}, 1_000);
	});

	log.info("[settings] watching for changes");
}

export async function updateAllowedChatId(chatId: string): Promise<void> {
	const filePath = config.vault.settingsPath;
	let parsed: Record<string, unknown> = {};

	if (existsSync(filePath)) {
		const raw = await Bun.file(filePath).text();
		parsed = (parseYaml(raw) as Record<string, unknown>) ?? {};
	}

	parsed.allowedChatId = chatId;
	const yaml = stringifyYaml(parsed, { lineWidth: 120 });
	await Bun.write(filePath, yaml);

	await loadSettingsFromDisk();
	log.info("[settings] updated allowedChatId");
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
	const chatId = _current.allowedChatId ?? process.env.ALLOWED_CHAT_ID;
	if (!chatId) return;

	// Lazy import to avoid circular dependency (send.ts imports settings.ts)
	import("@/whatsapp/send").then(({ enqueueMessage }) => {
		enqueueMessage({
			chatId,
			content: `*Settings warning*: settings.yml has validation errors. Keeping last valid config.\n\n${error}`,
			dedupKey: `settings-invalid:${Date.now()}`,
			label: _current.whatsapp.systemLabel,
		});
	});
}
