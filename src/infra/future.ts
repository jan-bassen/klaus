import { settings } from "./config.ts";
import { log } from "./logger.ts";
import { startAllSchedules } from "./store/schedules.ts";
import { startAllTimers } from "./store/timers.ts";
import { isConnected } from "./whatsapp/connection.ts";

let active = false;

export function activateFutureWorkIfReady(): boolean {
	if (active) return true;
	if (!settings.allowedChat) {
		log.info("[future] waiting for allowedChat before starting schedules/timers");
		return false;
	}
	if (!isConnected()) {
		log.info("[future] waiting for WhatsApp connection before starting schedules/timers");
		return false;
	}

	startAllSchedules();
	startAllTimers();
	active = true;
	log.info("[future] schedules and timers started");
	return true;
}

export function deactivateFutureWork(): void {
	active = false;
}
