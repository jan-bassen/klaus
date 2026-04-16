/**
 * Polyfills Bun-specific APIs for Vitest (runs under Node).
 * Only covers the subset used by production code under test.
 */
import {
	existsSync,
	glob,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";

const BunFile = (filePath: string) => ({
	text: async () => readFileSync(filePath, "utf-8"),
	arrayBuffer: async () => {
		const buf = readFileSync(filePath);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	},
	exists: () => existsSync(filePath),
	size: existsSync(filePath) ? statSync(filePath).size : 0,
	type: "application/octet-stream",
	name: filePath,
});

const BunWrite = async (
	path: string | { text: () => Promise<string> },
	data: string | Buffer | Uint8Array,
) => {
	const target =
		typeof path === "string"
			? path
			: (path as unknown as { name: string }).name;
	const content =
		typeof data === "string"
			? data
			: Buffer.isBuffer(data)
				? data
				: Buffer.from(data);
	await writeFile(target, content);
	return content.length;
};

class BunGlob {
	#pattern: string;
	constructor(pattern: string) {
		this.#pattern = pattern;
	}
	async *scan(opts: { cwd: string; onlyFiles?: boolean }) {
		const { promisify } = await import("node:util");
		const { glob: globCb } = await import("node:fs");
		const matches = await new Promise<string[]>((resolve, reject) => {
			globCb(this.#pattern, { cwd: opts.cwd }, (err, files) => {
				if (err) reject(err);
				else resolve(files);
			});
		});
		for (const m of matches) yield m;
	}
}

// Install on globalThis
(globalThis as Record<string, unknown>).Bun = {
	file: BunFile,
	write: BunWrite,
	Glob: BunGlob,
	serve: () => {
		throw new Error("Bun.serve is not available in test environment");
	},
};
