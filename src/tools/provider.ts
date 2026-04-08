import type { Tool } from "ai";
import { log } from "@/logger";

/**
 * Build a provider tool by canonical name, resolved to the correct SDK implementation.
 * All tools use canonical names in agent frontmatter (e.g. `web_search`, `code_execution`).
 * The SDK parameter determines which provider's implementation to use.
 *
 * Returns undefined if the provider does not support the requested tool.
 */
export function buildProviderTool(name: string, sdk: string): Tool | undefined {
	switch (sdk) {
		case "anthropic":
			return buildAnthropicTool(name);
		case "openai":
			return buildOpenAITool(name);
		case "google":
			return buildGoogleTool(name);
		default: {
			log.warn("[provider-tool] unknown SDK, skipping tool", {
				sdk,
				tool: name,
			});
			return undefined;
		}
	}
}

function buildAnthropicTool(name: string): Tool | undefined {
	const { anthropic } = require("@ai-sdk/anthropic");
	switch (name) {
		case "web_search":
			return anthropic.tools.webSearch_20250305() as unknown as Tool;
		case "code_execution":
			return anthropic.tools.codeExecution_20260120() as unknown as Tool;
		default:
			return undefined;
	}
}

function buildOpenAITool(name: string): Tool | undefined {
	const { openai } = require("@ai-sdk/openai");
	switch (name) {
		case "web_search":
			return openai.tools.webSearchPreview() as unknown as Tool;
		case "code_execution":
			return openai.tools.codeInterpreter() as unknown as Tool;
		default:
			return undefined;
	}
}

function buildGoogleTool(name: string): Tool | undefined {
	const { google } = require("@ai-sdk/google");
	switch (name) {
		case "web_search":
			return google.tools.googleSearch() as unknown as Tool;
		case "code_execution":
			return google.tools.codeExecution() as unknown as Tool;
		default:
			return undefined;
	}
}
