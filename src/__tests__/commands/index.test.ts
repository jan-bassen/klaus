import { describe, expect, test } from "bun:test";
import { CommandRegistry, parseCommand } from "@/commands";
import type { InboundMessage } from "@/types";

function makeMsg(text?: string): InboundMessage {
	const base = {
		kind: "whatsapp" as const,
		id: crypto.randomUUID(),
		chatId: "user@s.whatsapp.net",
		senderId: "user@s.whatsapp.net",
		timestamp: new Date(),
		messageKey: {},
	};
	if (text !== undefined) return { ...base, text };
	return base;
}

describe("parseCommand", () => {
	test("returns null when text is undefined", () => {
		expect(parseCommand(makeMsg(undefined))).toBeNull();
	});

	test("returns null when text does not start with /", () => {
		expect(parseCommand(makeMsg("just a message"))).toBeNull();
	});

	test("returns null for / alone", () => {
		expect(parseCommand(makeMsg("/"))).toBeNull();
	});

	test("parses a command with no args", () => {
		expect(parseCommand(makeMsg("/status"))).toEqual({
			name: "status",
			args: [],
		});
	});

	test("parses a command with one arg", () => {
		expect(parseCommand(makeMsg("/switch thinking"))).toEqual({
			name: "switch",
			args: ["thinking"],
		});
	});

	test("parses a command with multiple args", () => {
		expect(parseCommand(makeMsg("/cmd arg1 arg2 arg3"))).toEqual({
			name: "cmd",
			args: ["arg1", "arg2", "arg3"],
		});
	});

	test("handles extra whitespace without producing empty args", () => {
		expect(parseCommand(makeMsg("/cmd  arg1   arg2  "))).toEqual({
			name: "cmd",
			args: ["arg1", "arg2"],
		});
	});

	test("lowercases the command name", () => {
		expect(parseCommand(makeMsg("/Status"))?.name).toBe("status");
		expect(parseCommand(makeMsg("/ABORT"))?.name).toBe("abort");
	});

	test("preserves arg casing", () => {
		expect(parseCommand(makeMsg("/switch ThinkingAgent"))?.args).toEqual([
			"ThinkingAgent",
		]);
	});

	test("returns null when / appears mid-text", () => {
		expect(parseCommand(makeMsg("hey /status"))).toBeNull();
	});

	test("returns null for empty text", () => {
		expect(parseCommand(makeMsg(""))).toBeNull();
	});

	test("parses /? as command name '?'", () => {
		expect(parseCommand(makeMsg("/?"))).toEqual({
			name: "?",
			args: [],
		});
	});
});

describe("CommandRegistry", () => {
	test("register and get round-trip", () => {
		const reg = new CommandRegistry();
		const cmd = {
			name: "test",
			description: "a test command",
			execute: async () => {},
		};
		reg.register(cmd);
		expect(reg.get("test")).toBe(cmd);
	});

	test("get returns undefined for unknown command", () => {
		const reg = new CommandRegistry();
		expect(reg.get("nope")).toBeUndefined();
	});

	test("has returns true for registered command", () => {
		const reg = new CommandRegistry();
		reg.register({
			name: "ping",
			description: "pong",
			execute: async () => {},
		});
		expect(reg.has("ping")).toBe(true);
	});

	test("has returns false for unknown command", () => {
		const reg = new CommandRegistry();
		expect(reg.has("missing")).toBe(false);
	});

	test("alias resolves to the same command", () => {
		const reg = new CommandRegistry();
		const cmd = {
			name: "help",
			aliases: ["?", "h"],
			description: "show help",
			execute: async () => {},
		};
		reg.register(cmd);
		expect(reg.get("?")).toBe(cmd);
		expect(reg.get("h")).toBe(cmd);
		expect(reg.get("help")).toBe(cmd);
	});

	test("getAll does not return duplicates for aliased commands", () => {
		const reg = new CommandRegistry();
		const cmd = {
			name: "help",
			aliases: ["?"],
			description: "show help",
			execute: async () => {},
		};
		reg.register(cmd);
		expect(reg.getAll()).toHaveLength(1);
	});

	test("later registration overrides earlier one", () => {
		const reg = new CommandRegistry();
		const first = {
			name: "dup",
			description: "first",
			execute: async () => {},
		};
		const second = {
			name: "dup",
			description: "second",
			execute: async () => {},
		};
		reg.register(first);
		reg.register(second);
		expect(reg.get("dup")?.description).toBe("second");
	});
});
