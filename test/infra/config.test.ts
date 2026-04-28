/**
 * `infra/config.resolveModel` and `resolveImageModel` — provider/endpoint
 * lookup, env-var resolution, fail-closed error paths.
 *
 * Mutates `settings.providers` / `settings.endpoints` / `settings.media.image.gen`
 * directly (the live object is mutable by design — see `applyYaml`). Each test
 * restores the original references in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	requiredStartupApiKeyEnvVars,
	resolveImageModel,
	resolveModel,
	settings,
} from "@/infra/config";

describe("infra/config.resolveModel", () => {
	const origProviders = settings.providers;
	const origEndpoints = settings.endpoints;
	const origEnv = process.env;

	beforeEach(() => {
		settings.endpoints = {
			or: { baseURL: "https://x.example/v1", apiKeyEnv: "TEST_OR_KEY" },
		};
		settings.providers = {
			claude: {
				endpoint: "or",
				tempScale: 1,
				small: "anthropic/h",
				medium: "anthropic/s",
				large: "anthropic/o",
			},
			openai: {
				endpoint: "or",
				tempScale: 2,
				small: "openai/m",
				medium: "openai/g",
				large: "openai/p",
			},
			ghost: {
				endpoint: "missing-endpoint",
				tempScale: 1,
				small: "x",
				medium: "x",
				large: "x",
			},
		};
		process.env = { ...origEnv, TEST_OR_KEY: "k-secret" };
	});

	afterEach(() => {
		settings.providers = origProviders;
		settings.endpoints = origEndpoints;
		process.env = origEnv;
	});

	it("resolves provider+tier into baseURL, modelId, apiKey, tempScale", () => {
		const r = resolveModel("openai", "large");
		expect(r).toEqual({
			baseURL: "https://x.example/v1",
			apiKey: "k-secret",
			modelId: "openai/p",
			tempScale: 2,
		});
	});

	it("each tier in a provider returns its distinct modelId", () => {
		expect(resolveModel("claude", "small").modelId).toBe("anthropic/h");
		expect(resolveModel("claude", "medium").modelId).toBe("anthropic/s");
		expect(resolveModel("claude", "large").modelId).toBe("anthropic/o");
	});

	it("throws on unknown provider", () => {
		expect(() => resolveModel("nonsense", "small")).toThrow(/Unknown provider/);
	});

	it("throws when provider references an unknown endpoint", () => {
		expect(() => resolveModel("ghost", "small")).toThrow(/unknown endpoint/);
	});

	it("throws when the endpoint's apiKeyEnv is unset", () => {
		delete process.env.TEST_OR_KEY;
		expect(() => resolveModel("claude", "medium")).toThrow(/API key missing/);
	});
});

describe("infra/config.resolveImageModel", () => {
	const origEndpoints = settings.endpoints;
	const origGen = settings.media.image.gen;
	const origEnv = process.env;

	beforeEach(() => {
		settings.endpoints = {
			or: { baseURL: "https://x.example/v1", apiKeyEnv: "TEST_OR_KEY" },
		};
		settings.media.image.gen = { endpoint: "or", model: "vendor/img-1" };
		process.env = { ...origEnv, TEST_OR_KEY: "k-secret" };
	});

	afterEach(() => {
		settings.endpoints = origEndpoints;
		settings.media.image.gen = origGen;
		process.env = origEnv;
	});

	it("resolves to baseURL, modelId, apiKey", () => {
		expect(resolveImageModel()).toEqual({
			baseURL: "https://x.example/v1",
			apiKey: "k-secret",
			modelId: "vendor/img-1",
		});
	});

	it("throws when endpoint is empty (image gen disabled)", () => {
		settings.media.image.gen = { endpoint: "", model: "vendor/img-1" };
		expect(() => resolveImageModel()).toThrow(/not configured/);
	});

	it("throws when model is empty", () => {
		settings.media.image.gen = { endpoint: "or", model: "" };
		expect(() => resolveImageModel()).toThrow(/not configured/);
	});

	it("throws when endpoint name is unknown", () => {
		settings.media.image.gen = { endpoint: "ghost", model: "vendor/img-1" };
		expect(() => resolveImageModel()).toThrow(/unknown endpoint/);
	});

	it("throws when apiKeyEnv is unset", () => {
		delete process.env.TEST_OR_KEY;
		expect(() => resolveImageModel()).toThrow(/API key missing/);
	});
});

describe("infra/config.requiredStartupApiKeyEnvVars", () => {
	const origProviders = settings.providers;
	const origEndpoints = settings.endpoints;
	const origDefaultProvider = settings.defaultProvider;

	beforeEach(() => {
		settings.endpoints = {
			or: { baseURL: "https://x.example/v1", apiKeyEnv: "TEST_OR_KEY" },
			direct: {
				baseURL: "https://direct.example/v1",
				apiKeyEnv: "TEST_DIRECT_KEY",
			},
		};
		settings.providers = {
			claude: {
				endpoint: "or",
				tempScale: 1,
				small: "anthropic/h",
				medium: "anthropic/s",
				large: "anthropic/o",
			},
			openai: {
				endpoint: "direct",
				tempScale: 2,
				small: "openai/m",
				medium: "openai/g",
				large: "openai/p",
			},
			ghost: {
				endpoint: "missing-endpoint",
				tempScale: 1,
				small: "x",
				medium: "x",
				large: "x",
			},
		};
		settings.defaultProvider = "claude";
	});

	afterEach(() => {
		settings.providers = origProviders;
		settings.endpoints = origEndpoints;
		settings.defaultProvider = origDefaultProvider;
	});

	it("returns the apiKeyEnv for the configured default provider endpoint", () => {
		expect(requiredStartupApiKeyEnvVars()).toEqual(["TEST_OR_KEY"]);
		settings.defaultProvider = "openai";
		expect(requiredStartupApiKeyEnvVars()).toEqual(["TEST_DIRECT_KEY"]);
	});

	it("throws when defaultProvider is unknown", () => {
		settings.defaultProvider = "nonsense";
		expect(() => requiredStartupApiKeyEnvVars()).toThrow(
			/Unknown defaultProvider/,
		);
	});

	it("throws when the default provider references an unknown endpoint", () => {
		settings.defaultProvider = "ghost";
		expect(() => requiredStartupApiKeyEnvVars()).toThrow(/unknown endpoint/);
	});
});
