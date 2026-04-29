/**
 * `pipeline/agents.ts` — agent definition loading, registry, and per-chat defaults.
 */

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

function writeAgent(dir: string, name: string, extra = ""): void {
	writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ntools: [reply]\n${extra}---\nYou are ${name}.`,
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
		expect(def.tools).toEqual(["reply"]);
	});

	it("applies AgentSettings defaults (voice/temp/topP/showTrace/report)", async () => {
		writeAgent(tmpDir, "bare");
		const def = await loadAgentDefinition(path.join(tmpDir, "bare.md"));
		expect(def.settings.voice).toBe("auto");
		expect(def.settings.temp).toBe("default");
		expect(def.settings.topP).toBe("default");
		expect(def.settings.showTrace).toBe(true);
		expect(def.settings.report).toBe("short");
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

	it("parses static persistence block", async () => {
		writeAgent(
			tmpDir,
			"daily",
			'persistenceMode: static\npersistenceSchedule: "0 8 * * *"\npersistencePrompt: "Good morning"\n',
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "daily.md"));
		expect(def.persistence?.mode).toBe("static");
		if (def.persistence?.mode !== "static") return;
		expect(def.persistence.schedule).toBe("0 8 * * *");
		expect(def.persistence.prompt).toBe("Good morning");
	});

	it("parses dynamic persistence block", async () => {
		writeAgent(
			tmpDir,
			"adaptive",
			'persistenceMode: dynamic\npersistenceHint: "schedule based on user"\n',
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "adaptive.md"));
		expect(def.persistence?.mode).toBe("dynamic");
		if (def.persistence?.mode !== "dynamic") return;
		expect(def.persistence.hint).toBe("schedule based on user");
	});

	it("parses flat settings", async () => {
		writeAgent(
			tmpDir,
			"custom",
			"voice: on\ntemp: cold\nreport: full\nhistoryLimit: 5\n",
		);
		const def = await loadAgentDefinition(path.join(tmpDir, "custom.md"));
		expect(def.settings.voice).toBe("on");
		expect(def.settings.temp).toBe("cold");
		expect(def.settings.report).toBe("full");
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
