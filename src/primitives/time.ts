import { settings } from "../infra/config.ts";

const TIMER_TIME_FORMAT: Intl.DateTimeFormatOptions = {
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	timeZoneName: "short",
};

export function formatTimerRunAt(runAt: string): string {
	return new Intl.DateTimeFormat(settings.locale, {
		...TIMER_TIME_FORMAT,
		timeZone: settings.timezone,
	}).format(new Date(runAt));
}
