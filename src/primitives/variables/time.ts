import { settings } from "@/infra/config";
import type { Variable } from "@/primitives/variables";

/** Current date, time, and weekday. */
export const timeVariable: Variable = {
	key: "time",
	description: "Date, time, and weekday",
	async run() {
		const now = new Date();
		const date = now.toLocaleDateString(settings.locale, {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: settings.timezone,
		});
		const time = now.toLocaleTimeString(settings.locale, {
			hour: "2-digit",
			minute: "2-digit",
			timeZoneName: "short",
			timeZone: settings.timezone,
		});
		const weekday = now.toLocaleDateString(settings.locale, {
			weekday: "long",
			timeZone: settings.timezone,
		});
		return { date, time, weekday };
	},
};
