import { settings } from "@/settings";
import type { ContextVariable } from "@/types";

// Rough token estimate: 1 token ≈ 4 characters (good enough for short strings).
const CHARS_PER_TOKEN = 4;

export const dateQuery: ContextVariable = {
	name: "date",
	priority: -1,
	run: async () => {
		const content = new Date().toLocaleDateString(settings.locale, {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: settings.timezone,
		});
		return {
			content,
			tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
			truncate: "never",
		};
	},
};

export const timeQuery: ContextVariable = {
	name: "time",
	priority: -1,
	run: async () => {
		const content = new Date().toLocaleTimeString(settings.locale, {
			hour: "2-digit",
			minute: "2-digit",
			timeZoneName: "short",
			timeZone: settings.timezone,
		});
		return {
			content,
			tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
			truncate: "never",
		};
	},
};

export const weekdayQuery: ContextVariable = {
	name: "weekday",
	priority: -1,
	run: async () => {
		const content = new Date().toLocaleDateString(settings.locale, {
			weekday: "long",
			timeZone: settings.timezone,
		});
		return {
			content,
			tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
			truncate: "never",
		};
	},
};
