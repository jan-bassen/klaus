/**
 * Returns the current local date as YYYY-MM-DD in the given timezone.
 * Uses Intl.DateTimeFormat to correctly handle DST transitions.
 */
export function localDateString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date());
}
