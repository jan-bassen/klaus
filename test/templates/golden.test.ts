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
				tasks: { active: [] },
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
				tasks: { active: [] },
				isImage: true,
				quotedText: "previous note",
				quotedRole: "user",
				messageText: "what is this?",
			}),
		).toBe("Image\n> Quoted (user): previous note\n\nwhat is this?");

		expect(
			renderTemplate("message-user", {
				tasks: { active: [] },
				isDocument: true,
				fileName: "plan.pdf",
				mimeType: "application/pdf",
				messageText: "summarise",
			}),
		).toBe("Attached: plan.pdf (application/pdf)\n\nsummarise");

		expect(
			renderTemplate("message-user", {
				tasks: { active: [] },
				label: 3,
				messageText: "plain hello",
			}),
		).toBe("[#3] plain hello");

		expect(
			renderTemplate("message-user", {
				tasks: {
					active: [
						{
							kind: "timer",
							runAt: "2026-05-19T12:00:00.000Z",
							objective: "check soup",
						},
					],
				},
				messageText: "plain hello",
			}),
		).toBe(
			"Context:\n- Active tasks:\n  - [timer 2026-05-19T12:00:00.000Z] check soup\n\nplain hello",
		);
	});

	it("renders history messages without live context", () => {
		expect(
			renderTemplate("history-user", {
				label: 3,
				messageText: "plain hello",
			}),
		).toBe("[#3] plain hello");

		expect(
			renderTemplate("history-agent", {
				label: 7,
				message: "with reactions",
				reactionEmojis: "👍 ❤️",
			}),
		).toBe("[#7] with reactions\n👍 ❤️");
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

	it("renders the persistence follow-up nudge", () => {
		expect(
			renderTemplate("persistence", {
				toolName: "persist",
				hint: "choose a useful next run",
			}),
		).toBe(
			"Now schedule your next run by calling the `persist` tool. Hint: choose a useful next run",
		);
	});

	it("renders help with WhatsApp emphasis applied consistently to values and headings", () => {
		expect(
			renderTemplate("help", {
				settings: {
					agent: "assistant",
					model: "openai / medium",
					voice: "auto",
					report: "on",
					history: "20 (full scope)",
				},
				agents: [
					{
						name: "assistant",
						aliases: "",
						tools: "reply, react, image_generate",
						toolsets: "vault, dispatch, files",
						model: "openai / medium",
						history: "20 (full scope)",
					},
					{
						name: "dispatch",
						aliases: " [d]",
						tools: "reply",
						toolsets: "vault",
						model: "openai / medium",
						history: "10 (agent scope)",
					},
				],
				commands: [
					{
						name: "help",
						aliases: " [?]",
						params: "<section>",
						description: "Show settings, agents, overrides, commands",
					},
				],
				overrides: [
					{
						name: "voice",
						aliases: " [v]",
						description: "Reply as voice message",
					},
				],
			}),
		).toBe(`*Settings*

agent: @assistant
model: _openai / medium_
voice: _auto_
report: _on_
history: _20 (full scope)_

*Agents*

*@assistant*
tools: _reply, react, image_generate_
toolsets: _vault, dispatch, files_
model: _openai / medium_
history: _20 (full scope)_
*@dispatch* [d]
tools: _reply_
toolsets: _vault_
model: _openai / medium_
history: _10 (agent scope)_

*Commands*

*/help* [?] <section>
_Show settings, agents, overrides, commands_

*Overrides*

*!voice* [v]
_Reply as voice message_`);
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
				context: {
					variables: ["time", "user"],
					tools: ["reply", "vault_read", "openrouter:web_search"],
					skills: ["obsidian-markdown"],
				},
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
				systemPrompt: "system\n```text\nprompt\n```",
				userMessage: "user msg",
				assistantMessage: "agent msg",
				historyTranscript: [{ role: "user", content: "past msg" }],
			},
			simulatedActions: [
				{
					tool: "reply",
					sideEffect: "external",
					intent: "Would reply",
				},
			],
		});

		expect(rendered).toContain("**Outcome**: error — `Error: boom`");
		expect(rendered).toContain("⚠ **SIMULATION** — no real side effects");
		expect(rendered).toContain("### Context");
		expect(rendered).toContain("**Variables**\n```\ntime, user\n```");
		expect(rendered).toContain(
			"**Tools**\n```\nreply, vault_read, openrouter:web_search\n```",
		);
		expect(rendered).toContain("**Skills**\n```\nobsidian-markdown\n```");
		expect(rendered).toContain(
			"### System\n````\nsystem\n```text\nprompt\n```\n````",
		);
		expect(rendered).toContain("### History");
		expect(rendered).toContain("### User message\n```\nuser msg\n```");
		expect(rendered).toContain("### Agent messages\n```\nagent msg\n```");
		expect(rendered).toContain(
			'### Steps\n**1) vault_read** (10↑/20↓)\n> thinking\n\n`{"path":"A.md"}`',
		);
		expect(rendered).toContain(
			"### Simulated actions\n- **reply** (external) — Would reply",
		);
	});
});
