/** Current local date as YYYY-MM-DD in the given timezone (DST-aware). */
export function localDateString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return fmt.format(new Date());
}

/** Current local time as HH-MM-SS in the given timezone. */
export function localTimeString(timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return fmt.format(new Date()).replaceAll(":", "-");
}
