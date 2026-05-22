import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "../../../src/infra/whatsapp/receive.ts";
import {
	type Command,
	CommandRegistry,
	parseCommand,
} from "../../../src/primitives/commands/index.ts";

function msg(text: string | undefined): InboundMessage {
	return {
		kind: "whatsapp",
		id: "m1",
		chatId: "c1",
		senderId: "s1",
		...(text !== undefined ? { text } : {}),
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("primitives/commands: parseCommand", () => {
	it("returns null for non-command messages", () => {
		expect(parseCommand(msg("hello"))).toBeNull();
		expect(parseCommand(msg(""))).toBeNull();
		expect(parseCommand(msg(undefined))).toBeNull();
	});

	it("returns null for a bare slash", () => {
		expect(parseCommand(msg("/"))).toBeNull();
	});

	it("extracts name (lowercased) and args", () => {
		expect(parseCommand(msg("/Voice on"))).toEqual({
			name: "voice",
			args: ["on"],
		});
	});

	it("collapses whitespace runs and drops empty tokens", () => {
		expect(parseCommand(msg("/model    set    large"))).toEqual({
			name: "model",
			args: ["set", "large"],
		});
	});

	it("works with no args", () => {
		expect(parseCommand(msg("/help"))).toEqual({ name: "help", args: [] });
	});
});

describe("primitives/commands: CommandRegistry", () => {
	const cmd = (name: string, aliases: string[] = []): Command => ({
		name,
		aliases,
		description: "test",
		execute: async () => {},
	});

	let r: CommandRegistry;
	afterEach(() => {
		r = new CommandRegistry();
	});

	it("registers + retrieves by name and alias", () => {
		r = new CommandRegistry();
		const v = cmd("voice", ["v"]);
		r.register(v);
		expect(r.get("voice")).toBe(v);
		expect(r.get("v")).toBe(v);
		expect(r.has("voice")).toBe(true);
		expect(r.has("nope")).toBe(false);
	});

	it("getAll dedups commands that have aliases", () => {
		r = new CommandRegistry();
		r.register(cmd("voice", ["v"]));
		r.register(cmd("model"));
		const all = r.getAll();
		expect(all).toHaveLength(2);
		expect(all.map((c) => c.name).sort()).toEqual(["model", "voice"]);
	});

	it("re-registering a name overwrites the prior entry", () => {
		r = new CommandRegistry();
		const a = cmd("x");
		const b = cmd("x");
		r.register(a);
		r.register(b);
		expect(r.get("x")).toBe(b);
	});
});
