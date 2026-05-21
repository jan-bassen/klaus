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
		schedules?: Array<{
			pattern: string;
			label?: string;
			overrides?: string[];
		}>;
	},
): void {
	const schedules = options.schedules
		? `schedules:
${options.schedules
	.map(
		(s) => `  - pattern: "${s.pattern}"
${s.label ? `    label: ${s.label}\n` : ""}    overrides: [${(s.overrides ?? []).join(", ")}]`,
	)
	.join("\n")}
`
		: "";
	writeFileSync(
		path.join(agentsDir, filename),
		`---
name: ${options.name}
aliases: []
${schedules}---
# System
Prompt body.

# Message
{{schedule.label}} check.
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

	it("renames frontmatter schedules when an agent file changes names", async () => {
		const filename = "daily.md";
		writeAgent(agentsDir, filename, {
			name: "oldName",
			schedules: [
				{ pattern: "0 8 * * *", label: "morning", overrides: ["voice"] },
			],
		});
		await handleAgentChange(agentsDir, filename);
		expect(getSchedules().map((s) => s.id)).toEqual(["frontmatter:oldName:0"]);

		writeAgent(agentsDir, filename, {
			name: "newName",
			schedules: [
				{ pattern: "0 8 * * *", label: "morning", overrides: ["voice"] },
			],
		});
		await handleAgentChange(agentsDir, filename);

		expect(agentRegistry.has("oldName")).toBe(false);
		expect(agentRegistry.get("newName")?.name).toBe("newName");
		expect(getSchedules()).toEqual([
			expect.objectContaining({
				id: "frontmatter:newName:0",
				agentName: "newName",
				pattern: "0 8 * * *",
				objective: "# Message",
				label: "morning",
				overrides: ["voice"],
			}),
		]);
	});

	it("removes frontmatter schedules when they are removed", async () => {
		const filename = "daily.md";
		writeAgent(agentsDir, filename, {
			name: "daily",
			schedules: [{ pattern: "0 8 * * *", label: "morning" }],
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
			schedules: [{ pattern: "0 8 * * *", label: "morning" }],
		});
		await handleAgentChange(agentsDir, filename);
		await addSchedule({
			id: "manual:daily",
			agentName: "daily",
			pattern: "0 9 * * *",
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
