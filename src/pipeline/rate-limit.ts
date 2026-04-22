import { settings } from "@/config";
import { getServices, type RateLimiter } from "@/services";
import type { InboundMessage } from "@/types";

export interface RateLimitResult {
	allowed: boolean;
	retryAfterMs?: number;
}

type LimitKind = "messages" | "modelCalls";

export function createRateLimiter(): RateLimiter {
	const windows: Record<LimitKind, number[]> = {
		messages: [],
		modelCalls: [],
	};

	function check(kind: LimitKind, now = Date.now()): RateLimitResult {
		const { max, windowMs } = settings.rateLimits[kind];
		const cutoff = now - windowMs;
		const timestamps = windows[kind];

		while (timestamps.length > 0 && (timestamps[0] ?? Infinity) < cutoff) {
			timestamps.shift();
		}

		if (timestamps.length >= max) {
			const retryAfterMs = (timestamps[0] ?? 0) - cutoff;
			return { allowed: false, retryAfterMs };
		}

		timestamps.push(now);
		return { allowed: true };
	}

	return {
		checkMessage: (_msg: InboundMessage) => check("messages"),
		checkModel: () => check("modelCalls"),
	};
}

export function checkMessageRate(msg: InboundMessage): RateLimitResult {
	return getServices().rateLimiter.checkMessage(msg);
}

export function checkModelRate(): RateLimitResult {
	return getServices().rateLimiter.checkModel();
}
