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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "@/types";

const mockEnqueueMessage = mock((_opts: unknown) => undefined);
mock.module("@/whatsapp/send", () => ({ enqueueMessage: mockEnqueueMessage }));

const mockGetActiveJobs = mock(() => [] as unknown[]);
mock.module("@/agent/queue", () => ({
	getActiveJobs: mockGetActiveJobs,
}));

import { _resetDefaultsForTest, setDefaultAgent } from "@/agent";
import { statusCommand } from "@/commands/status";

let tmpVault: string;
let savedVaultDir: string | undefined;

beforeAll(async () => {
	tmpVault = await mkdtemp(join(tmpdir(), "status-vault-"));
	await writeFile(join(tmpVault, "note1.md"), "# Note 1");
	await writeFile(join(tmpVault, "note2.md"), "# Note 2");
	savedVaultDir = process.env.VAULT_DIR;
	process.env.VAULT_DIR = tmpVault;
});

afterAll(async () => {
	if (savedVaultDir !== undefined) process.env.VAULT_DIR = savedVaultDir;
	else delete process.env.VAULT_DIR;
	await rm(tmpVault, { recursive: true, force: true });
});

function makeMsg(chatId = "user@s.whatsapp.net"): InboundMessage {
	return {
		kind: "whatsapp",
		id: crypto.randomUUID(),
		chatId,
		senderId: chatId,
		timestamp: new Date(),
		messageKey: {},
	};
}

beforeEach(() => {
	mockEnqueueMessage.mockClear();
	mockGetActiveJobs.mockClear();
	mockGetActiveJobs.mockImplementation(() => []);
	_resetDefaultsForTest();
});

afterEach(() => {
	_resetDefaultsForTest();
});

describe("/status", () => {
	test("uses getDefaultAgent override when set", async () => {
		const msg = makeMsg();
		setDefaultAgent(msg.chatId, "thinking");
		await statusCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@thinking");
	});

	test("sends error fallback when store throws", async () => {
		mockGetActiveJobs.mockImplementation(() => {
			throw new Error("Store down");
		});

		const msg = makeMsg();
		await statusCommand.execute(msg, []);

		const { content } = (
			mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/unavailable/i);
	});
});
