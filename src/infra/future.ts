import { settings } from "./config.ts";
import { log } from "./logger.ts";
import { startAllSchedules } from "./store/schedules.ts";
import { startAllTimers } from "./store/timers.ts";
import { isConnected } from "./whatsapp/connection.ts";

let active = false;
let waitReason: "allowedChat" | "connection" | null = null;

export function activateFutureWorkIfReady(): boolean {
	if (active) return true;
	if (!settings.allowedChat) {
		if (waitReason !== "allowedChat") {
			log.info(
				"[future] waiting for allowedChat before starting schedules/timers",
			);
			waitReason = "allowedChat";
		}
		return false;
	}
	if (!isConnected()) {
		if (waitReason !== "connection") {
			log.info(
				"[future] waiting for WhatsApp connection before starting schedules/timers",
			);
			waitReason = "connection";
		}
		return false;
	}

	startAllSchedules();
	startAllTimers();
	active = true;
	waitReason = null;
	log.info("[future] schedules and timers started");
	return true;
}

export function deactivateFutureWork(): void {
	active = false;
}
