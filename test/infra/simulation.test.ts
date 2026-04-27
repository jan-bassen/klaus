/**
 * `infra/simulation.ts` — overlay isolation + fakers.
 *
 * Read-from-write coherence through the real tool wrappers (vault, dispatch,
 * files) is genuinely useful but requires substantial setup; sticking to the
 * pure pieces here keeps these as fast sanity checks.
 */

import { describe, expect, it } from "vitest";
import { fakeExternal, fakeStateful, getOverlay } from "@/infra/simulation";
import type { TurnContext } from "@/pipeline/agent";
import { makeTurn } from "../helpers/turn";

describe("infra/simulation: overlay isolation", () => {
	it("different TurnContext objects get different overlays (WeakMap identity)", () => {
		const a = makeTurn();
		const b = makeTurn();
		const oa = getOverlay(a);
		const ob = getOverlay(b);
		expect(oa).not.toBe(ob);
		oa.actions.push({
			tool: "x",
			sideEffect: "pure",
			args: {},
			intent: "",
			result: null,
		});
		expect(ob.actions).toHaveLength(0);
	});

	it("repeated getOverlay(sameTurn) returns the same instance", () => {
		const t = makeTurn();
		expect(getOverlay(t)).toBe(getOverlay(t));
	});

	it("fresh overlay starts with empty buckets", () => {
		const o = getOverlay(makeTurn() as TurnContext);
		expect(o.actions).toEqual([]);
		expect(o.vaultWrites.size).toBe(0);
		expect(o.vaultDeletes.size).toBe(0);
		expect(o.pendingTimers).toEqual([]);
		expect(o.pendingSchedules).toEqual([]);
		expect(o.cancelledIds.size).toBe(0);
		expect(o.uploadedFiles).toEqual([]);
		expect(o.deletedFileIds.size).toBe(0);
	});
});

describe("infra/simulation: fakers", () => {
	it("fakeExternal('reply') returns 'sent' with quoted preview", () => {
		const out = fakeExternal("reply", { content: "hello world" });
		expect(out.result).toBe("sent");
		expect(out.intent).toContain("hello world");
	});

	it("fakeExternal('reply') with voice flag includes (voice)", () => {
		const out = fakeExternal("reply", { content: "hi", voice: true });
		expect(out.intent).toContain("(voice)");
	});

	it("fakeExternal long content truncates with ellipsis", () => {
		const out = fakeExternal("reply", { content: "x".repeat(120) });
		expect(out.intent).toContain("…");
	});

	it("fakeExternal('react') describes the emoji + ref", () => {
		const out = fakeExternal("react", { emoji: "👍", messageRef: "m-1" });
		expect(out.result).toBe("reacted");
		expect(out.intent).toContain("👍");
		expect(out.intent).toContain("m-1");
	});

	it("fakeExternal unknown tool falls back to a generic intent", () => {
		const out = fakeExternal("unknown", {});
		expect(out.result).toBe("ok");
		expect(out.intent).toContain("unknown");
	});

	it("fakeStateful summarises first arg into intent", () => {
		const out = fakeStateful("vault.write", {
			path: "Notes/x.md",
			content: "hi",
		});
		expect(out.intent).toContain("vault.write");
		expect(out.intent).toContain("path=");
	});
});
