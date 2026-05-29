/**
 * `pipeline/reports.ts` — `emitReport` build + write paths.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
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
	let savedTemplatesDir: string;
	let savedReportsDir: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedTemplatesDir = settings.vault.templatesDir;
		savedReportsDir = settings.vault.reportsDir;
		settings.vault.templatesDir = path.join(tmp, "templates");
		settings.vault.reportsDir = path.join(tmp, "vault-reports");
		mkdirSync(settings.vault.templatesDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.templatesDir, "report.md"),
			readFileSync(path.resolve("vault/templates/report.md"), "utf-8"),
		);
		invalidateTemplate("report");
	});

	afterEach(() => {
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

		const markdown = readOnlyReport();
		expect(markdown).toContain("**Agent**: `test`");
		expect(markdown).toContain("**Run**: `");
		expect(markdown).toContain("**Outcome**: ok");
		expect(markdown).toContain("**Tokens**: 100 in / 50 out");
		expect(markdown).toContain("time, user");
		expect(markdown).toContain("send_message");
		expect(markdown).toContain("openrouter:web_search");
		expect(markdown).toContain("vault");
		expect(markdown).toContain("obsidian-markdown");
		expect(markdown).toContain("you are a helpful agent");
		expect(markdown).toContain("hello");
		expect(markdown).toContain("earlier");
		expect(markdown).toContain("**Overrides**: voice");
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

		const markdown = readOnlyReport();
		expect(markdown).toContain(
			'`{"asVoiceNote":true,"text":"long spoken answer"}`',
		);
	});

	it("writes tool results into markdown report steps", async () => {
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

		const markdown = readOnlyReport();
		expect(markdown).toContain("**Tool call: run_agent**");
		expect(markdown).toContain("**Tool result: run_agent**");
		expect(markdown).toContain("child result");
	});

	it("writes server tool usage and citations into markdown report steps", async () => {
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

		const markdown = readOnlyReport();
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

		const markdown = readOnlyReport();
		expect(markdown).not.toContain("AAAABBBB");
		expect(markdown).not.toContain("CCCCDDDD");
		expect(markdown).toContain("[base64 data URL omitted from report]");
	});

	it("error path: outcome is { kind: 'error' } with name+message", async () => {
		const turn: TurnContext = makeTurn();
		const err = new TypeError("boom");

		await emitReport({
			turn,
			startedAt: Date.now(),
			error: err,
		});

		const markdown = readOnlyReport();
		expect(markdown).toContain("**Outcome**: error");
		expect(markdown).toContain("`TypeError: boom`");
		expect(markdown).not.toContain("### Steps");
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

		const markdown = readOnlyReport();
		expect(markdown).toContain("**Config**: openai/large, history agent/20");
	});
});

function readOnlyReport(): string {
	const [dateDir] = readdirSync(settings.vault.reportsDir);
	if (!dateDir) throw new Error("Missing report date directory");
	const reportDir = path.join(settings.vault.reportsDir, dateDir);
	const files = readdirSync(reportDir);
	expect(files).toHaveLength(1);
	const [filename] = files;
	if (!filename) throw new Error("Missing report file");
	return readFileSync(path.join(reportDir, filename), "utf-8");
}
