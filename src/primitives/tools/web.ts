import { z } from "zod";
import { fetchWebContent } from "@/pipeline/media";
import type { ToolDefinition } from "@/primitives/tools";

const webFetchSchema = z.object({
	url: z.string().url().describe("The URL to fetch and parse"),
});

export const webFetchTool: ToolDefinition<typeof webFetchSchema> = {
	name: "fetch_url",
	description:
		"Fetch a web page and extract its readable text content. Use when you need to read a URL that was not auto-fetched or when the user asks you to look something up.",
	inputSchema: webFetchSchema,
	execute: async ({ url }, _context) => {
		const result = await fetchWebContent(url);
		if (result instanceof Error) return { error: result.message };
		return { title: result.title, url, text: result.text };
	},
	sideEffect: "pure",
	kind: "builtin",
	capability: "resource",
};
