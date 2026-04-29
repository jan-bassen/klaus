import { mkdirSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addSchedule,
	getSchedules,
	initSchedulesStore,
	stopAllSchedules,
} from "../../../src/infra/store/schedules.ts";
import { handleAgentChange } from "../../../src/infra/vault/watcher.ts";
import { agentRegistry } from "../../../src/pipeline/agents.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

function writeAgent(
	agentsDir: string,
	filename: string,
	options: {
		name: string;
		schedule?: string;
		prompt?: string;
		overrides?: string[];
	},
): void {
	const persistence = options.schedule
		? `persistenceMode: static
persistenceSchedule: "${options.schedule}"
persistencePrompt: "${options.prompt ?? "check in"}"
persistenceOverrides: [${(options.overrides ?? []).join(", ")}]
`
		: "";
	writeFileSync(
		path.join(agentsDir, filename),
		`---
name: ${options.name}
aliases: []
${persistence}---
Prompt body.
`,
	);
}

describe("infra/vault/watcher.handleAgentChange", () => {
	let tmpDir: string;
	let agentsDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
		agentsDir = path.join(tmpDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		initSchedulesStore({ dataDir: tmpDir, timezone: "UTC" });
	});

	afterEach(() => {
		stopAllSchedules();
		agentRegistry.clear();
		rmTmpDir(tmpDir);
	});

	it("renames the frontmatter schedule when an agent file changes names", async () => {
		const filename = "daily.md";
		writeAgent(agentsDir, filename, {
			name: "oldName",
			schedule: "0 8 * * *",
			prompt: "daily check",
			overrides: ["voice"],
		});
		await handleAgentChange(agentsDir, filename);
		expect(getSchedules().map((s) => s.id)).toEqual(["frontmatter:oldName"]);

		writeAgent(agentsDir, filename, {
			name: "newName",
			schedule: "0 8 * * *",
			prompt: "daily check",
			overrides: ["voice"],
		});
		await handleAgentChange(agentsDir, filename);

		expect(agentRegistry.has("oldName")).toBe(false);
		expect(agentRegistry.get("newName")?.name).toBe("newName");
		expect(getSchedules()).toEqual([
			expect.objectContaining({
				id: "frontmatter:newName",
				agentName: "newName",
				pattern: "0 8 * * *",
				objective: "daily check",
				overrides: ["voice"],
			}),
		]);
	});

	it("removes the frontmatter schedule when static persistence is removed", async () => {
		const filename = "daily.md";
		writeAgent(agentsDir, filename, {
			name: "daily",
			schedule: "0 8 * * *",
			prompt: "daily check",
		});
		await handleAgentChange(agentsDir, filename);

		writeAgent(agentsDir, filename, { name: "daily" });
		await handleAgentChange(agentsDir, filename);

		expect(getSchedules()).toEqual([]);
	});

	it("deleting an agent file removes only its deterministic frontmatter schedule", async () => {
		const filename = "daily.md";
		writeAgent(agentsDir, filename, {
			name: "daily",
			schedule: "0 8 * * *",
			prompt: "daily check",
		});
		await handleAgentChange(agentsDir, filename);
		await addSchedule({
			id: "manual:daily",
			agentName: "daily",
			pattern: "0 9 * * *",
			chatId: "chat",
			objective: "manual",
			label: "manual",
			createdBy: "tester",
			createdAt: new Date().toISOString(),
		});

		await unlink(path.join(agentsDir, filename));
		await handleAgentChange(agentsDir, filename);

		expect(getSchedules()).toEqual([
			expect.objectContaining({
				id: "manual:daily",
				agentName: "daily",
			}),
		]);
	});
});
