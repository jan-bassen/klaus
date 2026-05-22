import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readText } from "../../../src/infra/runtime.ts";
import {
	type AgentDefinition,
	agentRegistry,
	loadAgentDefinition,
	setDefaultAgent,
} from "../../../src/pipeline/agents.ts";
import { voiceCommand } from "../../../src/primitives/commands/voice.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

const AGENT_PROMPT = `---
name: coach
voice: off
---
You are coach.`;

function inbound(id: string, chatId = "c1") {
	return {
		kind: "whatsapp" as const,
		id,
		chatId,
		senderId: "s1",
		text: "/voice",
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("primitives/commands/voice", () => {
	let tmp: string;
	let def: AgentDefinition;
	beforeEach(async () => {
		tmp = makeTmpDir();
		const promptPath = path.join(tmp, "coach.md");
		writeFileSync(promptPath, AGENT_PROMPT);
		def = await loadAgentDefinition(promptPath);
		agentRegistry.set("coach", def);
		setDefaultAgent("c1", "coach");
		enqueueMock.mockReset();
	});

	afterEach(() => {
		setDefaultAgent("c1", null);
		agentRegistry.delete("coach");
		rmTmpDir(tmp);
	});

	it("with no args, reports the current voice setting", async () => {
		await voiceCommand.execute(inbound("m1"), []);
		expect(enqueueMock).toHaveBeenCalledTimes(1);
		expect(enqueueMock.mock.calls[0]?.[0].content).toBe("@coach voice: *off*");
	});

	it("rejects unknown values without mutating", async () => {
		await voiceCommand.execute(inbound("m2"), ["loud"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Unknown voice/);
		expect(def.settings.voice).toBe("off");
		// File on disk unchanged.
		const onDisk = await readText(def.promptPath);
		expect(onDisk).toContain("voice: off");
	});

	it("noop reply when target value equals current", async () => {
		await voiceCommand.execute(inbound("m3"), ["off"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/already set/);
		expect(def.settings.voice).toBe("off");
	});

	it("sets a valid mode: writes frontmatter to disk + updates registry in-memory", async () => {
		await voiceCommand.execute(inbound("m4"), ["on"]);

		// Confirmation message
		expect(enqueueMock.mock.calls[0]?.[0].content).toBe(
			"@coach voice set to *on*.",
		);
		// In-memory registry mutated
		expect(def.settings.voice).toBe("on");
		// Disk written through updateFrontmatter
		const onDisk = await readText(def.promptPath);
		expect(onDisk).toContain("voice: on");
		// Body preserved
		expect(onDisk).toContain("You are coach.");
	});

	it("accepts 'auto' as a valid mode", async () => {
		await voiceCommand.execute(inbound("m5"), ["auto"]);
		expect(def.settings.voice).toBe("auto");
	});

	it("case-insensitive value: 'ON' is normalised to 'on'", async () => {
		await voiceCommand.execute(inbound("m6"), ["ON"]);
		expect(def.settings.voice).toBe("on");
	});

	it("reports an error when the default agent is missing from the registry", async () => {
		agentRegistry.delete("coach");
		await voiceCommand.execute(inbound("m7"), ["on"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/not found/);
	});
});
