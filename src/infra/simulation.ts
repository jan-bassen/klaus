/**
 * Per-turn simulation overlay.
 *
 * `!simulate` flips `turn.config.simulate = true`. When that's on, the tool
 * wrapper in `pipeline/context.ts` consults this module to route each
 * invocation. A tool's own `simulate` handler always wins; otherwise
 * `external`/`stateful` tools fall through to generic fakers and `pure` tools
 * pass through to real reads.
 *
 * The overlay also gives read-from-write coherence within a turn: write-style
 * `simulate` handlers stash their intent here, and read-style handlers
 * consult it before hitting disk. That way an agent that creates a note and
 * immediately reads it back sees its own simulated write.
 */

import type { FileMeta } from "@/infra/store/files";
import type { ScheduleEntry } from "@/infra/store/schedules";
import type { TimerEntry } from "@/infra/store/timers";
import type { TurnContext } from "@/pipeline/agent";
import type { SideEffect } from "@/primitives/tools";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SimulatedAction {
	tool: string;
	sideEffect: SideEffect;
	args: unknown;
	/** Plain-language description of what would have happened in real mode. */
	intent: string;
	/** What the agent actually saw (the fake result). */
	result: unknown;
}

export interface SimulationOverlay {
	/** Log of every faked call, in invocation order. Surfaced in reports. */
	actions: SimulatedAction[];
	// ── vault ──
	/** Absolute path → pending content. Wins over disk. */
	vaultWrites: Map<string, string>;
	/** Absolute paths marked deleted. Wins over both `vaultWrites` and disk. */
	vaultDeletes: Set<string>;
	// ── dispatch ──
	pendingTimers: TimerEntry[];
	pendingSchedules: ScheduleEntry[];
	/** Timer or schedule IDs cancelled this turn. Masks both overlay + real. */
	cancelledIds: Set<string>;
	// ── files ──
	uploadedFiles: FileMeta[];
	/** File IDs marked deleted this turn. Masks both overlay + real. */
	deletedFileIds: Set<string>;
}

export function createOverlay(): SimulationOverlay {
	return {
		actions: [],
		vaultWrites: new Map(),
		vaultDeletes: new Set(),
		pendingTimers: [],
		pendingSchedules: [],
		cancelledIds: new Set(),
		uploadedFiles: [],
		deletedFileIds: new Set(),
	};
}

// ── Per-turn overlay accessor ──────────────────────────────────────────────

const overlays = new WeakMap<TurnContext, SimulationOverlay>();

/**
 * Lazily attach a fresh overlay to this turn the first time it's asked for.
 * Tied to the `TurnContext` object identity, so child turns (fresh context
 * per dispatch) always get their own.
 */
export function getOverlay(turn: TurnContext): SimulationOverlay {
	let o = overlays.get(turn);
	if (!o) {
		o = createOverlay();
		overlays.set(turn, o);
	}
	return o;
}

// ── Fakers ─────────────────────────────────────────────────────────────────

/** Plausible result for an external tool — what the agent thinks happened. */
export function fakeExternal(
	toolName: string,
	args: unknown,
): {
	result: unknown;
	intent: string;
} {
	switch (toolName) {
		case "reply": {
			const a = args as { content?: string; voice?: boolean };
			const head = a.content ? a.content.slice(0, 80) : "";
			return {
				result: "sent",
				intent: `Would reply${a.voice ? " (voice)" : ""}: "${head}${
					(a.content?.length ?? 0) > 80 ? "…" : ""
				}"`,
			};
		}
		case "react": {
			const a = args as { emoji?: string; messageRef?: string };
			return {
				result: "reacted",
				intent: `Would react ${a.emoji} on ${a.messageRef ?? "current"}`,
			};
		}
		default:
			return {
				result: "ok",
				intent: `Would invoke external tool ${toolName}`,
			};
	}
}

/** Plausible result for a stateful tool we don't have a custom handler for. */
export function fakeStateful(
	toolName: string,
	args: unknown,
): {
	result: unknown;
	intent: string;
} {
	const argSummary = summariseArgs(args);
	return {
		result: `(sim) ${toolName} acknowledged`,
		intent: `Would ${toolName}${argSummary ? ` ${argSummary}` : ""}`,
	};
}

function summariseArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>);
	if (entries.length === 0) return "";
	const first = entries[0];
	if (!first) return "";
	const [k, v] = first;
	const valStr =
		typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60);
	return `${k}=${valStr}${valStr.length >= 60 ? "…" : ""}`;
}
