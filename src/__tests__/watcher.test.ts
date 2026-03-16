import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mocks (must precede module imports) ─────────────────────────────────────

const mockDispatch = mock(async (_opts: unknown) => undefined);
mock.module("@/core/dispatch", () => ({ dispatch: mockDispatch }));

const mockRemoveSchedule = mock(async (_name: string) => {});
mock.module("@/store/schedules", () => ({
	removeSchedule: mockRemoveSchedule,
	addSchedule: mock(async () => {}),
	loadSchedules: mock(async () => {}),
	getSchedules: mock(() => []),
	startAllSchedules: mock(() => {}),
	stopAllSchedules: mock(() => {}),
	_clearSchedulesForTest: mock(() => {}),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { agentRegistry, loadAgentDefinition } from "@/core/agent";
import { startWatching, stopWatching } from "@/core/watcher";
import { skillRegistry } from "@/tools/skill";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 50; // Short debounce for tests

let agentsDir: string;
let skillsDir: string;
let tmpBase: string;

function agentMd(
	name: string,
	opts: { modelTier?: string; tools?: string[]; schedule?: string } = {},
): string {
	const tier = opts.modelTier ?? "default";
	const tools = opts.tools ?? ["reply"];
	const lines = [
		"---",
		`name: ${name}`,
		`modelTier: ${tier}`,
		`tools: [${tools.join(", ")}]`,
	];
	if (opts.schedule) lines.push(`schedule: "${opts.schedule}"`);
	lines.push("---", "", `You are ${name}.`);
	return lines.join("\n");
}

function skillMd(description?: string): string {
	if (!description) return "# Skill content\nSome content.";
	return `---\ndescription: ${description}\n---\n# Skill content\nSome content.`;
}

/** Wait for debounce + fs.watch propagation */
async function waitForDebounce(): Promise<void> {
	await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200));
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
	tmpBase = join(
		tmpdir(),
		`watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	agentsDir = join(tmpBase, "agents");
	skillsDir = join(tmpBase, "skills");
	await mkdir(agentsDir, { recursive: true });
	await mkdir(skillsDir, { recursive: true });

	agentRegistry.clear();
	skillRegistry.clear();
	mockDispatch.mockClear();
	mockRemoveSchedule.mockClear();

	// Override debounce for fast tests
	const { config } = await import("@/config");
	(config as { watcher: { debounceMs: number } }).watcher.debounceMs =
		DEBOUNCE_MS;
});

afterEach(async () => {
	stopWatching();
	await rm(tmpBase, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("watcher", () => {
	describe("agent changes", () => {
		test("new agent file added → appears in agentRegistry", async () => {
			startWatching(agentsDir, skillsDir);
			await writeFile(join(agentsDir, "helper.md"), agentMd("helper"));
			await waitForDebounce();

			expect(agentRegistry.has("helper")).toBe(true);
			const def = agentRegistry.get("helper");
			expect(def?.modelTier).toBe("default");
		});

		test("agent file modified → registry entry updated", async () => {
			// Seed the registry
			await writeFile(join(agentsDir, "bot.md"), agentMd("bot"));
			const def = await loadAgentDefinition(join(agentsDir, "bot.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(agentsDir, "bot.md"),
				agentMd("bot", { modelTier: "high" }),
			);
			await waitForDebounce();

			expect(agentRegistry.get("bot")?.modelTier).toBe("high");
		});

		test("agent file deleted → removed from agentRegistry", async () => {
			await writeFile(join(agentsDir, "temp.md"), agentMd("temp"));
			const def = await loadAgentDefinition(join(agentsDir, "temp.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await rm(join(agentsDir, "temp.md"));
			await waitForDebounce();

			expect(agentRegistry.has("temp")).toBe(false);
		});

		test("schedule added → dispatch called with cron mode", async () => {
			await writeFile(join(agentsDir, "cron.md"), agentMd("cron"));
			const def = await loadAgentDefinition(join(agentsDir, "cron.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(agentsDir, "cron.md"),
				agentMd("cron", { schedule: "0 3 * * *" }),
			);
			await waitForDebounce();

			expect(mockDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					agent: "cron",
					mode: { kind: "cron", schedule: "0 3 * * *" },
				}),
			);
		});

		test("schedule removed → removeSchedule called", async () => {
			await writeFile(
				join(agentsDir, "sched.md"),
				agentMd("sched", { schedule: "0 3 * * *" }),
			);
			const def = await loadAgentDefinition(join(agentsDir, "sched.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(join(agentsDir, "sched.md"), agentMd("sched"));
			await waitForDebounce();

			expect(mockRemoveSchedule).toHaveBeenCalledWith("sched");
		});

		test("schedule pattern changed → old removed, new dispatched", async () => {
			await writeFile(
				join(agentsDir, "daily.md"),
				agentMd("daily", { schedule: "0 3 * * *" }),
			);
			const def = await loadAgentDefinition(join(agentsDir, "daily.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(agentsDir, "daily.md"),
				agentMd("daily", { schedule: "0 8 * * *" }),
			);
			await waitForDebounce();

			expect(mockRemoveSchedule).toHaveBeenCalledWith("daily");
			expect(mockDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					agent: "daily",
					mode: { kind: "cron", schedule: "0 8 * * *" },
				}),
			);
		});

		test("malformed YAML → warning logged, existing entry preserved", async () => {
			await writeFile(join(agentsDir, "bad.md"), agentMd("bad"));
			const def = await loadAgentDefinition(join(agentsDir, "bad.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(agentsDir, "bad.md"),
				"not valid frontmatter at all",
			);
			await waitForDebounce();

			// Old entry should still be there (parse failure doesn't delete)
			expect(agentRegistry.has("bad")).toBe(true);
			expect(agentRegistry.get("bad")?.modelTier).toBe("default");
		});

		test("agent name changed in frontmatter → old name removed, new name added", async () => {
			await writeFile(join(agentsDir, "agent.md"), agentMd("oldname"));
			const def = await loadAgentDefinition(join(agentsDir, "agent.md"));
			agentRegistry.set(def.name, def);

			startWatching(agentsDir, skillsDir);
			await writeFile(join(agentsDir, "agent.md"), agentMd("newname"));
			await waitForDebounce();

			expect(agentRegistry.has("oldname")).toBe(false);
			expect(agentRegistry.has("newname")).toBe(true);
		});
	});

	describe("skill changes", () => {
		test("skill file added → appears in skillRegistry", async () => {
			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(skillsDir, "cooking.md"),
				skillMd("Italian recipes"),
			);
			await waitForDebounce();

			expect(skillRegistry.has("cooking")).toBe(true);
			expect(skillRegistry.get("cooking")?.description).toBe("Italian recipes");
		});

		test("skill file modified → registry updated", async () => {
			await writeFile(
				join(skillsDir, "workout.md"),
				skillMd("Old description"),
			);
			skillRegistry.set("workout", {
				name: "workout",
				description: "Old description",
			});

			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(skillsDir, "workout.md"),
				skillMd("Updated description"),
			);
			await waitForDebounce();

			expect(skillRegistry.get("workout")?.description).toBe(
				"Updated description",
			);
		});

		test("skill file deleted → removed from skillRegistry", async () => {
			await writeFile(join(skillsDir, "temp.md"), skillMd("Temporary"));
			skillRegistry.set("temp", { name: "temp", description: "Temporary" });

			startWatching(agentsDir, skillsDir);
			await rm(join(skillsDir, "temp.md"));
			await waitForDebounce();

			expect(skillRegistry.has("temp")).toBe(false);
		});

		test("skill without frontmatter → name used as description", async () => {
			startWatching(agentsDir, skillsDir);
			await writeFile(
				join(skillsDir, "plain.md"),
				"# Just content\nNo frontmatter.",
			);
			await waitForDebounce();

			expect(skillRegistry.has("plain")).toBe(true);
			expect(skillRegistry.get("plain")?.description).toBe("plain");
		});
	});

	describe("filtering", () => {
		test("non-.md file ignored", async () => {
			startWatching(agentsDir, skillsDir);
			await writeFile(join(agentsDir, "notes.txt"), "not an agent");
			await waitForDebounce();

			expect(agentRegistry.size).toBe(0);
		});
	});

	describe("debounce", () => {
		test("rapid writes debounced to single reload", async () => {
			startWatching(agentsDir, skillsDir);

			// Write the same file multiple times rapidly
			for (let i = 0; i < 5; i++) {
				await writeFile(
					join(agentsDir, "rapid.md"),
					agentMd("rapid", { modelTier: i % 2 === 0 ? "default" : "high" }),
				);
			}
			await waitForDebounce();

			// Should be loaded exactly once (final state)
			expect(agentRegistry.has("rapid")).toBe(true);
		});
	});

	test("stopWatching clears everything", async () => {
		startWatching(agentsDir, skillsDir);
		stopWatching();

		// After stopping, changes should not be picked up
		await writeFile(join(agentsDir, "ghost.md"), agentMd("ghost"));
		await waitForDebounce();

		expect(agentRegistry.has("ghost")).toBe(false);
	});
});
