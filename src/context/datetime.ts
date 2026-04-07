import { settings } from "@/settings";
import type { ContextVariable } from "@/types";

const CHARS_PER_TOKEN = settings.context.charsPerToken;

export const dateQuery: ContextVariable = {
	name: "date",
	priority: -1,
	run: async (_turn, _params) => {
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
	run: async (_turn, _params) => {
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
	run: async (_turn, _params) => {
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
