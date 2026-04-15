import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { Tool } from "ai";
import { log } from "@/logger";

const providerToolMap: Record<string, Record<string, Tool>> = {
	anthropic: {
		web_search: anthropic.tools.webSearch_20260209(),
		code_execution: anthropic.tools.codeExecution_20260120(),
	},
	openai: {
		web_search: openai.tools.webSearch(),
		code_execution: openai.tools.codeInterpreter(),
	},
	google: {
		web_search: google.tools.googleSearch({}),
		code_execution: google.tools.codeExecution({}),
	},
};

export function getProviderTool(
	name: string,
	provider: string,
): Tool | undefined {
	if (!providerToolMap[provider]) {
		log.warn(
			`[tools] unknown Provider "${provider}" for provider tool "${name}"`,
		);
		return undefined;
	}

	if (!providerToolMap[provider][name]) {
		log.warn(
			`[tools] unknown Provider tool "${name}" for provider "${provider}"`,
		);
		return undefined;
	}

	return providerToolMap[provider][name];
}
