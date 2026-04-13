import { describe, expect, test } from "bun:test";
import { rewriteVoiceTranscript } from "@/core/voice-parse";

const DEFAULT_AGENT_TRIGGERS = ["hey", "at", "an", "to", "dear"];

const agents = new Set(["klaus", "fitness", "daily"]);

function rewrite(
	text: string,
	opts?: { agentTriggers?: string[] },
): string {
	return rewriteVoiceTranscript(
		text,
		agents,
		opts?.agentTriggers ?? DEFAULT_AGENT_TRIGGERS,
	);
}

describe("agent prefix rewriting", () => {
	test("hey + agent name", () => {
		expect(rewrite("hey fitness help me")).toBe("@fitness help me");
	});

	test("at + agent name", () => {
		expect(rewrite("at klaus what's up")).toBe("@klaus what's up");
	});

	test("to + agent name", () => {
		expect(rewrite("to daily good morning")).toBe("@daily good morning");
	});

	test("an + agent name (STT mishearing)", () => {
		expect(rewrite("an fitness help")).toBe("@fitness help");
	});

	test("dear + agent name", () => {
		expect(rewrite("dear klaus please help")).toBe("@klaus please help");
	});

	test("case insensitive trigger and agent", () => {
		expect(rewrite("Hey Fitness, help me")).toBe("@fitness help me");
	});

	test("comma after agent name is stripped", () => {
		expect(rewrite("hey klaus, what's the weather")).toBe(
			"@klaus what's the weather",
		);
	});

	test("bare agent name with comma at start", () => {
		expect(rewrite("fitness, help me")).toBe("@fitness help me");
	});

	test("unknown agent leaves text unchanged", () => {
		expect(rewrite("at nobody help me")).toBe("at nobody help me");
	});

	test("trigger not at start leaves text unchanged", () => {
		expect(rewrite("look at the data")).toBe("look at the data");
	});

	test("trigger word alone leaves text unchanged", () => {
		expect(rewrite("hey")).toBe("hey");
	});

	test("agent name alone after trigger", () => {
		expect(rewrite("hey fitness")).toBe("@fitness");
	});

	test("empty string returns empty", () => {
		expect(rewrite("")).toBe("");
	});
});

describe("custom triggers", () => {
	test("custom agent trigger", () => {
		expect(rewrite("yo fitness help", { agentTriggers: ["yo"] })).toBe(
			"@fitness help",
		);
	});
});

describe("passthrough", () => {
	test("plain text without triggers passes through", () => {
		expect(rewrite("just a normal message")).toBe("just a normal message");
	});

	test("text with literal @ and ! passes through unchanged", () => {
		expect(rewrite("@fitness help !large")).toBe("@fitness help !large");
	});
});
