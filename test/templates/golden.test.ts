import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { loadTemplates, renderTemplate } from "../../src/pipeline/prompts.ts";

describe("template goldens", () => {
	let originalTemplatesDir: string;

	beforeAll(() => {
		originalTemplatesDir = settings.vault.templatesDir;
		settings.vault.templatesDir = path.resolve(
			process.cwd(),
			"vault/templates",
		);
		loadTemplates();

		return () => {
			settings.vault.templatesDir = originalTemplatesDir;
		};
	});

	it("renders message-user variants without drifting markers or whitespace", () => {
		expect(
			renderTemplate("message-user", {
				isVoice: true,
				voiceCaption: "walking home",
				messageText: "turn left",
				label: 7,
			}),
		).toBe(
			'Transcript of voice note. Caption: "walking home"\n\n[#7] turn left',
		);

		expect(
			renderTemplate("message-user", {
				isImage: true,
				quotedText: "previous note",
				quotedRole: "user",
				messageText: "what is this?",
			}),
		).toBe("Image\n> Quoted (user): previous note\n\nwhat is this?");

		expect(
			renderTemplate("message-user", {
				isDocument: true,
				fileName: "plan.pdf",
				mimeType: "application/pdf",
				messageText: "summarise",
			}),
		).toBe("Attached: plan.pdf (application/pdf)\n\nsummarise");

		expect(
			renderTemplate("message-user", {
				label: 3,
				messageText: "plain hello",
			}),
		).toBe("[#3] plain hello");
	});

	it("renders message-agent with optional non-default-agent prefix, history label, and reactions", () => {
		expect(
			renderTemplate("message-agent", {
				isNotDefaultAgent: true,
				agentLabel: "researcher",
				message: "found it",
			}),
		).toBe("[researcher] found it");

		expect(
			renderTemplate("message-agent", {
				isNotDefaultAgent: false,
				agentLabel: "default",
				message: "done",
			}),
		).toBe("done");

		expect(
			renderTemplate("message-agent", {
				label: 5,
				message: "answer",
			}),
		).toBe("[#5] answer");

		expect(
			renderTemplate("message-agent", {
				label: 7,
				message: "with reactions",
				reactionEmojis: "👍 ❤️",
			}),
		).toBe("[#7] with reactions\n👍 ❤️");
	});

	it("renders user-facing error messages by kind", () => {
		expect(renderTemplate("error", { kind: "timeout" })).toBe(
			"The AI model timed out — please try again.",
		);
		expect(renderTemplate("error", { kind: "rate_limit" })).toBe(
			"Too many requests right now — please try again in a moment.",
		);
		expect(renderTemplate("error", { kind: "too_long" })).toBe(
			"Your conversation got too long for the model — try starting fresh.",
		);
		expect(
			renderTemplate("error", {
				kind: "unknown",
				message: "Something low-level broke",
			}),
		).toBe("Something went wrong: Something low-level broke");
	});

	it("renders full reports with prompts, history, variables, and simulated actions", () => {
		const rendered = renderTemplate("report", {
			timestamp: "2026-04-28T10:00:00.000Z",
			agent: "assistant",
			runId: "run-1",
			chatId: "chat-1",
			trigger: { kind: "dispatch", parentRunId: "parent-1" },
			durationMs: 123,
			outcome: { kind: "error", error: { name: "Error", message: "boom" } },
			simulation: true,
			overrides: ["simulate"],
			config: {
				provider: "claude",
				modelTier: "medium",
				historyLimit: 2,
				historyScope: "full",
			},
			message: { text: "hello", hasMedia: true, mediaType: "image/png" },
			llm: {
				provider: "openrouter",
				model: "model-a",
				tier: "medium",
				durationMs: 99,
				usage: { promptTokens: 10, completionTokens: 20 },
				systemPromptChars: 13,
				userMessageChars: 8,
				historyMessageCount: 1,
				replyChars: 5,
				steps: [
					{
						finishReason: "tool_calls",
						usage: { inputTokens: 10, outputTokens: 20 },
						reasoning: "thinking",
						toolCalls: [{ tool: "vault_read", args: { path: "A.md" } }],
					},
				],
				systemPrompt: "system\nprompt",
				userMessage: "user msg",
				historyTranscript: [{ role: "user", content: "past msg" }],
			},
			variablesSummary: { time: 20 },
			simulatedActions: [
				{
					tool: "reply",
					sideEffect: "external",
					intent: "Would reply",
				},
			],
		});

		expect(rendered).toContain("- **Outcome**: error — `Error: boom`");
		expect(rendered).toContain("- ⚠ **SIMULATION** — no real side effects");
		expect(rendered).toContain("## Message");
		expect(rendered).toContain("## LLM");
		expect(rendered).toContain("### System prompt\n```\nsystem\nprompt\n```");
		expect(rendered).toContain("### User message\n```\nuser msg\n```");
		expect(rendered).toContain("### History transcript");
		expect(rendered).toContain("## Variables\n- time: 20 chars");
		expect(rendered).toContain(
			"## Simulated actions\n- **reply** (external) — Would reply",
		);
	});
});
