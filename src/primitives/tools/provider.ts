/**
 * Provider tools — server-side tools executed by OpenRouter (no Klaus
 * `execute` handler). Agents declare them in frontmatter as
 * `providerTools: [web_search, web_fetch]`; the loop appends them to the
 * outgoing `tools` array verbatim.
 *
 * The OpenAI-compatible response only surfaces *function* tool calls — server
 * tools execute transparently and their results are folded into the next
 * assistant turn by the router. Klaus never sees a tool_call entry for them.
 */

import type { ChatFunctionTool as ChatTool } from "@openrouter/sdk/models";
import { log } from "../../infra/logger.ts";

const SERVER_TOOLS: Record<string, ChatTool> = {
	web_search: { type: "openrouter:web_search" },
	web_fetch: { type: "openrouter:web_fetch" },
};

export function getProviderTool(name: string): ChatTool | undefined {
	const tool = SERVER_TOOLS[name];
	if (!tool) {
		log.warn(`[tools] unknown server tool "${name}"`);
		return undefined;
	}
	return tool;
}

/** Names of all known provider/server tools. */
export function listProviderToolNames(): string[] {
	return Object.keys(SERVER_TOOLS);
}
