/**
 * `pipeline/message.ts` — `parseMessage`: STT apply, `@agent` extract,
 * `!overrides` strip, command parse, voice transcript rewriting.
 *
 * This is the first mile of the pipeline — regressions here break routing
 * for every downstream phase.
 *
 * Setup:
 *   - Mock `@/pipeline/media` so `transcribe`, `parseDocument`, and
 *     `fetchWebContent` are spies returning canned values. No real network /
 *     disk work.
 *   - `parseOverrides` / `stripOverrides` come from `@/pipeline/overrides` and
 *     depend on the live `overrideRegistry`. Either preload
 *     `Klaus/overrides.yml` via `loadOverrides()` once in beforeAll, or
 *     register a minimal handful manually (`register("voice")`, `register("large")`).
 *   - `parseCommand` comes from `@/primitives/commands`. Register a dummy
 *     command so `/foo` is recognised; otherwise commands always parse as
 *     `undefined` and you can't exercise the short-circuit branch.
 */

import { beforeEach, describe, it } from "vitest";

// import { parseMessage } from "@/pipeline/message";
// import type { InboundMessage } from "@/infra/whatsapp/receive";

describe("pipeline/message.parseMessage: text messages", () => {
	beforeEach(() => {
		// register("voice"), register("large"), registerCommand("foo")
	});

	it.todo(
		"plain text: no agent, no overrides, cleanText === text",
	);

	it.todo(
		"`@name do thing` → agent === 'name', cleanText === 'do thing'",
	);

	it.todo(
		"`@name-with-dash ...` supports dashes in the name regex",
	);

	it.todo(
		"`@name !voice hello` → agent + overrides:{voice:true}, cleanText === 'hello'",
	);

	it.todo(
		"`!voice !large hello` with no agent → overrides both set, cleanText === 'hello'",
	);

	it.todo(
		"unknown `!unknown` word stays in cleanText (parseOverrides only extracts recognised)",
	);

	it.todo(
		"`/foo bar baz` → command:{name:'foo', args:['bar','baz']}, other fields absent",
	);

	it.todo(
		"`/foo` at start short-circuits before @agent or !overrides extraction",
	);
});

describe("pipeline/message.parseMessage: normalize (STT)", () => {
	it.todo(
		"audio/* media: transcribe() called; msg.text replaced with transcript",
	);

	it.todo(
		"voice note: original typed caption preserved as msg.media.voiceCaption",
	);

	it.todo(
		"voice note: msg.media.transcription === raw transcript (pre-rewrite)",
	);

	it.todo(
		"transcription error: logged and skipped — msg.text keeps original caption",
	);
});

describe("pipeline/message.parseMessage: normalize (documents)", () => {
	it.todo(
		"parseable doc: extractedText attached to msg.media.extractedText",
	);

	it.todo(
		"parse error: msg.media.extractedText stays undefined (no throw)",
	);

	it.todo(
		"non-parseable mime: parseDocument not called, extractedText absent",
	);
});

describe("pipeline/message.parseMessage: normalize (links)", () => {
	it.todo(
		"URLs in text: fetchWebContent called for up to settings.media.web.maxUrls, results attached to msg.links",
	);

	it.todo(
		"failed fetches: logged and dropped — only successful links appear in msg.links",
	);

	it.todo(
		"no URLs: msg.links stays absent (no empty array)",
	);
});

describe("pipeline/message.parseMessage: voice transcript rewriting", () => {
	it.todo(
		"trigger prefix: 'hey fitness, help me' with trigger 'hey' → '@fitness help me'",
	);

	it.todo(
		"bare name comma: 'fitness, help me' → '@fitness help me'",
	);

	it.todo(
		"unknown name after trigger: 'hey unknown, do' → unchanged",
	);

	it.todo(
		"no trigger, no comma: 'fitness help me' → unchanged (conservative)",
	);

	it.todo(
		"rewrite runs BEFORE overrides/agent parsing (rewritten @name is picked up)",
	);
});
