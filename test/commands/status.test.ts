import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import type { InboundMessage } from "@/types";

const mocks = vi.hoisted(() => ({
	mockEnqueueMessage: vi.fn((_opts: unknown) => undefined),
	mockGetActiveJobs: vi.fn(() => [] as unknown[]),
}));

vi.mock("@/whatsapp/send", () => ({
	enqueueMessage: mocks.mockEnqueueMessage,
}));

vi.mock("@/agent/queue", () => ({
	getActiveJobs: mocks.mockGetActiveJobs,
}));

import { setDefaultAgent } from "@/agent/definitions";
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
	mocks.mockEnqueueMessage.mockClear();
	mocks.mockGetActiveJobs.mockClear();
	mocks.mockGetActiveJobs.mockImplementation(() => []);
	// test/setup.ts already installs fresh services → fresh defaultAgents registry
});

describe("/status", () => {
	test("uses getDefaultAgent override when set", async () => {
		const msg = makeMsg();
		setDefaultAgent(msg.chatId, "thinking");
		await statusCommand.execute(msg, []);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toContain("@thinking");
	});

	test("sends error fallback when store throws", async () => {
		mocks.mockGetActiveJobs.mockImplementation(() => {
			throw new Error("Store down");
		});

		const msg = makeMsg();
		await statusCommand.execute(msg, []);

		const { content } = (
			mocks.mockEnqueueMessage.mock.calls[0] as [{ content: string }]
		)[0];
		expect(content).toMatch(/unavailable/i);
	});
});
