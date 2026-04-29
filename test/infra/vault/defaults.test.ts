import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureVaultDefaults } from "../../../src/infra/vault/defaults.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("ensureVaultDefaults", () => {
	it("copies repo defaults into Klaus when the Klaus folder does not exist", async () => {
		const tmp = makeTmpDir();
		const defaultsDir = path.join(tmp, "vault");
		const targetDir = path.join(defaultsDir, "Klaus");
		mkdirSync(path.join(defaultsDir, "agents"), { recursive: true });
		writeFileSync(path.join(defaultsDir, "settings.yml"), "settings: true\n");
		writeFileSync(path.join(defaultsDir, "overrides.yml"), "overrides: true\n");
		writeFileSync(
			path.join(defaultsDir, "agents", "assistant.md"),
			"# Assistant\n",
		);

		await ensureVaultDefaults(targetDir, defaultsDir);

		expect(readFileSync(path.join(targetDir, "settings.yml"), "utf8")).toBe(
			"settings: true\n",
		);
		expect(readFileSync(path.join(targetDir, "overrides.yml"), "utf8")).toBe(
			"overrides: true\n",
		);
		expect(existsSync(path.join(targetDir, "agents", "assistant.md"))).toBe(
			true,
		);
		expect(existsSync(path.join(targetDir, "Klaus"))).toBe(false);

		rmTmpDir(tmp);
	});

	it("skips defaults entirely when the Klaus folder already exists", async () => {
		const tmp = makeTmpDir();
		const defaultsDir = path.join(tmp, "defaults");
		const targetDir = path.join(tmp, "vault", "Klaus");
		mkdirSync(defaultsDir, { recursive: true });
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(path.join(defaultsDir, "settings.yml"), "bundled\n");

		await ensureVaultDefaults(targetDir, defaultsDir);

		expect(existsSync(path.join(targetDir, "settings.yml"))).toBe(false);

		rmTmpDir(tmp);
	});
});
