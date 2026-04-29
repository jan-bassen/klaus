/**
 * `pipeline/reports.ts` — `emitReport` build + write paths.
 *
 * Distinct from `test/infra/store/report.test.ts`, which tests the JSONL
 * round-trip primitive. Here we test the report *builder*: how a full
 * `TurnContext` + `AgentRunResult` collapse into the JSONL entry, including
 * the `short` vs `full` level split, simulation tagging, and the never-throws
 * contract on the error path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { getOverlay } from "../../src/infra/simulation.ts";
import { initReportStore, readReports } from "../../src/infra/store/report.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import type { AgentRunResult, TurnContext } from "../../src/pipeline/core.ts";
import { emitReport } from "../../src/pipeline/reports.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";
import { makeTurn } from "../helpers/turn.ts";

function makeResult(patch: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		usage: { promptTokens: 100, completionTokens: 50 },
		durationMs: 1234,
		steps: [
			{
				reasoning: "let me think",
				toolCalls: [
					{ toolCallId: "t1", toolName: "reply", args: { content: "hi" } },
				],
				toolResults: [{ toolCallId: "t1", toolName: "reply", result: "sent" }],
				finishReason: "tool_calls",
				usage: { inputTokens: 100, outputTokens: 50 },
			},
		],
		model: "openrouter/auto",
		tier: "medium",
		historyMessages: [{ role: "user", content: "earlier" }],
		systemPrompt: "you are a helpful agent",
		userMessage: "hello",
		replyContent: "hi",
		...patch,
	};
}

describe("pipeline/reports: emitReport", () => {
	let tmp: string;
	let savedVaultMarkdown: boolean;

	beforeEach(() => {
		tmp = makeTmpDir();
		initReportStore({ dataDir: tmp });
		savedVaultMarkdown = settings.reports.vaultMarkdown;
		settings.reports.vaultMarkdown = false; // skip markdown mirror in tests
	});

	afterEach(() => {
		settings.reports.vaultMarkdown = savedVaultMarkdown;
		rmTmpDir(tmp);
	});

	it("short level: writes LLM section but omits message + variables + verbatim prompts", async () => {
		const turn: TurnContext = makeTurn({ vars: { user: { name: "Jan" } } });
		const startedAt = Date.now() - 50;

		await emitReport({
			turn,
			startedAt,
			level: "short",
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry).toBeDefined();
		expect(entry?.level).toBe("short");
		expect(entry?.outcome).toEqual({ kind: "ok" });
		expect(entry?.llm?.model).toBe("openrouter/auto");
		expect(entry?.llm?.usage.promptTokens).toBe(100);
		expect(entry?.llm?.systemPromptChars).toBe(
			"you are a helpful agent".length,
		);
		// Verbatim fields are FULL-only.
		expect(entry?.llm?.systemPrompt).toBeUndefined();
		expect(entry?.llm?.userMessage).toBeUndefined();
		expect(entry?.llm?.historyTranscript).toBeUndefined();
		expect(entry?.message).toBeUndefined();
		expect(entry?.variablesSummary).toBeUndefined();
	});

	it("full level: includes verbatim prompts, message metadata, and variables summary", async () => {
		const message: InboundMessage = {
			kind: "whatsapp",
			id: "m-42",
			chatId: "c1",
			senderId: "s1",
			text: "hello",
			media: { fileId: "f1", path: "/x", mimeType: "image/png" },
			timestamp: new Date(),
			messageKey: {},
		};
		const turn: TurnContext = makeTurn({
			message,
			vars: { user: { name: "Jan" }, time: { hour: 9 } },
			overrides: { voice: true },
		});

		await emitReport({
			turn,
			startedAt: Date.now() - 10,
			level: "full",
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.level).toBe("full");
		expect(entry?.llm?.systemPrompt).toBe("you are a helpful agent");
		expect(entry?.llm?.userMessage).toBe("hello");
		expect(entry?.llm?.historyTranscript).toHaveLength(1);
		expect(entry?.message?.externalId).toBe("m-42");
		expect(entry?.message?.text).toBe("hello");
		expect(entry?.message?.hasMedia).toBe(true);
		expect(entry?.message?.mediaType).toBe("image/png");
		expect(entry?.variablesSummary).toBeDefined();
		expect(entry?.variablesSummary?.user).toBeGreaterThan(0);
		expect(entry?.overrides).toEqual(["voice"]);
	});

	it("error path: outcome is { kind: 'error' } with name+message", async () => {
		const turn: TurnContext = makeTurn();
		const err = new TypeError("boom");

		await emitReport({
			turn,
			startedAt: Date.now(),
			level: "short",
			error: err,
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.outcome).toEqual({
			kind: "error",
			error: { name: "TypeError", message: "boom" },
		});
		// No llm section since result was not provided.
		expect(entry?.llm).toBeUndefined();
	});

	it("simulate: tags entry and includes overlay actions", async () => {
		const turn: TurnContext = makeTurn({
			config: { simulate: true },
		});
		const overlay = getOverlay(turn);
		overlay.actions.push({
			tool: "reply",
			sideEffect: "external",
			args: { content: "hi" },
			intent: 'Would reply: "hi"',
			result: "sent",
		});

		await emitReport({
			turn,
			startedAt: Date.now(),
			level: "short",
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.simulation).toBe(true);
		expect(entry?.simulatedActions).toHaveLength(1);
		expect(entry?.simulatedActions?.[0]?.tool).toBe("reply");
	});

	it("never throws — corrupt overlay / missing fields are swallowed", async () => {
		// Pass a turn whose message is missing required fields; emitReport should
		// either succeed or quietly warn, but must not throw.
		const turn: TurnContext = makeTurn({
			// Force a serialization edge: a circular var.
			vars: (() => {
				const v: Record<string, unknown> = {};
				v.self = v;
				return v;
			})(),
		});

		await expect(
			emitReport({
				turn,
				startedAt: Date.now(),
				level: "full",
				result: makeResult(),
			}),
		).resolves.toBeUndefined();
	});

	it("config picks only declared keys", async () => {
		const turn: TurnContext = makeTurn({
			config: {
				provider: "openai",
				modelTier: "large",
				historyLimit: 20,
				historyScope: "agent",
				showTrace: true,
				report: "full",
				// extra junk that should NOT leak into the entry
				simulate: false,
			},
		});

		await emitReport({
			turn,
			startedAt: Date.now(),
			level: "short",
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.config).toEqual({
			provider: "openai",
			modelTier: "large",
			historyLimit: 20,
			historyScope: "agent",
			showTrace: true,
			report: "full",
		});
	});
});
