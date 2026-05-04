/**
 * `primitives/commands/default.ts` — set per-chat default agent, lazy-loading
 * from disk on registry miss.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import {
	agentRegistry,
	getDefaultAgent,
} from "../../../src/pipeline/agents.ts";
import { defaultCommand } from "../../../src/primitives/commands/default.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

function inbound(id: string) {
	return {
		kind: "whatsapp" as const,
		id,
		chatId: "c1",
		senderId: "s1",
		text: "/default",
		timestamp: new Date(),
		messageKey: {},
	};
}

const PROMPT = `---
name: coach
---
body`;

describe("primitives/commands/default", () => {
	let tmp: string;
	let savedAgentsDir: string;

	beforeEach(() => {
		tmp = makeTmpDir();
		savedAgentsDir = settings.vault.agentsDir;
		settings.vault.agentsDir = tmp;
		enqueueMock.mockReset();
	});

	afterEach(() => {
		settings.vault.agentsDir = savedAgentsDir;
		agentRegistry.delete("coach");
		agentRegistry.delete("preloaded");
		rmTmpDir(tmp);
	});

	it("missing arg → usage hint", async () => {
		await defaultCommand.execute(inbound("m1"), []);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Usage: \/default/);
	});

	it("agent already in registry → set default", async () => {
		agentRegistry.set("preloaded", {
			name: "preloaded",
			aliases: [],
			tools: [],
			toolsets: [],
			providerTools: [],
			skills: [],
			settings: {},
			promptPath: "/tmp/none.md",
		} as unknown as Parameters<typeof agentRegistry.set>[1]);

		await defaultCommand.execute(inbound("m2"), ["preloaded"]);
		expect(getDefaultAgent("c1")).toBe("preloaded");
		expect(enqueueMock.mock.calls[0]?.[0].content).toBe(
			"Default agent set to @preloaded.",
		);
	});

	it("registry miss → loads from disk under settings.vault.agentsDir", async () => {
		writeFileSync(path.join(tmp, "coach.md"), PROMPT);
		await defaultCommand.execute(inbound("m3"), ["coach"]);
		expect(getDefaultAgent("c1")).toBe("coach");
		expect(agentRegistry.has("coach")).toBe(true);
		expect(enqueueMock.mock.calls[0]?.[0].content).toBe(
			"Default agent set to @coach.",
		);
	});

	it("registry miss + missing file → error reply, default unchanged", async () => {
		const before = getDefaultAgent("c1");
		await defaultCommand.execute(inbound("m4"), ["nonexistent"]);
		expect(getDefaultAgent("c1")).toBe(before);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Unknown agent/);
	});
});
