/**
 * `primitives/commands/model.ts` — `/model` and `/provider` show + switch the
 * default agent's model tier / provider, persisting to YAML frontmatter.
 */

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
import {
	modelCommand,
	providerCommand,
} from "../../../src/primitives/commands/model.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/whatsapp/send.ts", () => ({
	enqueueMessage: enqueueMock,
}));

const AGENT_PROMPT = `---
name: coach
settings:
  provider: claude
  modelTier: medium
---
body`;

function inbound(id: string) {
	return {
		kind: "whatsapp" as const,
		id,
		chatId: "c1",
		senderId: "s1",
		text: "/model",
		timestamp: new Date(),
		messageKey: {},
	};
}

describe("primitives/commands/model + provider", () => {
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

	it("/model with no args reports the resolved model id", async () => {
		await modelCommand.execute(inbound("m1"), []);
		const msg = enqueueMock.mock.calls[0]?.[0].content;
		expect(msg).toMatch(/@coach: \*.+\* \(claude \/ medium\)/);
	});

	it("/model rejects unknown tiers", async () => {
		await modelCommand.execute(inbound("m2"), ["xxl"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Unknown tier/);
		expect(def.settings.modelTier).toBe("medium");
	});

	it("/model noop when target tier equals current", async () => {
		await modelCommand.execute(inbound("m3"), ["medium"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Already on tier/);
	});

	it("/model writes new tier to frontmatter and updates the registry", async () => {
		await modelCommand.execute(inbound("m4"), ["large"]);
		expect(def.settings.modelTier).toBe("large");
		const onDisk = await readText(def.promptPath);
		expect(onDisk).toContain("modelTier: large");
		expect(onDisk).toContain("body");
	});

	it("/provider with no args reports the current provider", async () => {
		await providerCommand.execute(inbound("m5"), []);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(
			/@coach: \*claude\* \(medium → /,
		);
	});

	it("/provider rejects unknown providers", async () => {
		await providerCommand.execute(inbound("m6"), ["bogus"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Unknown provider/);
		expect(def.settings.provider).toBe("claude");
	});

	it("/provider switches provider and persists frontmatter", async () => {
		await providerCommand.execute(inbound("m7"), ["openai"]);
		expect(def.settings.provider).toBe("openai");
		const onDisk = await readText(def.promptPath);
		expect(onDisk).toContain("provider: openai");
		// modelTier untouched
		expect(onDisk).toContain("modelTier: medium");
	});

	it("/provider noop when target equals current", async () => {
		await providerCommand.execute(inbound("m8"), ["claude"]);
		expect(enqueueMock.mock.calls[0]?.[0].content).toMatch(/Already on/);
	});
});
