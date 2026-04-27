/**
 * Tool-confirmation framework. Two halves:
 *
 *   1. **The gate** — `evaluateGate` decides per-tool-call whether the
 *      framework intercepts. Wired into `invokeTool` (pipeline/context.ts).
 *      Returns the synthetic tool result; the model sees
 *      `{status: "awaiting_confirmation", ...}` and stops.
 *
 *   2. **The resume** — `handleConfirmationResume` is called by reaction-
 *      detection (whatsapp/receive.ts) and quote-reply intercept
 *      (pipeline/index.ts) once the user has responded. It spawns a fresh
 *      agent run via `dispatch` with a synthetic reaction trigger; the gate
 *      bypasses the matching tool exactly once on that run.
 *
 * The store layer lives in `infra/store/confirmations.ts` — this file holds
 * only the per-turn orchestration logic.
 */

import { settings } from "@/infra/config";
import { log } from "@/infra/logger";
import {
	addConfirmation,
	type ConfirmationEntry,
	removeConfirmation,
} from "@/infra/store/confirmations";
import { enqueueMessage } from "@/infra/whatsapp/send";
import type { Trigger, TurnContext } from "@/pipeline/agent";
import type { ToolDefinition } from "@/primitives/tools";

/** What `evaluateGate` returns to the caller in `invokeTool`. */
export type GateDecision =
	| { kind: "skip" }
	| { kind: "gate"; verb: string; summary: string };

/**
 * Decide whether this tool call needs user confirmation.
 *
 * Skip (no gate) if:
 *   - the tool didn't declare `requiresConfirmation`
 *   - we're in simulation mode (no real consequences)
 *   - `autoAccept` is on (user pre-authorised)
 *   - the trigger is non-`message` (no user present to react)
 *   - this is a reaction-resume run AND the tool name matches the bypass slot
 *
 * Otherwise consult the tool's own `requiresConfirmation`. If it returns a
 * non-false value, gate.
 */
export function evaluateGate(
	tool: ToolDefinition,
	input: unknown,
	turn: TurnContext,
): GateDecision {
	if (!tool.requiresConfirmation) return { kind: "skip" };
	if (turn.config?.simulate) return { kind: "skip" };
	if (turn.config?.autoAccept) return { kind: "skip" };

	if (turn.trigger.kind !== "message" && turn.trigger.kind !== "reaction") {
		// schedule / timer / dispatch — auto-accept (no user present)
		return { kind: "skip" };
	}

	if (
		turn.trigger.kind === "reaction" &&
		turn.bypassConfirmationForTool === tool.name &&
		turn.trigger.decision === "approve"
	) {
		// Bypass exactly once — clear the slot so subsequent calls re-gate.
		turn.bypassConfirmationForTool = undefined;
		return { kind: "skip" };
	}

	const verdict = tool.requiresConfirmation(input, turn);
	if (verdict === false) return { kind: "skip" };
	return { kind: "gate", verb: verdict.verb, summary: verdict.summary };
}

/**
 * Persist a pending entry, send the prompt to the user, and return the
 * synthetic tool result for the model. Called from `invokeTool` when the
 * gate decides to intercept.
 *
 * On send failure (no externalId returned within the timeout), we don't
 * persist — there's no anchor for the user to react to, so the chain dies
 * cleanly and the model surfaces the error.
 */
export async function requestConfirmation(opts: {
	tool: ToolDefinition;
	input: unknown;
	turn: TurnContext;
	verb: string;
	summary: string;
}): Promise<{ status: "awaiting_confirmation"; confirmationId: string }> {
	const { tool, input, turn, verb, summary } = opts;
	const id = crypto.randomUUID();
	const expiresAt = new Date(
		Date.now() + settings.agent.confirmTimeoutMinutes * 60_000,
	).toISOString();

	const approveSet = settings.agent.confirmEmojis.approve.join(" / ");
	const denySet = settings.agent.confirmEmojis.deny.join(" / ");
	const promptText =
		`@${turn.agent.name} wants to *${verb}*: \`${summary}\`\n\n` +
		`React ${approveSet} to approve, ${denySet} to cancel. ` +
		`Quote-reply to deny with a reason. ` +
		`Expires in ${formatExpiry(settings.agent.confirmTimeoutMinutes)}.`;

	const externalId = await sendAndAwaitId(turn.chatId, promptText, id);
	if (!externalId) {
		log.warn(`[confirmations] send failed for ${id} (${tool.name})`);
		return { status: "awaiting_confirmation", confirmationId: id };
	}

	const overrideNames = Object.keys(turn.overrides).filter(
		(k) => turn.overrides[k],
	);
	const entry: ConfirmationEntry = {
		id,
		runId: turn.runId,
		agentName: turn.agent.name,
		chatId: turn.chatId,
		toolName: tool.name,
		toolArgs: JSON.stringify(input),
		promptMessageExternalId: externalId,
		triggerSummary: `${tool.name} ${summary}`,
		verb,
		originalTrigger: turn.trigger,
		createdAt: new Date().toISOString(),
		expiresAt,
		...(overrideNames.length > 0 ? { overrides: overrideNames } : {}),
	};

	await addConfirmation(entry);
	log.info(
		`[confirmations] gated ${tool.name} (${summary}) — id=${id}, ` +
			`expires=${expiresAt}`,
	);

	return { status: "awaiting_confirmation", confirmationId: id };
}

/** Wrap `enqueueMessage` so we can await the WhatsApp externalId. */
function sendAndAwaitId(
	chatId: string,
	content: string,
	dedupSeed: string,
): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (id: string | null): void => {
			if (settled) return;
			settled = true;
			resolve(id);
		};

		// 30s ceiling — the send queue could be stuck behind a long-running send
		// chain; we don't want to hold the model loop indefinitely.
		const timeout = setTimeout(() => finish(null), 30_000);

		enqueueMessage(
			{
				chatId,
				content,
				dedupKey: `confirm:${dedupSeed}`,
				label: settings.whatsapp.systemLabel,
			},
			(waId) => {
				clearTimeout(timeout);
				finish(waId ?? null);
			},
		);
	});
}

function formatExpiry(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const h = Math.round(minutes / 60);
	if (h < 48) return `${h}h`;
	const d = Math.round(h / 24);
	return `${d}d`;
}

// ── Resume ─────────────────────────────────────────────────────────────────

export type ResumeDecision =
	| { decision: "approve" }
	| { decision: "deny"; reason?: string | undefined };

/**
 * Convert a user reaction/quote-reply into a fresh agent run.
 *
 * Removes the entry from the store, builds a synthetic dispatch with
 * `trigger.kind === "reaction"`, and threads `bypassConfirmationForTool` so
 * the matching tool's gate skips exactly once on approval. On denial, the
 * agent receives the user's reason (if any) and decides how to recover.
 *
 * Returns silently if the entry is gone (already resumed/expired).
 */
export async function handleConfirmationResume(
	confirmationId: string,
	decision: ResumeDecision,
): Promise<void> {
	const entry = await removeConfirmation(confirmationId);
	if (!entry) {
		log.info(`[confirmations] resume skipped — no entry for ${confirmationId}`);
		return;
	}

	const trigger: Trigger = {
		kind: "reaction",
		confirmationId: entry.id,
		decision: decision.decision,
		...(decision.decision === "deny" && decision.reason
			? { reason: decision.reason }
			: {}),
	};

	const prompt = buildResumePrompt(entry, decision);

	log.info(
		`[confirmations] resuming ${entry.id} for @${entry.agentName} (${decision.decision})`,
	);

	// Lazy-import dispatch to avoid a circular import:
	// dispatch → executeAgent → context → confirmations.
	const { dispatch } = await import("@/pipeline/dispatch");
	await dispatch({
		agent: entry.agentName,
		prompt,
		chatId: entry.chatId,
		trigger,
		...(entry.overrides && entry.overrides.length > 0
			? { overrides: entry.overrides }
			: {}),
		...(decision.decision === "approve"
			? { bypassConfirmationForTool: entry.toolName }
			: {}),
	});
}

function buildResumePrompt(
	entry: ConfirmationEntry,
	decision: ResumeDecision,
): string {
	const head = `Earlier you asked the user to confirm: \`${entry.triggerSummary}\`.`;
	if (decision.decision === "approve") {
		return (
			`${head} The user approved. ` +
			`Proceed by re-invoking \`${entry.toolName}\` with the same arguments — ` +
			`the framework will allow it through. Do not ask for confirmation again.\n\n` +
			`Original arguments:\n\`\`\`json\n${entry.toolArgs}\n\`\`\``
		);
	}
	const reason = decision.reason
		? ` Reason: "${decision.reason}".`
		: " No reason given.";
	return (
		`${head} The user declined.${reason} ` +
		`Do not retry. Acknowledge with a short reply and adapt — for example, ` +
		`offer an alternative if the reason suggests one.`
	);
}

/**
 * Drop all pending confirmations for a chat — used when a new (non-quoted)
 * user message arrives while pendings exist and the
 * `confirmSupersedeOnNewTurn` setting is on. Each removed entry triggers
 * a brief system notice so the user knows the slate was cleared.
 */
export async function supersedeConfirmationsForChat(
	chatId: string,
): Promise<ConfirmationEntry[]> {
	const { listConfirmationsForChat } = await import(
		"@/infra/store/confirmations"
	);
	const entries = listConfirmationsForChat(chatId);
	const removed: ConfirmationEntry[] = [];
	for (const entry of entries) {
		const r = await removeConfirmation(entry.id);
		if (r) removed.push(r);
	}
	return removed;
}
