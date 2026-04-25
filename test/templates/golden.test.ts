/**
 * Template golden outputs. Catches Handlebars drift and whitespace regressions.
 *
 * Setup: `loadTemplates()` once (vitest.config sets VAULT_DIR → repo root so
 * templates resolve to `Klaus/templates/`). Then call `renderTemplate(name, vars)`
 * per test and assert against an inline golden string.
 *
 * Keep goldens inline (not separate files) — diffs in PRs are easier to review.
 */

import { beforeAll, describe, it } from "vitest";

// import { loadTemplates, renderTemplate } from "@/pipeline/prompts";

describe("templates/message-user", () => {
	beforeAll(() => {
		// loadTemplates();
	});

	it.todo(
		"voice note with caption: 'Transcript of voice note. Caption: \"…\" …'",
	);

	it.todo("image: 'Image' marker + quoted text prefix when set");

	it.todo("document attached: shows fileName + mimeType");

	it.todo("web links: renders [title](url) + truncated text per link");

	it.todo("plain text fallback: no marker, just `[#label] messageText`");
});

describe("templates/message-agent", () => {
	it.todo(
		"showTrace true + steps present: renders '[@agent used X, Y → replied]' prefix",
	);

	it.todo("showTrace false: omits the trace line, keeps text");

	it.todo(
		"single call in a single step: comma handling is correct (no trailing comma)",
	);

	it.todo("multiple calls across multiple steps: separators look right");
});

describe("templates/message-tool", () => {
	it.todo("with argSnippet: 'toolName(\"argSnippet\")'");

	it.todo("without argSnippet: 'toolName' alone");
});

describe("templates/error-message", () => {
	it.todo("kind: 'timeout' → 'The AI model timed out — please try again.'");

	it.todo("kind: 'rate_limit' → 'Too many requests right now…'");

	it.todo("kind: 'too_long' → 'Your conversation got too long…'");

	it.todo("default kind: 'Something went wrong: {{message}}'");
});

describe("templates/report-short", () => {
	it.todo(
		"ok outcome + llm: 'TIMESTAMP @agent (trigger) — ok in Xms | model A↑/B↓ (N steps)'",
	);

	it.todo("error outcome: includes 'error: ErrorName' in the middle");

	it.todo("simulation: true: appends ' ⚠ SIM'");
});

describe("templates/report-full", () => {
	it.todo(
		"level: 'full' with llm + message + variablesSummary renders all three sections",
	);

	it.todo("with simulatedActions: '## Simulated actions' block present");

	it.todo(
		"with historyTranscript: '### History transcript' block with per-role fenced blocks",
	);

	it.todo(
		"verbatim systemPrompt + userMessage render in fenced code blocks (injection-safe)",
	);

	it.todo("error outcome: '**Outcome**: error — `Name: message`'");
});
