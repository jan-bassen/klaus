import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { bundledVaultDir } from "../config.ts";
import { log } from "../logger.ts";

/**
 * Bootstrap the runtime Klaus folder from bundled defaults exactly once.
 * If the folder already exists, it is treated as synced/user-owned state.
 */
export async function ensureVaultDefaults(
	targetDir: string,
	defaultsDir = bundledVaultDir,
): Promise<void> {
	if (existsSync(targetDir) || !existsSync(defaultsDir)) return;

	async function copyDir(src: string, dest: string): Promise<void> {
		const entries = await readdir(src, { withFileTypes: true });
		await mkdir(dest, { recursive: true });
		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				await copyDir(srcPath, destPath);
			} else {
				await copyFile(srcPath, destPath);
				log.info(`[startup] copied default file: ${destPath}`);
			}
		}
	}

	await copyDir(defaultsDir, targetDir);
}
