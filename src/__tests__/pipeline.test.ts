import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, InboundMessage, TurnContext } from "@/types";

// ─── Mocks (must precede all imports of the modules under test) ───────────────

// @/whatsapp/send — keep mocked: no own test file, prevents actual sends
const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

// @/store/conversation — mock instead of real file I/O
const capturedAppendMessages: Record<string, unknown>[] = [];
const mockAppendMessage = mock(async (msg: unknown) => {
	capturedAppendMessages.push(msg as Record<string, unknown>);
	return "msg-id-1";
});
const mockFindByExternalId = mock(
	(_extId: string) => null as { messageId: string } | null,
);
mock.module("@/store/conversation", () => ({
	appendMessage: mockAppendMessage,
	appendAck: mock(async () => {}),
	appendReaction: mock(async () => {}),
	findByExternalId: mockFindByExternalId,
	resolveExternalId: mock(() => null),
	getConversation: mock(async () => []),
	rebuildIndexes: mock(async () => {}),
	_clearIndexesForTest: mock(() => {}),
}));

// @/store/files — mock file operations
const mockUpdateFileMessageId = mock(async () => undefined);
const mockFindFileByMessageId = mock(
	(_msgId: string) =>
		null as { fileId: string; path: string; mimeType: string } | null,
);
const mockFindFileByExternalId = mock(
	(_extId: string) =>
		null as { fileId: string; path: string; mimeType: string } | null,
);
mock.module("@/store/files", () => ({
	updateFileMessageId: mockUpdateFileMessageId,
	findFileByMessageId: mockFindFileByMessageId,
	findFileByExternalId: mockFindFileByExternalId,
	saveFileMeta: mock(async () => ({ id: "f-1", path: "/tmp/f" })),
	findFile: mock(() => null),
	listFiles: mock(() => []),
	deleteFile: mock(() => false),
	rebuildFileIndex: mock(async () => {}),
	_clearFileIndexForTest: mock(() => {}),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { registry } from "@/commands";
import { agentRegistry } from "@/core/agent";
import { setContextVariables } from "@/core/assemble";
import { flagRegistry } from "@/core/flags";
import {
	_clearAgentRunnerForTest,
	_setAgentRunnerForTest,
	handleTurn,
} from "@/core/pipeline";
import { _resetForTest, checkMessageRate } from "@/core/rate-limiter";
import { settings } from "@/settings";

// ─── Test seam — captures agent turns without mock.module pollution ──────────

const capturedTurns: TurnContext[] = [];
const mockAgentRunner = mock(
	async (turn: TurnContext, _def: AgentDefinition) => {
		capturedTurns.push(turn);
	},
);

// ─── Filesystem helpers ───────────────────────────────────────────────────────

const TEST_CHAT_ID = "user@s.whatsapp.net";

let tmpDir: string;
let fakeAudioPath: string;
let fakeImagePath: string;
let savedAllowedChatId: string | undefined;
let savedVaultDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
	fakeAudioPath = join(tmpDir, "audio.ogg");
	await writeFile(fakeAudioPath, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // OGG magic
	fakeImagePath = join(tmpDir, "photo.jpg");
	await writeFile(fakeImagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic

	const agentsDir = join(tmpDir, "vault", "Klaus", "agents");
	await mkdir(agentsDir, { recursive: true });
	const minimalFrontmatter = (name: string, tier: string) =>
		`---\nname: ${name}\nmodelTier: ${tier}\ntools: []\n---\n`;
	await writeFile(
		join(agentsDir, "klaus.md"),
		minimalFrontmatter("klaus", "medium"),
	);
	await writeFile(
		join(agentsDir, "thinking.md"),
		minimalFrontmatter("thinking", "large"),
	);
	savedVaultDir = process.env.VAULT_DIR;
	process.env.VAULT_DIR = join(tmpDir, "vault");

	savedAllowedChatId = process.env.ALLOWED_CHAT_ID;

	// Add test-only flags to the code-defined registry
	flagRegistry.set("verbose", {
		name: "verbose" as never,
		description: "verbose response",
	});
	flagRegistry.set("en", {
		name: "en" as never,
		description: "respond in English",
	});

	// Use no context variables so assembleContext always returns { vars: {}, totalTokens: 0 }
	setContextVariables([]);

	// Inject the agent runner test seam
	_setAgentRunnerForTest(mockAgentRunner);
});

afterAll(async () => {
	_clearAgentRunnerForTest();
	await rm(tmpDir, { recursive: true, force: true });
	if (savedAllowedChatId !== undefined) {
		process.env.ALLOWED_CHAT_ID = savedAllowedChatId;
	} else {
		delete process.env.ALLOWED_CHAT_ID;
	}
	if (savedVaultDir !== undefined) process.env.VAULT_DIR = savedVaultDir;
	else delete process.env.VAULT_DIR;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
	const base: InboundMessage = {
		kind: "whatsapp",
		id: "msg-1",
		chatId: TEST_CHAT_ID,
		senderId: TEST_CHAT_ID,
		text: "hello",
		timestamp: new Date(),
		messageKey: {},
	};
	return { ...base, ...overrides };
}

function lastTurn(): TurnContext {
	const turn = capturedTurns.at(-1);
	if (!turn) throw new Error("No captured turns");
	return turn;
}

beforeEach(() => {
	process.env.ALLOWED_CHAT_ID = TEST_CHAT_ID;
	_resetForTest();
	agentRegistry.clear();
	capturedTurns.length = 0;
	capturedAppendMessages.length = 0;

	mockAgentRunner.mockClear();
	mockEnqueueMessage.mockClear();
	mockAppendMessage.mockClear();
	mockUpdateFileMessageId.mockClear();
	mockFindByExternalId.mockClear();
	mockFindFileByMessageId.mockClear();
	mockFindFileByExternalId.mockClear();

	mockAppendMessage.mockImplementation(async (msg: unknown) => {
		capturedAppendMessages.push(msg as Record<string, unknown>);
		return "msg-id-1";
	});
	mockFindByExternalId.mockImplementation(() => null);
});

// ─── Auth + rate limiting ─────────────────────────────────────────────────────

describe("handleTurn — guards", () => {
	test("auth rejected: returns without calling runAgent", async () => {
		process.env.ALLOWED_CHAT_ID = "other@s.whatsapp.net";
		await handleTurn(makeMsg());
		expect(mockAgentRunner).not.toHaveBeenCalled();
	});

	test("rate limited: enqueues rate-limit message and skips runAgent", async () => {
		const msg = makeMsg();
		for (let i = 0; i < settings.rateLimits.messages.max; i++) {
			checkMessageRate(msg);
		}
		await handleTurn(msg);
		expect(mockAgentRunner).not.toHaveBeenCalled();
		expect(mockEnqueueMessage).toHaveBeenCalledTimes(1);
		const opts = (
			mockEnqueueMessage.mock.calls as unknown as [{ content: string }][]
		)[0]?.[0];
		expect(opts?.content).toMatch(/too many/i);
	});

	test("command dispatch: calls commandRegistry and skips runAgent", async () => {
		const mockExecute = mock(async () => undefined);
		registry.register({
			name: "test-dispatch",
			description: "Test",
			execute: mockExecute,
		});
		await handleTurn(makeMsg({ text: "/test-dispatch" }));
		expect(mockAgentRunner).not.toHaveBeenCalled();
		expect(mockExecute).toHaveBeenCalledTimes(1);
	});
});

// ─── Media normalization — audio ──────────────────────────────────────────────

describe("handleTurn — audio media", () => {
	let savedKey: string | undefined;
	let savedFetch: typeof globalThis.fetch;

	beforeEach(() => {
		savedKey = process.env.ELEVENLABS_API_KEY;
		savedFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
		else process.env.ELEVENLABS_API_KEY = savedKey;
		globalThis.fetch = savedFetch;
	});

	test("transcribes audio and passes transcript as message text", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key";
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ text: "hello world" }), { status: 200 }),
		) as unknown as typeof fetch;

		const msg = makeMsg({
			media: { fileId: "fid-1", path: fakeAudioPath, mimeType: "audio/ogg" },
		});
		delete (msg as Partial<InboundMessage>).text;
		await handleTurn(msg);
		expect(lastTurn().message?.text).toBe("hello world");
	});

	test("stores transcript as text and preserves caption in media.voiceCaption", async () => {
		process.env.ELEVENLABS_API_KEY = "test-key";
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ text: "audio transcript" }), {
					status: 200,
				}),
		) as unknown as typeof fetch;

		await handleTurn(
			makeMsg({
				text: "user caption",
				media: { fileId: "fid-1", path: fakeAudioPath, mimeType: "audio/ogg" },
			}),
		);
		expect(lastTurn().message?.text).toBe("audio transcript");
		expect(lastTurn().message?.media?.voiceCaption).toBe("user caption");
	});

	test("falls back to original message when transcription fails (no API key)", async () => {
		delete process.env.ELEVENLABS_API_KEY;
		await handleTurn(
			makeMsg({
				text: "original text",
				media: { fileId: "fid-1", path: fakeAudioPath, mimeType: "audio/ogg" },
			}),
		);
		expect(mockAgentRunner).toHaveBeenCalledTimes(1);
		expect(lastTurn().message?.text).toBe("original text");
	});
});

// ─── Media normalization — image / document ───────────────────────────────────

describe("handleTurn — image media", () => {
	test("does not call fetch/transcribe for images (vision handled by agent)", async () => {
		let fetchCalled = false;
		const savedFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			fetchCalled = true;
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		await handleTurn(
			makeMsg({
				text: "look at this",
				media: {
					fileId: "fid-2",
					path: "/tmp/photo.jpg",
					mimeType: "image/jpeg",
				},
			}),
		);
		globalThis.fetch = savedFetch;

		expect(fetchCalled).toBe(false);
		expect(mockAgentRunner).toHaveBeenCalledTimes(1);
	});

	test("preserves original text when image has a caption", async () => {
		await handleTurn(
			makeMsg({
				text: "caption text",
				media: {
					fileId: "fid-2",
					path: "/tmp/photo.png",
					mimeType: "image/png",
				},
			}),
		);
		expect(lastTurn().message?.text).toBe("caption text");
	});
});

describe("handleTurn — document media", () => {
	test("passes through document without text annotation", async () => {
		const msg = makeMsg({
			media: {
				fileId: "fid-3",
				path: "/tmp/.files/2024-01-01/abc.pdf",
				mimeType: "application/pdf",
			},
		});
		delete (msg as Partial<InboundMessage>).text;
		await handleTurn(msg);
		expect(lastTurn().message?.text || "").toBe("");
		expect(lastTurn().message?.media?.mimeType).toBe("application/pdf");
	});

	test("preserves existing caption for document without annotation", async () => {
		await handleTurn(
			makeMsg({
				text: "see attached",
				media: {
					fileId: "fid-3",
					path: "/tmp/.files/2024-01-01/report.docx",
					mimeType:
						"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				},
			}),
		);
		expect(lastTurn().message?.text).toBe("see attached");
	});
});

// ─── Agent routing ────────────────────────────────────────────────────────────

describe("handleTurn — agent routing", () => {
	test("routes to default agent (Klaus) when no @agent prefix", async () => {
		await handleTurn(makeMsg({ text: "just a normal message" }));
		expect(mockAgentRunner).toHaveBeenCalledTimes(1);
		expect(lastTurn().agent?.name).toBe("klaus");
	});

	test("@agent prefix routes to the named agent and strips prefix from text", async () => {
		await handleTurn(makeMsg({ text: "@thinking do some research" }));
		expect(lastTurn().agent?.name).toBe("thinking");
		expect(lastTurn().message?.text).toBe("do some research");
	});

	test("uses cached agent from registry without calling loadAgentDefinition", async () => {
		const cachedDef: AgentDefinition = {
			name: "__cached__",
			aliases: [],
			modelTier: "medium",
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			persistent: false,
			voiceMode: "auto",
			acceptMode: "off",
			promptPath: join(tmpDir, "vault", "Klaus", "agents", "thinking.md"),
		};
		agentRegistry.set("__cached__", cachedDef);
		await handleTurn(makeMsg({ text: "@__cached__ run it" }));
		expect(mockAgentRunner).toHaveBeenCalledTimes(1);
		expect(lastTurn().agent?.name).toBe("__cached__");
	});
});

// ─── File messageId backfill ──────────────────────────────────────────────────

describe("handleTurn — file messageId backfill", () => {
	test("calls updateFileMessageId with fileId and inserted messageId", async () => {
		mockAppendMessage.mockImplementation(async (msg: unknown) => {
			capturedAppendMessages.push(msg as Record<string, unknown>);
			return "db-msg-id";
		});
		await handleTurn(
			makeMsg({
				media: {
					fileId: "file-uuid-abc",
					path: fakeAudioPath,
					mimeType: "audio/ogg",
				},
			}),
		);
		expect(mockUpdateFileMessageId).toHaveBeenCalledTimes(1);
		const [fileId, messageId] = mockUpdateFileMessageId.mock
			.calls[0] as unknown as [string, string];
		expect(fileId).toBe("file-uuid-abc");
		expect(messageId).toBe("db-msg-id");
	});

	test("does not call updateFileMessageId when message has no media", async () => {
		const msg = makeMsg({ text: "plain text" });
		delete (msg as Partial<InboundMessage>).media;
		await handleTurn(msg);
		expect(mockUpdateFileMessageId).not.toHaveBeenCalled();
	});
});

// ─── Quoted message handling ──────────────────────────────────────────────────

describe("handleTurn — quoted messages", () => {
	test("calls findByExternalId when message is a reply", async () => {
		const msg = makeMsg({
			quotedMessage: { externalId: "baileys-id-xyz" },
		});
		await handleTurn(msg);
		expect(mockFindByExternalId).toHaveBeenCalledTimes(1);
		const [externalId] = mockFindByExternalId.mock.calls[0] as unknown as [
			string,
		];
		expect(externalId).toBe("baileys-id-xyz");
	});

	test("does not call findByExternalId when message has no quote", async () => {
		await handleTurn(makeMsg({ text: "plain message" }));
		expect(mockFindByExternalId).not.toHaveBeenCalled();
	});

	test("continues normally even when quoted message is not found (returns null)", async () => {
		mockFindByExternalId.mockImplementation(() => null);
		const msg = makeMsg({
			quotedMessage: { externalId: "old-id" },
		});
		await handleTurn(msg);
		expect(mockAgentRunner).toHaveBeenCalledTimes(1);
	});

	test("passes quotedMessage through to the agent turn", async () => {
		const quoted = { externalId: "id-abc" };
		await handleTurn(makeMsg({ text: "Yes of course", quotedMessage: quoted }));
		expect(lastTurn().message?.quotedMessage).toEqual(quoted);
	});

	test("falls back to findFileByExternalId when findByExternalId returns null (archived message)", async () => {
		mockFindByExternalId.mockImplementation(() => null);
		mockFindFileByExternalId.mockImplementation((extId: string) =>
			extId === "archived-ext-id"
				? {
						fileId: "file-archived",
						path: "/tmp/old-photo.jpg",
						mimeType: "image/jpeg",
					}
				: null,
		);

		await handleTurn(
			makeMsg({
				text: "look at this old photo",
				quotedMessage: { externalId: "archived-ext-id" },
			}),
		);

		expect(mockFindFileByExternalId).toHaveBeenCalledWith("archived-ext-id");
		expect(lastTurn().message?.quotedMessage?.media).toEqual({
			fileId: "file-archived",
			path: "/tmp/old-photo.jpg",
			mimeType: "image/jpeg",
		});
	});
});

// ─── Flags and command persistence ────────────────────────────────────────────

describe("handleTurn — flags persistence", () => {
	test("persists active flags as string array in the message", async () => {
		await handleTurn(makeMsg({ text: "@klaus !verbose !en hello" }));
		const vals = capturedAppendMessages[0];
		expect(vals?.flags).toEqual(expect.arrayContaining(["verbose", "en"]));
		expect((vals?.flags as string[]).length).toBe(2);
	});

	test("does not persist flags when no flags present", async () => {
		await handleTurn(makeMsg({ text: "hello" }));
		const vals = capturedAppendMessages[0];
		expect(vals?.flags).toBeUndefined();
	});
});

describe("handleTurn — command persistence", () => {
	test("persists command message with command name", async () => {
		const mockExecute = mock(async () => undefined);
		registry.register({
			name: "test-persist",
			description: "Test",
			execute: mockExecute,
		});
		await handleTurn(makeMsg({ text: "/test-persist arg1" }));
		expect(capturedAppendMessages).toHaveLength(1);
		const vals = capturedAppendMessages[0];
		expect(vals?.command).toBe("test-persist");
		expect(vals?.content).toBe("/test-persist arg1");
		expect(vals?.role).toBe("user");
	});

	test("command dispatch persists message before executing", async () => {
		const callOrder: string[] = [];
		mockAppendMessage.mockImplementation(async (msg: unknown) => {
			callOrder.push("store-append");
			capturedAppendMessages.push(msg as Record<string, unknown>);
			return "msg-id-1";
		});
		const mockExecute = mock(async () => {
			callOrder.push("command-execute");
		});
		registry.register({
			name: "test-order",
			description: "Test",
			execute: mockExecute,
		});
		await handleTurn(makeMsg({ text: "/test-order" }));
		expect(callOrder).toEqual(["store-append", "command-execute"]);
	});
});
