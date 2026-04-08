import { describe, expect, test } from "bun:test";
import { rewriteVoiceTranscript } from "@/core/voice-parse";

const DEFAULT_AGENT_TRIGGERS = ["hey", "at", "an", "to", "dear"];
const DEFAULT_FLAG_TRIGGERS = [
	"flagged with",
	"tagged with",
	"flags",
	"tags",
	"flag",
	"tag",
];

const agents = new Set(["klaus", "fitness", "daily"]);
const flags = new Set([
	"voice",
	"clean",
	"small",
	"medium",
	"large",
	"accept",
	"cold",
	"hot",
	"no-tools",
	"use-tools",
	"ghost",
]);

function rewrite(
	text: string,
	opts?: { agentTriggers?: string[]; flagTriggers?: string[] },
): string {
	return rewriteVoiceTranscript(
		text,
		agents,
		flags,
		opts?.agentTriggers ?? DEFAULT_AGENT_TRIGGERS,
		opts?.flagTriggers ?? DEFAULT_FLAG_TRIGGERS,
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

describe("flag suffix rewriting", () => {
	test("flagged with + single flag", () => {
		expect(rewrite("help me flagged with large")).toBe("help me !large");
	});

	test("flags + multiple flags", () => {
		expect(rewrite("help me flags large voice")).toBe("help me !large !voice");
	});

	test("tagged with + flag", () => {
		expect(rewrite("tell me something tagged with cold")).toBe(
			"tell me something !cold",
		);
	});

	test("tags + flag", () => {
		expect(rewrite("answer this tags clean")).toBe("answer this !clean");
	});

	test("flag + single flag", () => {
		expect(rewrite("do this flag ghost")).toBe("do this !ghost");
	});

	test("tag + single flag", () => {
		expect(rewrite("do this tag voice")).toBe("do this !voice");
	});

	test("hyphenated flag spoken as two words", () => {
		expect(rewrite("tell me tagged with no tools")).toBe("tell me !no-tools");
	});

	test("use tools as two words", () => {
		expect(rewrite("help flags use tools")).toBe("help !use-tools");
	});

	test("mixed single and multi-word flags", () => {
		expect(rewrite("help flags no tools and large")).toBe(
			"help !no-tools !large",
		);
	});

	test("filler words (and, with) are skipped", () => {
		expect(rewrite("help flagged with large and voice")).toBe(
			"help !large !voice",
		);
	});

	test("unknown flag leaves text unchanged", () => {
		expect(rewrite("help me flagged with banana")).toBe(
			"help me flagged with banana",
		);
	});

	test("trailing period is stripped", () => {
		expect(rewrite("help me flagged with large.")).toBe("help me !large");
	});

	test("trailing question mark is stripped", () => {
		expect(rewrite("help me flagged with voice?")).toBe("help me !voice");
	});

	test("case insensitive flags", () => {
		expect(rewrite("help me Flagged With Large")).toBe("help me !large");
	});

	test("trigger in middle of sentence without known flags", () => {
		expect(rewrite("I flagged the issue with the server")).toBe(
			"I flagged the issue with the server",
		);
	});
});

describe("combined agent + flags", () => {
	test("agent prefix and flag suffix together", () => {
		expect(rewrite("hey fitness help me flagged with large")).toBe(
			"@fitness help me !large",
		);
	});

	test("agent and multiple flags", () => {
		expect(rewrite("hey klaus tell me something tags voice clean")).toBe(
			"@klaus tell me something !voice !clean",
		);
	});

	test("agent with hyphenated flag", () => {
		expect(rewrite("to fitness plan my workout tagged with no tools")).toBe(
			"@fitness plan my workout !no-tools",
		);
	});
});

describe("custom triggers", () => {
	test("custom agent trigger", () => {
		expect(rewrite("yo fitness help", { agentTriggers: ["yo"] })).toBe(
			"@fitness help",
		);
	});

	test("custom flag trigger", () => {
		expect(rewrite("help me with large", { flagTriggers: ["with"] })).toBe(
			"help me !large",
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
