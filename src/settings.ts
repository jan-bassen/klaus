import { config } from "./config";
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

/** Resolve provider config by name. Falls back to global active provider. */
export function resolveProvider(override?: string): ProviderConfig {
	const name = override ?? getYamlSettings().providers.active;
	const providers = getYamlSettings().providers;
	const cfg = (providers as Record<string, unknown>)[name] as
		| ProviderConfig
		| undefined;
	if (!cfg || typeof cfg !== "object" || !("sdk" in cfg)) {
		throw new Error(`Unknown provider: ${name}`);
	}
	return cfg;
}

/** Resolve model ID for a tier (uses given provider or global active). */
export function resolveModelId(
	tier: ModelTier,
	providerOverride?: string,
): string {
	return resolveProvider(providerOverride)[tier];
}

/** Returns all provider names configured in settings (excluding "active"). */
export function getProviderNames(): string[] {
	const { active, ...rest } = getYamlSettings().providers;
	return Object.keys(rest);
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
	get allowedChatId(): string | undefined {
		return (
			getYamlSettings().allowedChatId ??
			process.env.ALLOWED_CHAT_ID ??
			undefined
		);
	},
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
	get trail() {
		return getYamlSettings().trail;
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
		get loginDir() {
			return config.vault.loginDir;
		},
		get loginQrPath() {
			return config.vault.loginQrPath;
		},
	},
	get dataDir() {
		return config.dataDir;
	},
	log: config.log,
	startup: config.startup,
};
