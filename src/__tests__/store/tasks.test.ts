import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let savedDataDir: string | undefined;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "tasks-test-"));
	savedDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = tmpDir;
});

afterAll(async () => {
	if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
	else delete process.env.DATA_DIR;
	await rm(tmpDir, { recursive: true, force: true });
});

const { createTask, moveTask, getTask, listTasks, recoverRunningTasks } =
	await import("@/store/tasks");

// Clean task dirs between tests
beforeEach(async () => {
	for (const status of ["pending", "running", "done", "failed", "cancelled"]) {
		const dir = join(tmpDir, "tasks", status);
		try {
			const { readdir, unlink } = await import("node:fs/promises");
			const files = await readdir(dir);
			for (const f of files) await unlink(join(dir, f));
		} catch {
			// dir may not exist yet
		}
	}
});

describe("createTask", () => {
	test("returns a UUID and task is retrievable", async () => {
		const id = await createTask({
			chatId: "user@s.whatsapp.net",
			objective: "Test task",
			assignedTo: "helper",
		});
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		const task = await getTask(id);
		expect(task?.objective).toBe("Test task");
		expect(task?.status).toBe("pending");
		expect(task?.assignedTo).toBe("helper");
	});
});

describe("moveTask", () => {
	test("moves task between status directories", async () => {
		const id = await createTask({
			chatId: "c",
			objective: "Move me",
		});
		await moveTask(id, "running");
		const task = await getTask(id);
		expect(task?.status).toBe("running");
	});

	test("applies update fields", async () => {
		const id = await createTask({
			chatId: "c",
			objective: "Complete me",
		});
		const now = new Date().toISOString();
		await moveTask(id, "done", { completedAt: now, result: "success" });
		const task = await getTask(id);
		expect(task?.status).toBe("done");
		expect(task?.completedAt).toBe(now);
		expect(task?.result).toBe("success");
	});
});

describe("listTasks", () => {
	test("lists tasks filtered by status", async () => {
		await createTask({ chatId: "c", objective: "A" });
		const id2 = await createTask({ chatId: "c", objective: "B" });
		await moveTask(id2, "running");

		const pending = await listTasks({ status: "pending" });
		expect(pending).toHaveLength(1);
		expect(pending[0]?.objective).toBe("A");

		const running = await listTasks({ status: "running" });
		expect(running).toHaveLength(1);
		expect(running[0]?.objective).toBe("B");
	});

	test("filters by chatId", async () => {
		await createTask({ chatId: "a", objective: "For A" });
		await createTask({ chatId: "b", objective: "For B" });

		const result = await listTasks({ chatId: "a" });
		expect(result).toHaveLength(1);
		expect(result[0]?.objective).toBe("For A");
	});

	test("returns empty when no tasks match", async () => {
		const result = await listTasks({ status: "done" });
		expect(result).toHaveLength(0);
	});
});

describe("recoverRunningTasks", () => {
	test("moves running tasks back to pending", async () => {
		const id = await createTask({ chatId: "c", objective: "Recover" });
		await moveTask(id, "running");
		await recoverRunningTasks();

		const task = await getTask(id);
		expect(task?.status).toBe("pending");
	});
});
