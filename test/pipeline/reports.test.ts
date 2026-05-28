/**
 * `pipeline/reports.ts` — `emitReport` build + write paths.
 *
 * Distinct from `test/infra/store/report.test.ts`, which tests the per-file
 * round-trip primitive. Here we test the report *builder*: how a full
 * `TurnContext` + `AgentRunResult` collapse into the report entry, including
 * the never-throws contract on the error path.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import { initReportStore, readReports } from "../../src/infra/store/report.ts";
import type { InboundMessage } from "../../src/infra/whatsapp/receive.ts";
import type { AgentRunResult, TurnContext } from "../../src/pipeline/core.ts";
import { emitReport } from "../../src/pipeline/reports.ts";
import { invalidateTemplate } from "../../src/pipeline/templates.ts";
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
					{ toolCallId: "t1", toolName: "send_message", args: { text: "hi" } },
				],
				toolResults: [
					{ toolCallId: "t1", toolName: "send_message", result: "sent" },
				],
				finishReason: "tool_calls",
				usage: { inputTokens: 100, outputTokens: 50 },
			},
		],
		model: "openrouter/auto",
		tier: "medium",
		context: {
			variables: ["time", "user"],
			tools: ["send_message"],
			serverTools: ["openrouter:web_search"],
			toolsets: ["vault"],
			skills: ["obsidian-markdown"],
		},
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
	let savedTemplatesDir: string;
	let savedReportsDir: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		initReportStore({ dataDir: tmp });
		savedVaultMarkdown = settings.reports.vaultMarkdown;
		savedTemplatesDir = settings.vault.templatesDir;
		savedReportsDir = settings.vault.reportsDir;
		settings.reports.vaultMarkdown = false; // skip markdown mirror in tests
	});

	afterEach(() => {
		settings.reports.vaultMarkdown = savedVaultMarkdown;
		settings.vault.templatesDir = savedTemplatesDir;
		settings.vault.reportsDir = savedReportsDir;
		invalidateTemplate("report");
		rmTmpDir(tmp);
	});

	it("writes a full report with verbatim prompts, message metadata, and available context", async () => {
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
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.outcome).toEqual({ kind: "ok" });
		expect(entry?.llm?.model).toBe("openrouter/auto");
		expect(entry?.llm?.systemPrompt).toBe("you are a helpful agent");
		expect(entry?.llm?.userMessage).toBe("hello");
		expect(entry?.llm?.historyTranscript).toHaveLength(1);
		expect(entry?.message?.externalId).toBe("m-42");
		expect(entry?.message?.text).toBe("hello");
		expect(entry?.message?.hasMedia).toBe(true);
		expect(entry?.message?.mediaType).toBe("image/png");
		expect(entry?.llm?.context).toEqual({
			variables: ["time", "user"],
			tools: ["send_message"],
			serverTools: ["openrouter:web_search"],
			toolsets: ["vault"],
			skills: ["obsidian-markdown"],
		});
		expect(entry?.overrides).toEqual(["voice"]);
	});

	it("keeps send_message voice metadata before long text in report step args", async () => {
		const turn: TurnContext = makeTurn();

		await emitReport({
			turn,
			startedAt: Date.now() - 10,
			result: makeResult({
				steps: [
					{
						reasoning: "",
						toolCalls: [
							{
								toolCallId: "t1",
								toolName: "send_message",
								args: { text: "long spoken answer", asVoiceNote: true },
							},
						],
						toolResults: [
							{ toolCallId: "t1", toolName: "send_message", result: "sent" },
						],
					},
				],
			}),
		});

		const [entry] = await readReports({ days: 1 });
		expect(JSON.stringify(entry?.llm?.steps[0]?.toolCalls[0]?.args)).toBe(
			'{"asVoiceNote":true,"text":"long spoken answer"}',
		);
	});

	it("mirrors tool results into markdown report steps", async () => {
		settings.reports.vaultMarkdown = true;
		settings.vault.templatesDir = path.join(tmp, "templates");
		settings.vault.reportsDir = path.join(tmp, "vault-reports");
		mkdirSync(settings.vault.templatesDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.templatesDir, "report.md"),
			readFileSync(path.resolve("vault/templates/report.md"), "utf-8"),
		);
		invalidateTemplate("report");

		await emitReport({
			turn: makeTurn(),
			startedAt: Date.now() - 10,
			result: makeResult({
				steps: [
					{
						reasoning: "",
						toolCalls: [
							{
								toolCallId: "run-agent-1",
								toolName: "run_agent",
								args: { task: "check this" },
							},
						],
						toolResults: [
							{
								toolCallId: "run-agent-1",
								toolName: "run_agent",
								result: "child result",
							},
						],
					},
				],
			}),
		});

		const [dateDir] = readdirSync(settings.vault.reportsDir);
		const reportDir = path.join(settings.vault.reportsDir, dateDir ?? "");
		const [filename] = readdirSync(reportDir);
		const markdown = readFileSync(
			path.join(reportDir, filename ?? ""),
			"utf-8",
		);
		expect(markdown).toContain("**Tool call: run_agent**");
		expect(markdown).toContain("**Tool result: run_agent**");
		expect(markdown).toContain("child result");
	});

	it("mirrors server tool usage and citations into markdown report steps", async () => {
		settings.reports.vaultMarkdown = true;
		settings.vault.templatesDir = path.join(tmp, "templates");
		settings.vault.reportsDir = path.join(tmp, "vault-reports");
		mkdirSync(settings.vault.templatesDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.templatesDir, "report.md"),
			readFileSync(path.resolve("vault/templates/report.md"), "utf-8"),
		);
		invalidateTemplate("report");

		await emitReport({
			turn: makeTurn(),
			startedAt: Date.now() - 10,
			result: makeResult({
				steps: [
					{
						reasoning: "",
						toolCalls: [],
						toolResults: [],
						serverToolUse: { web_search_requests: 2 },
						citations: [
							{
								type: "url_citation",
								url: "https://example.com",
								title: "Example",
								content: "cited content",
								startIndex: 0,
								endIndex: 12,
							},
						],
					},
				],
			}),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.llm?.steps[0]).toMatchObject({
			serverToolUse: { web_search_requests: 2 },
			citations: [{ url: "https://example.com", title: "Example" }],
		});

		const [dateDir] = readdirSync(settings.vault.reportsDir);
		const reportDir = path.join(settings.vault.reportsDir, dateDir ?? "");
		const [filename] = readdirSync(reportDir);
		const markdown = readFileSync(
			path.join(reportDir, filename ?? ""),
			"utf-8",
		);
		expect(markdown).toContain("**Server tool use**");
		expect(markdown).toContain('"web_search_requests":2');
		expect(markdown).toContain("Example");
		expect(markdown).toContain("https://example.com");
	});

	it("redacts base64 data URLs from report prompts and history", async () => {
		const historyMessages: AgentRunResult["historyMessages"] = [
			{
				role: "user",
				content: [
					{
						type: "image_url",
						imageUrl: { url: "data:image/png;base64,AAAABBBB" },
					},
					{ type: "text", text: "earlier image" },
				],
			},
		];

		await emitReport({
			turn: makeTurn(),
			startedAt: Date.now(),
			result: makeResult({
				userMessage: "data:image/jpeg;base64,CCCCDDDD",
				historyMessages,
			}),
		});

		const [entry] = await readReports({ days: 1 });
		const encoded = JSON.stringify(entry);
		expect(encoded).not.toContain("AAAABBBB");
		expect(encoded).not.toContain("CCCCDDDD");
		expect(entry?.llm?.userMessage).toBe(
			"[base64 data URL omitted from report]",
		);
	});

	it("error path: outcome is { kind: 'error' } with name+message", async () => {
		const turn: TurnContext = makeTurn();
		const err = new TypeError("boom");

		await emitReport({
			turn,
			startedAt: Date.now(),
			error: err,
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.outcome).toEqual({
			kind: "error",
			error: { name: "TypeError", message: "boom" },
		});
		expect(entry?.llm).toBeUndefined();
	});

	it("never throws — corrupt overlay / missing fields are swallowed", async () => {
		const turn: TurnContext = makeTurn({
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
				showTools: true,
				report: true,
			},
		});

		await emitReport({
			turn,
			startedAt: Date.now(),
			result: makeResult(),
		});

		const [entry] = await readReports({ days: 1 });
		expect(entry?.config).toEqual({
			provider: "openai",
			modelTier: "large",
			historyLimit: 20,
			historyScope: "agent",
			showTools: true,
			report: true,
		});
	});
});
