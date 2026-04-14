import type { LanguageModel } from "ai";

type Factory = (modelId: string) => LanguageModel;

const cache = new Map<string, Factory>();

/**
 * Create a Vercel AI SDK model instance for the given SDK name and model ID.
 * SDK packages are lazy-loaded on first use and cached.
 *
 * Resolves any `@ai-sdk/<sdk>` package dynamically — forkers can add providers
 * by installing the package and adding an entry to settings.yml.
 */
export function createModel(sdk: string, modelId: string): LanguageModel {
	let factory = cache.get(sdk);
	if (!factory) {
		try {
			const m = require(`@ai-sdk/${sdk}`);
			factory = m[sdk] ?? m.default;
			if (typeof factory !== "function") {
				throw new Error(
					`@ai-sdk/${sdk} does not export a model factory as "${sdk}" or "default"`,
				);
			}
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
			) {
				throw new Error(
					`AI SDK package @ai-sdk/${sdk} not found. Install it: bun add @ai-sdk/${sdk}`,
				);
			}
			throw err;
		}
		cache.set(sdk, factory);
	}
	return factory(modelId);
}

/** For tests — clear the cached factories. */
export function _resetFactoryCacheForTest(): void {
	cache.clear();
}
