import type { Variable } from "@/variables";

interface LinkItem {
	url: string;
	title: string;
	text: string;
}

export interface LinksNamespace {
	count: number;
	items: LinkItem[];
}

/** Web links extracted and fetched from the current message, if any. */
export const linksVariable: Variable = {
	key: "links",
	description: "Web links extracted from the current message",
	async run(turn) {
		const links = turn.message?.links ?? [];
		return {
			count: links.length,
			items: links,
		} satisfies LinksNamespace;
	},
};
