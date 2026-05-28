/**
 * Server tools — model-callable tools executed by OpenRouter, not Klaus.
 * Agents declare them in frontmatter as `serverTools: [web_search, web_fetch]`;
 * the loop appends them to the outgoing `tools` array verbatim.
 *
 * The hidden server-side call transcript does not come back as local
 * `tool_call` entries. When OpenRouter surfaces usage counts or citation
 * annotations, reports capture those from the model response.
 */

import type { ChatFunctionTool as ChatTool } from "@openrouter/sdk/models";
import { log } from "../../infra/logger.ts";

const SERVER_TOOLS: Record<string, ChatTool> = {
	web_search: { type: "openrouter:web_search" },
	web_fetch: { type: "openrouter:web_fetch" },
};

export function getServerTool(name: string): ChatTool | undefined {
	const tool = SERVER_TOOLS[name];
	if (!tool) {
		log.warn(`[tools] unknown server tool "${name}"`);
		return undefined;
	}
	return tool;
}
