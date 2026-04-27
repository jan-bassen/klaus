/**
 * Pending tool-confirmation store. Mirrors the shape of `timers.ts`:
 *   - JSON-persisted under `{dataDir}/confirmations.json`
 *   - reschedule expiry timeouts on load
 *   - fire `onExpire` when an entry's deadline passes
 *
 * Entries hold everything `handleConfirmationResume` needs to spawn a fresh
 * agent run with a synthetic reaction trigger — runId, agentName, chatId,
 * the original tool call, and the WhatsApp message externalId the user
 * reacts/quote-replies to.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "@/infra/logger";
import { TriggerSchema } from "@/infra/store/history";

export const ConfirmationEntrySchema = z.object({
	id: z.string(),
	/** runId of the run that emitted the prompt — for trace/report linkage. */
	runId: z.string(),
	agentName: z.string(),
	chatId: z.string(),
	toolName: z.string(),
	/** JSON-serialised tool args, replayed on resume. */
	toolArgs: z.string(),
	/** WhatsApp message externalId the user reacts/quote-replies to. */
	promptMessageExternalId: z.string(),
	/** Short human-readable summary, e.g. "vault_write Private/foo.md". */
	triggerSummary: z.string(),
	/** Verb for templates — "write", "delete", "dispatch". */
	verb: z.string(),
	/** Original trigger that started the run that asked for confirmation. */
	originalTrigger: TriggerSchema,
	createdAt: z.string(),
	expiresAt: z.string(),
	/**
	 * Names of !overrides active on the original turn. Re-applied on resume so
	 * agent behaviour (voice, model tier, vault elevation) carries over.
	 */
	overrides: z.array(z.string()).optional(),
});

export type ConfirmationEntry = z.infer<typeof ConfirmationEntrySchema>;

export interface ConfirmationStore {
	setOnExpire(fn: (entry: ConfirmationEntry) => Promise<void>): void;
	load(): Promise<void>;
	add(entry: ConfirmationEntry): Promise<void>;
	remove(id: string): Promise<ConfirmationEntry | null>;
	findByPromptId(externalId: string): ConfirmationEntry | null;
	listForChat(chatId: string): ConfirmationEntry[];
	list(): ConfirmationEntry[];
	stopAll(): void;
}

export interface ConfirmationStoreEnv {
	dataDir: string;
}

export function createConfirmationStore(
	env: ConfirmationStoreEnv,
): ConfirmationStore {
	const entries = new Map<string, ConfirmationEntry>();
	const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
	let onExpire: ((entry: ConfirmationEntry) => Promise<void>) | null = null;

	const filePath = (): string => path.join(env.dataDir, "confirmations.json");

	async function persist(): Promise<void> {
		await mkdir(env.dataDir, { recursive: true });
		await Bun.write(filePath(), JSON.stringify([...entries.values()], null, 2));
	}

	function scheduleExpiry(entry: ConfirmationEntry): void {
		const existing = timeouts.get(entry.id);
		if (existing) clearTimeout(existing);

		const delayMs = Math.max(
			0,
			new Date(entry.expiresAt).getTime() - Date.now(),
		);

		const handle = setTimeout(() => {
			timeouts.delete(entry.id);
			entries.delete(entry.id);
			persist().catch((err) =>
				log.error("[confirmations] persist error after expire", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			log.info(`[confirmations] expired ${entry.id} (${entry.triggerSummary})`);
			onExpire?.(entry).catch((err) =>
				log.error("[confirmations] expire handler error", {
					id: entry.id,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}, delayMs);

		timeouts.set(entry.id, handle);
	}

	async function load(): Promise<void> {
		try {
			const text = await Bun.file(filePath()).text();
			const parsed = z.array(ConfirmationEntrySchema).parse(JSON.parse(text));
			for (const entry of parsed) {
				entries.set(entry.id, entry);
				scheduleExpiry(entry);
			}
			log.info(`[confirmations] loaded (${entries.size} pending)`);
		} catch {
			// No file yet
		}
	}

	async function add(entry: ConfirmationEntry): Promise<void> {
		entries.set(entry.id, entry);
		await persist();
		scheduleExpiry(entry);
	}

	async function remove(id: string): Promise<ConfirmationEntry | null> {
		const handle = timeouts.get(id);
		if (handle) clearTimeout(handle);
		timeouts.delete(id);
		const existing = entries.get(id);
		if (!existing) return null;
		entries.delete(id);
		await persist();
		return existing;
	}

	function findByPromptId(externalId: string): ConfirmationEntry | null {
		for (const entry of entries.values()) {
			if (entry.promptMessageExternalId === externalId) return entry;
		}
		return null;
	}

	function listForChat(chatId: string): ConfirmationEntry[] {
		return [...entries.values()].filter((e) => e.chatId === chatId);
	}

	function list(): ConfirmationEntry[] {
		return [...entries.values()];
	}

	function stopAll(): void {
		for (const handle of timeouts.values()) clearTimeout(handle);
		timeouts.clear();
	}

	return {
		setOnExpire: (fn) => {
			onExpire = fn;
		},
		load,
		add,
		remove,
		findByPromptId,
		listForChat,
		list,
		stopAll,
	};
}

// ── Module-level instance + delegators ────────────────────────────────────

let _store: ConfirmationStore | null = null;

export function initConfirmationsStore(env: ConfirmationStoreEnv): void {
	_store = createConfirmationStore(env);
}

function store(): ConfirmationStore {
	if (!_store) throw new Error("[confirmations] store not initialized");
	return _store;
}

export function setOnConfirmationExpire(
	fn: (entry: ConfirmationEntry) => Promise<void>,
): void {
	store().setOnExpire(fn);
}

export function loadConfirmations(): Promise<void> {
	return store().load();
}

export function addConfirmation(entry: ConfirmationEntry): Promise<void> {
	return store().add(entry);
}

export function removeConfirmation(
	id: string,
): Promise<ConfirmationEntry | null> {
	return store().remove(id);
}

export function findConfirmationByPromptId(
	externalId: string,
): ConfirmationEntry | null {
	return store().findByPromptId(externalId);
}

export function listConfirmationsForChat(chatId: string): ConfirmationEntry[] {
	return store().listForChat(chatId);
}

export function listConfirmations(): ConfirmationEntry[] {
	return store().list();
}

export function stopAllConfirmations(): void {
	store().stopAll();
}
