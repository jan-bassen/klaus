/**
 * `pipeline/message.ts` — `parseMessage`: STT apply, `@agent` extract,
 * `!overrides` strip, command parse, voice transcript rewriting.
 *
 * Mocks `src/pipeline/media.ts` so transcribe / parseDocument are spies and no
 * real network or disk work happens. Override registry is populated manually
 * via `loadOverrides` against the bundled vault yaml.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeMock = vi.hoisted(() => vi.fn());
const parseDocumentMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/pipeline/media.ts", () => ({
	transcribe: transcribeMock,
	parseDocument: parseDocumentMock,
	isParseableDocument: (mime: string) => mime === "application/pdf",
}));

import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import { parseMessage } from "../../src/pipeline/message.ts";
import {
	type OverrideDef,
	overrideRegistry,
} from "../../src/pipeline/overrides.ts";

function regOv(def: OverrideDef): void {
	overrideRegistry.set(def.name, def);
	for (const a of def.aliases ?? []) overrideRegistry.set(a, def);
}

function baseMsg(text: string): InboundMessage {
	return {
		kind: "whatsapp",
		id: "m-1",
		chatId: "c1",
		senderId: "s1",
		text,
		timestamp: new Date(),
		messageKey: {},
	};
}

beforeEach(() => {
	transcribeMock.mockReset();
	parseDocumentMock.mockReset();
	regOv({
		name: "voice",
		aliases: ["v"],
		description: "",
		overrides: { forceVoice: true },
	});
	regOv({
		name: "large",
		aliases: ["l"],
		description: "",
		overrides: { modelTier: "large" },
	});
});

describe("pipeline/message.parseMessage: text", () => {
	it("plain text: no agent, no overrides, cleanText === text", async () => {
		const r = await parseMessage(baseMsg("hello there"), new Set(), []);
		expect(r.cleanText).toBe("hello there");
		expect(r.agent).toBeUndefined();
		expect(r.overrides).toEqual({});
		expect(r.command).toBeUndefined();
	});

	it("@name extracts agent and trims it from cleanText", async () => {
		const r = await parseMessage(baseMsg("@fitness do thing"), new Set(), []);
		expect(r.agent).toBe("fitness");
		expect(r.cleanText).toBe("do thing");
	});

	it("@name-with-dash supports hyphenated names", async () => {
		const r = await parseMessage(baseMsg("@bug-bot ping"), new Set(), []);
		expect(r.agent).toBe("bug-bot");
		expect(r.cleanText).toBe("ping");
	});

	it("@name + !voice extracts both, leaves cleanText", async () => {
		const r = await parseMessage(
			baseMsg("@fitness !voice hello"),
			new Set(),
			[],
		);
		expect(r.agent).toBe("fitness");
		expect(r.overrides).toEqual({ voice: true });
		expect(r.cleanText).toBe("hello");
	});

	it("multiple !overrides without agent", async () => {
		const r = await parseMessage(baseMsg("!voice !large hello"), new Set(), []);
		expect(r.overrides).toEqual({ voice: true, large: true });
		expect(r.cleanText).toBe("hello");
	});

	it("unknown !word stays in cleanText", async () => {
		const r = await parseMessage(baseMsg("!unknown hi"), new Set(), []);
		expect(r.cleanText).toBe("!unknown hi");
		expect(r.overrides).toEqual({});
	});

	it("/command short-circuits: returns command, no agent or overrides parsed", async () => {
		const r = await parseMessage(
			baseMsg("/foo bar baz @fitness !voice"),
			new Set(),
			[],
		);
		expect(r.command).toEqual({
			name: "foo",
			args: ["bar", "baz", "@fitness", "!voice"],
		});
		expect(r.agent).toBeUndefined();
		expect(r.overrides).toEqual({});
	});
});

describe("pipeline/message.parseMessage: STT", () => {
	it("audio media: transcribe replaces text and stashes voiceCaption + transcription", async () => {
		transcribeMock.mockResolvedValue("hello from voice");
		const msg: InboundMessage = {
			...baseMsg("typed caption"),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(), []);
		expect(r.msg.text).toBe("hello from voice");
		expect(r.msg.media?.transcription).toBe("hello from voice");
		expect(r.msg.media?.voiceCaption).toBe("typed caption");
	});

	it("transcription error: original caption preserved", async () => {
		transcribeMock.mockResolvedValue(new Error("boom"));
		const msg: InboundMessage = {
			...baseMsg("caption"),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(), []);
		expect(r.msg.text).toBe("caption");
		expect(r.msg.media?.transcription).toBeUndefined();
	});
});

describe("pipeline/message.parseMessage: documents", () => {
	it("parseable doc: extractedText attached", async () => {
		parseDocumentMock.mockResolvedValue("doc body");
		const msg: InboundMessage = {
			...baseMsg("look at this"),
			media: { fileId: "f", path: "/tmp/x.pdf", mimeType: "application/pdf" },
		};
		const r = await parseMessage(msg, new Set(), []);
		expect(r.msg.media?.extractedText).toBe("doc body");
	});

	it("parse error: extractedText stays undefined", async () => {
		parseDocumentMock.mockResolvedValue(new Error("parse failed"));
		const msg: InboundMessage = {
			...baseMsg("look"),
			media: { fileId: "f", path: "/tmp/x.pdf", mimeType: "application/pdf" },
		};
		const r = await parseMessage(msg, new Set(), []);
		expect(r.msg.media?.extractedText).toBeUndefined();
	});

	it("non-parseable mime: parseDocument not called", async () => {
		const msg: InboundMessage = {
			...baseMsg("look"),
			media: { fileId: "f", path: "/tmp/x.png", mimeType: "image/png" },
		};
		await parseMessage(msg, new Set(), []);
		expect(parseDocumentMock).not.toHaveBeenCalled();
	});
});

describe("pipeline/message.parseMessage: voice transcript rewriting", () => {
	it("trigger prefix: 'hey fitness, help me' → '@fitness help me'", async () => {
		transcribeMock.mockResolvedValue("hey fitness, help me");
		const msg: InboundMessage = {
			...baseMsg(""),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(["fitness"]), ["hey"]);
		expect(r.agent).toBe("fitness");
		expect(r.cleanText).toBe("help me");
	});

	it("bare-name comma: 'fitness, help me' → '@fitness help me'", async () => {
		transcribeMock.mockResolvedValue("fitness, help me");
		const msg: InboundMessage = {
			...baseMsg(""),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(["fitness"]), ["hey"]);
		expect(r.agent).toBe("fitness");
		expect(r.cleanText).toBe("help me");
	});

	it("unknown agent after trigger: text unchanged", async () => {
		transcribeMock.mockResolvedValue("hey unknown, do thing");
		const msg: InboundMessage = {
			...baseMsg(""),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(["fitness"]), ["hey"]);
		expect(r.agent).toBeUndefined();
		expect(r.cleanText).toContain("hey unknown");
	});

	it("no trigger, no comma: unchanged (conservative)", async () => {
		transcribeMock.mockResolvedValue("fitness help me please");
		const msg: InboundMessage = {
			...baseMsg(""),
			media: { fileId: "f", path: "/tmp/x.ogg", mimeType: "audio/ogg" },
		};
		const r = await parseMessage(msg, new Set(["fitness"]), ["hey"]);
		expect(r.agent).toBeUndefined();
	});
});
