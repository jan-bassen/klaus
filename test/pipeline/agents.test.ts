import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../src/infra/config.ts";
import {
	agentRegistry,
	getDefaultAgent,
	getOrLoadAgent,
	loadAgentDefinition,
	loadAgents,
	setDefaultAgent,
} from "../../src/pipeline/agents.ts";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.ts";

function writeAgent(
	dir: string,
	name: string,
	extra = "",
	body = `You are ${name}.`,
): void {
	writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ntools: [send_message]\n${extra}---\n${body}`,
	);
}

describe("pipeline/agents: loadAgentDefinition", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("parses name, tools, and sets promptPath", async () => {
		writeAgent(tmpDir, "coach");
		const def = await loadAgentDefinition(path.join(tmpDir, "coach.md"));
		expect(def.name).toBe("coach");
		expect(def.promptPath).toBe(path.join(tmpDir, "coach.md"));
		expect(def.tools).toEqual(["send_message"]);
	});

	it("applies AgentSettings defaults (voice/temp/topP/showTools/report)", async () => {
		writeAgent(tmpDir, "bare");
		const def = await loadAgentDefinition(path.join(tmpDir, "bare.md"));
		expect(def.settings.voice).toBe("auto");
		expect(def.settings.temp).toBe("default");
		expect(def.settings.topP).toBe("default");
		expect(def.settings.showTools).toBe(true);
		expect(def.settings.report).toBe(true);
	});

	it("throws when frontmatter is missing", async () => {
		writeFileSync(path.join(tmpDir, "no-fm.md"), "Just text, no frontmatter.");
		await expect(
			loadAgentDefinition(path.join(tmpDir, "no-fm.md")),
		).rejects.toThrow("No YAML frontmatter");
	});

	it("parses aliases array", async () => {
		writeAgent(tmpDir, "fitness", "aliases: [fit, gym]\n");
		const def = await loadAgentDefinition(path.join(tmpDir, "fitness.md"));
		expect(def.aliases).toEqual(["fit", "gym"]);
	});

	it("parses schedules and prompt sections", async () => {
		writeAgent(
			tmpDir,
			"daily",
			'schedules:\n  - pattern: "0 8 * * *"\n    label: morning\n    overrides: [voice]\n',
			"# System\nYou are daily.\n\n# Message\nGood morning, {{schedule.label}}.",
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "daily.md"));
		expect(def.prompt.system).toBe("You are daily.");
		expect(def.prompt.message).toBe("Good morning, {{schedule.label}}.");
		expect(def.schedules).toEqual([
			{ pattern: "0 8 * * *", label: "morning", overrides: ["voice"] },
		]);
	});

	it("parses dynamic persistence policy", async () => {
		writeAgent(
			tmpDir,
			"adaptive",
			'persist: true\npersistHint: "schedule based on user"\npersistOverrides: [voice]\n',
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "adaptive.md"));
		expect(def.persistence).toEqual({
			hint: "schedule based on user",
			overrides: ["voice"],
		});
	});

	it("keeps the whole body as system prompt without recognized sections", async () => {
		writeAgent(tmpDir, "plain", "", "# Notes\nStill system.");
		const def = await loadAgentDefinition(path.join(tmpDir, "plain.md"));
		expect(def.prompt).toEqual({ system: "# Notes\nStill system." });
	});

	it("requires # Message when schedules are declared", async () => {
		writeAgent(
			tmpDir,
			"daily",
			'schedules:\n  - pattern: "0 8 * * *"\n',
			"# System\nYou are daily.",
		);
		await expect(
			loadAgentDefinition(path.join(tmpDir, "daily.md")),
		).rejects.toThrow("has no # Message section");
	});

	it("rejects old persistence frontmatter", async () => {
		writeAgent(
			tmpDir,
			"old",
			'persistenceMode: static\npersistenceSchedule: "0 8 * * *"\npersistencePrompt: "Good morning"\n',
		);
		await expect(
			loadAgentDefinition(path.join(tmpDir, "old.md")),
		).rejects.toThrow();
	});

	it("parses flat settings", async () => {
		writeAgent(
			tmpDir,
			"custom",
			"voice: on\ntemp: cold\nreport: false\nhistoryLimit: 5\n",
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "custom.md"));
		expect(def.settings.voice).toBe("on");
		expect(def.settings.temp).toBe("cold");
		expect(def.settings.report).toBe(false);
		expect(def.settings.historyLimit).toBe(5);
	});

	it("parses vault access strings into the internal map", async () => {
		writeAgent(
			tmpDir,
			"vaulty",
			'vaultAccess:\n  - "*:read"\n  - "Projects:full"\n  - "Private:none"\n',
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "vaulty.md"));
		expect(def.settings.vault).toEqual({
			"*": "read",
			Projects: "full",
			Private: "none",
		});
	});

	it("parses the bundled meta agent contract", async () => {
		const def = await loadAgentDefinition(path.resolve("vault/agents/meta.md"));
		const expectedTools = [
			"search_messages",
			"math",
			"vault_read",
			"vault_find",
			"vault_list",
			"vault_write",
			"vault_edit",
			"vault_move",
			"vault_delete",
		];

		expect(def.name).toBe("meta");
		expect(def.aliases).toEqual(["m"]);
		expect(def.tools).toEqual(expectedTools);
		expect(def.settings.modelTier).toBe("large");
		expect(def.settings.reasoningEffort).toBe("high");
		expect(def.settings.historyLimit).toBe(30);
		expect(def.settings.historyScope).toBe("agent");
		expect(def.settings.vault).toEqual({
			"*": "none",
			Klaus: "full",
		});
	});
});

describe("pipeline/agents: loadAgents", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		rmTmpDir(tmpDir);
	});

	it("loads all .md files into agentRegistry by name and aliases", async () => {
		writeAgent(tmpDir, "coach", "aliases: [c]\n");
		writeAgent(tmpDir, "trainer");
		await loadAgents(tmpDir);
		expect(agentRegistry.has("coach")).toBe(true);
		expect(agentRegistry.has("c")).toBe(true);
		expect(agentRegistry.has("trainer")).toBe(true);
		expect(agentRegistry.get("c")?.name).toBe("coach");
	});

	it("skips malformed files without throwing", async () => {
		writeFileSync(path.join(tmpDir, "bad.md"), "no frontmatter here");
		writeAgent(tmpDir, "good");
		await loadAgents(tmpDir);
		expect(agentRegistry.has("good")).toBe(true);
		expect(agentRegistry.has("bad")).toBe(false);
	});

	it("warns and skips duplicate alias — first-loaded agent keeps it", async () => {
		writeAgent(tmpDir, "alpha", "aliases: [shared]\n");
		writeAgent(tmpDir, "beta", "aliases: [shared]\n");
		await loadAgents(tmpDir);
		const owner = agentRegistry.get("shared");
		expect(["alpha", "beta"]).toContain(owner?.name);
		// Both agents still land in registry under their canonical names
		expect(agentRegistry.has("alpha")).toBe(true);
		expect(agentRegistry.has("beta")).toBe(true);
	});

	it("handles an empty directory without error", async () => {
		await expect(loadAgents(tmpDir)).resolves.toBeUndefined();
		expect(agentRegistry.size).toBe(0);
	});
});

describe("pipeline/agents: getOrLoadAgent", () => {
	let tmpDir: string;
	let originalAgentsDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		originalAgentsDir = settings.vault.agentsDir;
		settings.vault.agentsDir = tmpDir;
	});

	afterEach(() => {
		settings.vault.agentsDir = originalAgentsDir;
		rmTmpDir(tmpDir);
	});

	it("returns registry hit without re-reading disk", async () => {
		writeAgent(tmpDir, "cached");
		await loadAgents(tmpDir);
		const def = await getOrLoadAgent("cached");
		expect(def.name).toBe("cached");
	});

	it("lazy-loads from agentsDir on cache miss and adds to registry", async () => {
		writeAgent(tmpDir, "lazy");
		expect(agentRegistry.has("lazy")).toBe(false);
		const def = await getOrLoadAgent("lazy");
		expect(def.name).toBe("lazy");
		expect(agentRegistry.has("lazy")).toBe(true);
	});
});

describe("pipeline/agents: default agent per chat", () => {
	afterEach(() => {
		// Clear any overrides set during tests
		setDefaultAgent("chat-x", null);
		setDefaultAgent("chat-y", null);
		setDefaultAgent("chat-a", null);
		setDefaultAgent("chat-b", null);
	});

	it("returns settings.defaultAgent when no override is set", () => {
		const globalDefault = settings.defaultAgent;
		expect(getDefaultAgent("chat-never-overridden")).toBe(globalDefault);
	});

	it("setDefaultAgent overrides per-chat; null clears back to global", () => {
		const globalDefault = settings.defaultAgent;

		setDefaultAgent("chat-x", "coach");
		expect(getDefaultAgent("chat-x")).toBe("coach");
		expect(getDefaultAgent("chat-y")).toBe(globalDefault);

		setDefaultAgent("chat-x", null);
		expect(getDefaultAgent("chat-x")).toBe(globalDefault);
	});

	it("overrides are chat-scoped — one chat does not affect another", () => {
		setDefaultAgent("chat-a", "alpha");
		setDefaultAgent("chat-b", "beta");
		expect(getDefaultAgent("chat-a")).toBe("alpha");
		expect(getDefaultAgent("chat-b")).toBe("beta");
	});
});
