import type { LanguageModel } from "ai";

type Factory = (modelId: string) => LanguageModel;

const cache = new Map<string, Factory>();

/**
 * Create a Vercel AI SDK model instance for the given SDK name and model ID.
 * SDK packages are lazy-loaded on first use and cached.
 */
export function createModel(sdk: string, modelId: string): LanguageModel {
	let factory = cache.get(sdk);
	if (!factory) {
		switch (sdk) {
			case "anthropic": {
				const m = require("@ai-sdk/anthropic");
				factory = m.anthropic;
				break;
			}
			case "openai": {
				const m = require("@ai-sdk/openai");
				factory = m.openai;
				break;
			}
			case "google": {
				const m = require("@ai-sdk/google");
				factory = m.google;
				break;
			}
			default:
				throw new Error(`Unknown AI SDK: ${sdk}`);
		}
		cache.set(sdk, factory!);
	}
	return factory!(modelId);
}

/** For tests — clear the cached factories. */
export function _resetFactoryCacheForTest(): void {
	cache.clear();
}
