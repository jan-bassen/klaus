/**
 * `infra/store/confirmations.ts` — pending tool-confirmation persistence +
 * expiry firing. Mirrors the timers store contract (round-trip, expire,
 * reload-then-reschedule). Real fs I/O into a tmp dir; real `setTimeout` with
 * short delays so we don't fight Bun's timer semantics under fake timers.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addConfirmation,
	type ConfirmationEntry,
	createConfirmationStore,
	findConfirmationByPromptId,
	initConfirmationsStore,
	listConfirmations,
	listConfirmationsForChat,
	removeConfirmation,
	stopAllConfirmations,
} from "@/infra/store/confirmations";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp";

function makeEntry(
	overrides: Partial<ConfirmationEntry> = {},
): ConfirmationEntry {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		runId: "run-1",
		agentName: "test",
		chatId: "c1",
		toolName: "vault_write",
		toolArgs: JSON.stringify({ path: "Private/foo.md" }),
		promptMessageExternalId: "wa-msg-1",
		triggerSummary: "vault_write Private/foo.md",
		verb: "write",
		originalTrigger: { kind: "message", messageId: "m-1" },
		createdAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

describe("infra/store/confirmations: add/list/remove", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initConfirmationsStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		stopAllConfirmations();
		rmTmpDir(tmpDir);
	});

	it("add → list includes the entry", async () => {
		const e = makeEntry();
		await addConfirmation(e);
		expect(listConfirmations()).toEqual([e]);
	});

	it("findByPromptId resolves a pending entry by WhatsApp externalId", async () => {
		const e = makeEntry({ promptMessageExternalId: "wa-99" });
		await addConfirmation(e);
		expect(findConfirmationByPromptId("wa-99")?.id).toBe(e.id);
		expect(findConfirmationByPromptId("nope")).toBeNull();
	});

	it("listForChat scopes to one chatId", async () => {
		await addConfirmation(makeEntry({ id: "a", chatId: "c1" }));
		await addConfirmation(makeEntry({ id: "b", chatId: "c2" }));
		const c1 = listConfirmationsForChat("c1");
		expect(c1.map((e) => e.id)).toEqual(["a"]);
	});

	it("remove returns the entry on success and null on miss", async () => {
		const e = makeEntry();
		await addConfirmation(e);
		const removed = await removeConfirmation(e.id);
		expect(removed?.id).toBe(e.id);
		expect(listConfirmations()).toEqual([]);
		expect(await removeConfirmation("nope")).toBeNull();
	});
});

describe("infra/store/confirmations: expiry firing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		initConfirmationsStore({ dataDir: tmpDir });
	});

	afterEach(() => {
		stopAllConfirmations();
		rmTmpDir(tmpDir);
	});

	it("fires onExpire and self-deletes from list + disk", async () => {
		const store = createConfirmationStore({ dataDir: tmpDir });
		const expired: ConfirmationEntry[] = [];
		store.setOnExpire(async (e) => {
			expired.push(e);
		});

		const e = makeEntry({
			expiresAt: new Date(Date.now() + 10).toISOString(),
		});
		await store.add(e);
		expect(store.list()).toHaveLength(1);

		await new Promise((r) => setTimeout(r, 60));
		// Allow the post-fire persist() to settle.
		await new Promise((r) => setTimeout(r, 30));

		expect(expired.map((x) => x.id)).toEqual([e.id]);
		expect(store.list()).toEqual([]);

		const text = await Bun.file(path.join(tmpDir, "confirmations.json")).text();
		expect(JSON.parse(text)).toEqual([]);
	});

	it("expiresAt in the past: still fires (delay clamped to 0)", async () => {
		const store = createConfirmationStore({ dataDir: tmpDir });
		const expired: ConfirmationEntry[] = [];
		store.setOnExpire(async (e) => {
			expired.push(e);
		});

		await store.add(
			makeEntry({ expiresAt: new Date(Date.now() - 5_000).toISOString() }),
		);

		await new Promise((r) => setTimeout(r, 30));
		expect(expired).toHaveLength(1);
	});

	it("remove cancels the expiry timeout (no fire)", async () => {
		const store = createConfirmationStore({ dataDir: tmpDir });
		const expired: ConfirmationEntry[] = [];
		store.setOnExpire(async (e) => {
			expired.push(e);
		});

		const e = makeEntry({
			expiresAt: new Date(Date.now() + 30).toISOString(),
		});
		await store.add(e);
		await store.remove(e.id);

		await new Promise((r) => setTimeout(r, 60));
		expect(expired).toEqual([]);
	});
});

describe("infra/store/confirmations: persistence + reload", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		stopAllConfirmations();
		rmTmpDir(tmpDir);
	});

	it("confirmations.json written after add; readable JSON array", async () => {
		initConfirmationsStore({ dataDir: tmpDir });
		const e = makeEntry();
		await addConfirmation(e);

		const file = path.join(tmpDir, "confirmations.json");
		expect(existsSync(file)).toBe(true);
		const parsed = JSON.parse(await Bun.file(file).text());
		expect(parsed).toEqual([e]);
	});

	it("load on a fresh store restores entries AND re-schedules expiry", async () => {
		const first = createConfirmationStore({ dataDir: tmpDir });
		const e = makeEntry({
			expiresAt: new Date(Date.now() + 30).toISOString(),
		});
		await first.add(e);
		first.stopAll();

		const second = createConfirmationStore({ dataDir: tmpDir });
		const expired: ConfirmationEntry[] = [];
		second.setOnExpire(async (entry) => {
			expired.push(entry);
		});
		await second.load();
		expect(second.list()).toEqual([e]);

		await new Promise((r) => setTimeout(r, 80));
		expect(expired).toHaveLength(1);
		expect(expired[0]?.id).toBe(e.id);

		second.stopAll();
	});
});
