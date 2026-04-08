import { config } from "./config";
import { getActiveProvider } from "./core/provider-defaults";
import { getYamlSettings } from "./core/settings-loader";

export type VaultPermission = "none" | "read" | "append" | "full";

export interface VaultFolder {
	/** Relative to vault root, e.g. "Leben". Empty string "" for root-level files. */
	path: string;
	/** Always-on permission level. */
	default: VaultPermission;
	/** Elevated permission available via WhatsApp reaction confirmation. */
	request?: VaultPermission | undefined;
}

export type ModelTier = "small" | "medium" | "large" | "vision";

/** Model tier names suitable for z.enum(). */
export const modelTiers: [ModelTier, ...ModelTier[]] = [
	"small",
	"medium",
	"large",
	"vision",
];

/** Resolve the active provider config for a chat (respects per-chat override). */
export function resolveProvider(
	chatId?: string,
	override?: string,
): ProviderConfig {
	const name = override ?? getActiveProvider(chatId);
	const providers = getYamlSettings().providers;
	const cfg = (providers as Record<string, unknown>)[name] as
		| ProviderConfig
		| undefined;
	if (!cfg || typeof cfg !== "object" || !("sdk" in cfg)) {
		throw new Error(`Unknown provider: ${name}`);
	}
	return cfg;
}

/** Resolve model ID for a tier + chat (uses active provider). */
export function resolveModelId(
	tier: ModelTier,
	chatId?: string,
	providerOverride?: string,
): string {
	return resolveProvider(chatId, providerOverride)[tier];
}

export interface ProviderConfig {
	sdk: string;
	small: string;
	medium: string;
	large: string;
	vision: string;
	temperature?: number;
	coldTemperature?: number;
	hotTemperature?: number;
	topP?: number;
	creativeTopP?: number;
	rigidTopP?: number;
}

export const settings = {
	get providers() {
		return getYamlSettings().providers;
	},
	get context() {
		return getYamlSettings().context;
	},
	get rateLimits() {
		return getYamlSettings().rateLimits;
	},
	get tts() {
		return getYamlSettings().tts;
	},
	get stt() {
		return getYamlSettings().stt;
	},
	get retries() {
		return getYamlSettings().retries;
	},
	get send() {
		return getYamlSettings().send;
	},
	get llm() {
		return getYamlSettings().llm;
	},
	get defaultAgent() {
		return getYamlSettings().defaultAgent;
	},
	get locale() {
		return getYamlSettings().locale;
	},
	get timezone() {
		return getYamlSettings().timezone;
	},
	get dispatch() {
		return getYamlSettings().dispatch;
	},
	get persistent() {
		return getYamlSettings().persistent;
	},
	get watcher() {
		return getYamlSettings().watcher;
	},
	get vision() {
		return getYamlSettings().vision;
	},
	get whatsapp() {
		return getYamlSettings().whatsapp;
	},
	vault: {
		get root() {
			return config.vault.root;
		},
		get internal() {
			return config.vault.internal;
		},
		get folders() {
			return getYamlSettings().vault.folders;
		},
		get internalPermission() {
			return getYamlSettings().vault.internalPermission;
		},
		get maxListEntries() {
			return getYamlSettings().vault.maxListEntries;
		},
		get internalPath() {
			return config.vault.internalPath;
		},
		get agentsDir() {
			return config.vault.agentsDir;
		},
		get skillsDir() {
			return config.vault.skillsDir;
		},
		get snippetsDir() {
			return config.vault.snippetsDir;
		},
	},
	get dataDir() {
		return config.dataDir;
	},
	log: config.log,
	startup: config.startup,
};
