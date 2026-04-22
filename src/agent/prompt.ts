import { resolveProvider } from "@/config";
import { log } from "@/logger";
import { hbs } from "@/markdown";
import type { TurnConfig } from "@/pipeline/overrides";

/** Compile an agent prompt body with the unified variable namespace. */
export function buildSystemPrompt(
	body: string,
	vars: Record<string, unknown>,
): string {
	const template = hbs.compile(body, { noEscape: true });
	return template(vars)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface ResolvedSampling {
	temperature?: number;
	topP?: number;
	providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Translate `TurnConfig` sampling/reasoning overrides into concrete parameters
 * for `callModel`. Temperature and topP resolve against the active provider's
 * preset numbers; reasoningEffort and fast mode map to provider-specific
 * `providerOptions` keys.
 */
export function resolveSampling(
	config: TurnConfig,
	providerName?: string,
): ResolvedSampling {
	const providerCfg = resolveProvider(providerName);
	const out: ResolvedSampling = {};

	const tempPreset = config.temperaturePreset;
	if (tempPreset === "cold") {
		out.temperature = providerCfg.coldTemperature ?? 0;
	} else if (tempPreset === "hot") {
		out.temperature = providerCfg.hotTemperature ?? 1;
	} else if (providerCfg.temperature !== undefined) {
		out.temperature = providerCfg.temperature;
	}

	const topPPreset = config.topPPreset;
	if (topPPreset === "creative") {
		out.topP = providerCfg.creativeTopP ?? 0.95;
	} else if (topPPreset === "rigid") {
		out.topP = providerCfg.rigidTopP ?? 0.1;
	} else if (providerCfg.topP !== undefined) {
		out.topP = providerCfg.topP;
	}

	const sdkName = providerCfg.sdk;

	if (config.reasoningEffort) {
		out.providerOptions ??= {};
		switch (sdkName) {
			case "anthropic":
				out.providerOptions.anthropic = {
					...out.providerOptions.anthropic,
					effort: config.reasoningEffort,
				};
				break;
			case "openai":
				out.providerOptions.openai = {
					...out.providerOptions.openai,
					reasoningEffort: config.reasoningEffort,
				};
				break;
			case "google":
				out.providerOptions.google = {
					...out.providerOptions.google,
					thinkingConfig: { thinkingLevel: config.reasoningEffort },
				};
				break;
			default:
				log.warn(`[agent] reasoning effort not supported for ${sdkName}`);
		}
	}

	if (config.fast) {
		out.providerOptions ??= {};
		switch (sdkName) {
			case "anthropic":
				out.providerOptions.anthropic = {
					...out.providerOptions.anthropic,
					speed: "fast",
				};
				break;
			default:
				log.warn(`[agent] fast mode not supported for ${sdkName}`);
		}
	}

	return out;
}
