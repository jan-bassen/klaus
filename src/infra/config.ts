/**
 * YAML settings + env-derived paths. Single source of truth for "static"
 * configuration: anything read from the user's `{vault}/Klaus/settings.yml`
 * at startup or derived from env vars. The repo `vault/settings.yml` is only
 * a first-run template for bootstrapping a missing Klaus folder.
 *
 * Per-turn config (overrides, `TurnConfig`, `buildTurnConfig`) lives in
 * `pipeline/overrides.ts` — this file has no opinion on individual turns.
 *
 * Hot-reload: the vault watcher (`infra/vault/watcher.ts`) calls
 * `loadSettingsFromDisk()` when `settings.yml` changes; it mutates the live
 * `settings` object in place so existing imports stay valid.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { configureLogger, log } from "./logger.ts";

import { readText, writeData } from "./runtime.ts";

// ── Module anchor ─────────────────────────────────────────────────────────

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_VAULT_DIR = path.join(MODULE_DIR, "..", "..", "vault");
const CONTAINER_DEFAULTS_DIR = "/app/defaults";
export const bundledVaultDir = existsSync(CONTAINER_DEFAULTS_DIR)
	? CONTAINER_DEFAULTS_DIR
	: REPO_VAULT_DIR;

// ── Env-derived paths (resolved once at startup) ───────────────────────────

const VAULT_ROOT = path.join(process.cwd(), "vault");
const INTERNAL_NAME = "Klaus";
const INTERNAL_PATH = path.join(VAULT_ROOT, INTERNAL_NAME);

const vaultPaths = {
	root: VAULT_ROOT,
	internal: INTERNAL_NAME,
	internalPath: INTERNAL_PATH,
	agentsDir: path.join(INTERNAL_PATH, "agents"),
	skillsDir: path.join(INTERNAL_PATH, "skills"),
	snippetsDir: path.join(INTERNAL_PATH, "snippets"),
	templatesDir: path.join(INTERNAL_PATH, "templates"),
	reportsDir: path.join(INTERNAL_PATH, "reports"),
	loginDir: path.join(INTERNAL_PATH, "_login"),
	loginQrPath: path.join(INTERNAL_PATH, "_login", "qr-code.svg"),
	settingsPath: path.join(INTERNAL_PATH, "settings.yml"),
};

const dataDir = path.join(process.cwd(), "data");

const logFormat = (process.env.LOG_FORMAT === "json" ? "json" : "text") as
	| "text"
	| "json";

const connectionWarnAfterMs = Number(
	process.env.STARTUP_CONNECTION_WARN_AFTER_MS ?? 60_000,
);

// ── Types ──────────────────────────────────────────────────────────────────

export type VaultPermission = "none" | "read" | "append" | "full";
export type ModelTier = "small" | "medium" | "large";

export const modelTiers: [ModelTier, ...ModelTier[]] = [
	"small",
	"medium",
	"large",
];

export interface VaultFolder {
	/** Relative to vault root, e.g. "Notes". Empty string "" for root-level files. */
	path: string;
	/** Always-on permission level. */
	default: VaultPermission;
}

/** Per-agent override entry. */
export type AgentVaultEntry = "none" | "read" | "full";

// ── Zod schema (validates YAML from settings.yml) ──────────────────────────

const VaultPermissionSchema = z.enum(["none", "read", "append", "full"]);

const VaultFolderSchema = z
	.object({
		path: z.string(),
		default: VaultPermissionSchema,
	})
	.strict();

const AgentVaultEntrySchema = z.enum(["none", "read", "full"]);
const ReportSettingSchema = z.preprocess(
	(value) => (value === "agent" ? "short" : value),
	z.enum(["full", "short", "none"]),
);

const RetriesSchema = z
	.object({
		max: z.number(),
		backoffMs: z.number(),
	})
	.strict();

const BasicsSchema = z
	.object({
		locale: z.string(),
		timezone: z.string(),
		allowedChat: z.string().optional(),
	})
	.strict();

const AgentSchema = z
	.object({
		defaultAgent: z.string(),
		maxSteps: z.number(),
		timeout: z.number(),
		retries: RetriesSchema,
		maxChainDepth: z.number(),
		lookbackDays: z.number(),
		/** Cap on reasoning text replayed into history per past step. */
		maxReasoningChars: z.number(),
	})
	.strict();

const AgentDefaultsSchema = z
	.object({
		modelTier: z.enum(modelTiers),
		voice: z.enum(["on", "auto", "off"]),
		temp: z.enum(["cold", "default", "hot"]),
		topP: z.enum(["creative", "default", "rigid"]),
		reasoningEffort: z.enum(["low", "default", "high"]),
		historyLimit: z.number(),
		historyScope: z.enum(["full", "agent"]),
		showTrace: z.boolean(),
		report: ReportSettingSchema,
		/** Per-folder overrides applied on top of folder defaults. "*" is the wildcard fallback. */
		vault: z.record(z.string(), AgentVaultEntrySchema),
	})
	.strict();

const EndpointSchema = z
	.object({
		baseURL: z.string(),
		apiKeyEnv: z.string(),
	})
	.strict();

const ProviderSchema = z
	.object({
		endpoint: z.string(),
		tempScale: z.number(),
		small: z.string(),
		medium: z.string(),
		large: z.string(),
	})
	.strict();

const SamplingSchema = z
	.object({
		temperature: z.number().optional(),
		coldTemperature: z.number().optional(),
		hotTemperature: z.number().optional(),
		topP: z.number().optional(),
		creativeTopP: z.number().optional(),
		rigidTopP: z.number().optional(),
	})
	.strict();

const ImageGenSchema = z
	.object({
		/** Endpoint name from `endpoints`; empty string disables image gen. */
		endpoint: z.string(),
		model: z.string(),
	})
	.strict();

const MediaSchema = z
	.object({
		voice: z
			.object({
				tts: z
					.object({
						model: z.string(),
						voiceId: z.string(),
					})
					.strict(),
				stt: z
					.object({
						model: z.string(),
						timeout: z.number(),
						agentTriggers: z.array(z.string()),
					})
					.strict(),
			})
			.strict(),
		image: z
			.object({
				vision: z
					.object({
						maxSize: z.number(),
					})
					.strict(),
				gen: ImageGenSchema,
			})
			.strict(),
		document: z
			.object({
				ocr: z.boolean(),
				maxChars: z.number(),
			})
			.strict(),
	})
	.strict();

const WhatsAppSchema = z
	.object({
		selfMode: z.boolean(),
		systemLabel: z.string(),
		sendDelay: z.number(),
		retries: RetriesSchema,
		maxDownload: z.number(),
		mediaDownloadTimeout: z.number(),
		offlineWindow: z.number(),
		maxSeenSize: z.number(),
	})
	.strict();

const VaultYamlSchema = z
	.object({
		watcherDebounce: z.number(),
		maxList: z.number(),
		folders: z.array(VaultFolderSchema),
		internalPermission: z
			.object({
				default: VaultPermissionSchema,
			})
			.strict(),
	})
	.strict();

const PersistenceSchema = z
	.object({
		minNextRun: z.number(),
		maxNextRun: z.number(),
		defaultNextRun: z.string(),
	})
	.strict();

const ReportsSchema = z
	.object({
		/** Mirror each turn's report as rendered markdown into `{vault}/reports/`. */
		vaultMarkdown: z.boolean(),
		/** Days of report history surfaced via `/reports` and read APIs. */
		lookbackDays: z.number(),
	})
	.strict();

const SyncSchema = z
	.object({
		/** SIGTERM grace period before SIGKILL is sent to the `ob` child. */
		shutdownTimeoutMs: z.number(),
		/** Obsidian Sync file type buckets. `unsupported` is required for .yml config files. */
		fileTypes: z.array(
			z.enum(["image", "audio", "video", "pdf", "unsupported"]),
		),
		restartBackoff: z
			.object({
				initialMs: z.number(),
				maxMs: z.number(),
				resetAfterUpMs: z.number(),
			})
			.strict(),
		/** Initial-sync gate: block startup until the vault is hydrated. */
		firstSync: z
			.object({
				quietMs: z.number(),
				timeoutMs: z.number(),
			})
			.strict(),
	})
	.strict();

const SettingsSchema = z
	.object({
		basics: BasicsSchema,
		agent: AgentSchema,
		agentDefaults: AgentDefaultsSchema,
		defaultProvider: z.string(),
		endpoints: z.record(z.string(), EndpointSchema),
		providers: z.record(z.string(), ProviderSchema),
		sampling: SamplingSchema,
		media: MediaSchema,
		whatsapp: WhatsAppSchema,
		vault: VaultYamlSchema,
		persistence: PersistenceSchema,
		reports: ReportsSchema,
		sync: SyncSchema,
	})
	.strict();

type YamlSettings = z.output<typeof SettingsSchema>;

// ── Bundled defaults ───────────────────────────────────────────────────────

const BUNDLED_SETTINGS_PATH = path.join(bundledVaultDir, "settings.yml");

function loadBundledDefaults(): YamlSettings {
	let raw: string;
	try {
		raw = readFileSync(BUNDLED_SETTINGS_PATH, "utf8");
	} catch (err) {
		throw new Error(
			`Bundled default settings file missing or unreadable at ${BUNDLED_SETTINGS_PATH}. ` +
				`This is a deployment bug — the repo's vault/settings.yml must ship with the binary. ` +
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

// ── Live settings object ───────────────────────────────────────────────────

/**
 * The public config surface. Mutated in place by `loadSettingsFromDisk` so
 * existing imports stay valid after hot-reload. Consumers read fields
 * directly — no getter facade — so the structure is obvious.
 *
 * `vault` merges YAML fields (`folders`, `maxList`, …) with env-derived
 * paths (`root`, `agentsDir`, …) into one surface. Env fields never change.
 *
 * `allowedChat` stays a getter because it falls back to `process.env` at read
 * time — tests and the setup flow rely on that.
 */
function buildSettings(yaml: YamlSettings) {
	return {
		...yaml,
		vault: { ...yaml.vault, ...vaultPaths },
		dataDir,
		log: { format: logFormat },
		startup: { connectionWarnAfterMs },
		get allowedChat(): string | undefined {
			return yaml.basics.allowedChat ?? process.env.ALLOWED_CHAT_ID ?? undefined;
		},
		get locale() {
			return yaml.basics.locale;
		},
		get timezone() {
			return yaml.basics.timezone;
		},
		get defaultAgent() {
			return yaml.agent.defaultAgent;
		},
	};
}

export const settings = buildSettings(loadBundledDefaults());
configureLogger(settings.log.format);

function applyYaml(next: YamlSettings): void {
	const rebuilt = buildSettings(next);
	Object.defineProperties(settings, Object.getOwnPropertyDescriptors(rebuilt));
	configureLogger(settings.log.format);
}

// ── Disk load / hot reload ─────────────────────────────────────────────────

export async function loadSettingsFromDisk(): Promise<
	{ ok: true } | { ok: false; error: string }
> {
	const filePath = vaultPaths.settingsPath;

	if (!existsSync(filePath)) {
		log.info("[config] no settings.yml in vault, using bundled defaults");
		return { ok: true };
	}

	try {
		const raw = await readText(filePath);
		const parsed = parseYaml(raw);
		const result = SettingsSchema.safeParse(parsed ?? {});

		if (!result.success) {
			const issues = result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			return { ok: false, error: issues };
		}

		applyYaml(result.data);
		log.info("[config] loaded from disk");
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function updateAllowedChat(chatId: string): Promise<void> {
	const filePath = vaultPaths.settingsPath;
	let parsed: Record<string, unknown> = {};

	if (existsSync(filePath)) {
		const raw = await readText(filePath);
		parsed = (parseYaml(raw) as Record<string, unknown>) ?? {};
	}

	const basics = (parsed.basics as Record<string, unknown>) ?? {};
	basics.allowedChat = chatId;
	parsed.basics = basics;

	const yaml = stringifyYaml(parsed, { lineWidth: 120 });
	await writeData(filePath, yaml);

	const result = await loadSettingsFromDisk();
	if (!result.ok) {
		throw new Error(`Updated settings.yml failed validation: ${result.error}`);
	}
	log.info("[config] updated allowedChat");
}

export async function updateSelfMode(selfMode: boolean): Promise<void> {
	const filePath = vaultPaths.settingsPath;
	let parsed: Record<string, unknown> = {};

	if (existsSync(filePath)) {
		const raw = await readText(filePath);
		parsed = (parseYaml(raw) as Record<string, unknown>) ?? {};
	}

	const whatsapp = (parsed.whatsapp as Record<string, unknown>) ?? {};
	whatsapp.selfMode = selfMode;
	parsed.whatsapp = whatsapp;

	const yaml = stringifyYaml(parsed, { lineWidth: 120 });
	await writeData(filePath, yaml);

	const result = await loadSettingsFromDisk();
	if (!result.ok) {
		throw new Error(`Updated settings.yml failed validation: ${result.error}`);
	}
	log.info("[config] updated selfMode", { selfMode });
}

// ── Provider / model resolution ────────────────────────────────────────────

interface ResolvedModel {
	baseURL: string;
	apiKey: string;
	modelId: string;
	/** Native temperature scale of the provider — multiply 0-1 sampling values before send. */
	tempScale: number;
}

/**
 * Look up a `(provider, tier)` pair into the concrete bundle needed to issue a
 * chat completions request. Throws when the provider/endpoint is unknown or
 * the API key env var is unset — fail-closed beats discovering it mid-turn.
 */
export function resolveModel(provider: string, tier: ModelTier): ResolvedModel {
	const p = settings.providers[provider];
	if (!p) {
		throw new Error(
			`Unknown provider "${provider}" — known: ${Object.keys(settings.providers).join(", ")}`,
		);
	}
	const ep = settings.endpoints[p.endpoint];
	if (!ep) {
		throw new Error(
			`Provider "${provider}" references unknown endpoint "${p.endpoint}"`,
		);
	}
	const apiKey = process.env[ep.apiKeyEnv];
	if (!apiKey) {
		throw new Error(
			`API key missing: env var ${ep.apiKeyEnv} is unset (endpoint "${p.endpoint}")`,
		);
	}
	return {
		baseURL: ep.baseURL,
		apiKey,
		modelId: p[tier],
		tempScale: p.tempScale,
	};
}

export function requiredStartupApiKeyEnvVars(): string[] {
	const provider = settings.providers[settings.defaultProvider];
	if (!provider) {
		throw new Error(
			`Unknown defaultProvider "${settings.defaultProvider}" — known: ${Object.keys(settings.providers).join(", ")}`,
		);
	}
	const endpoint = settings.endpoints[provider.endpoint];
	if (!endpoint) {
		throw new Error(
			`Default provider "${settings.defaultProvider}" references unknown endpoint "${provider.endpoint}"`,
		);
	}
	return [endpoint.apiKeyEnv];
}

/**
 * Resolve the configured image-gen model. Empty `endpoint` disables the
 * feature — callers get a clear error instead of a silent miscall.
 */
export function resolveImageModel(): {
	baseURL: string;
	apiKey: string;
	modelId: string;
} {
	const gen = settings.media.image.gen;
	if (!gen.endpoint || !gen.model) {
		throw new Error(
			"Image generation not configured. Set media.image.gen.endpoint and .model in settings.yml.",
		);
	}
	const ep = settings.endpoints[gen.endpoint];
	if (!ep) {
		throw new Error(
			`media.image.gen references unknown endpoint "${gen.endpoint}"`,
		);
	}
	const apiKey = process.env[ep.apiKeyEnv];
	if (!apiKey) {
		throw new Error(
			`API key missing: env var ${ep.apiKeyEnv} is unset (endpoint "${gen.endpoint}")`,
		);
	}
	return { baseURL: ep.baseURL, apiKey, modelId: gen.model };
}
