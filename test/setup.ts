/**
 * Global test setup.
 *
 * 1. Vitest runs forked Node workers (no Bun globals). Source code uses
 *    `Bun.file` / `Bun.write` / `Bun.Glob` extensively, so we install a small
 *    polyfill before any source module loads.
 *
 * 2. Preloads `@/infra/config` before anything else — there's a circular import
 *    between config and the logger that crashes at load time if the logger
 *    module evaluates first.
 *
 * 3. Per-test cleanup of in-memory registries that survive between suites.
 */

// Critical: must be the very first thing — installed before any source module
// (which would otherwise reference `Bun` at evaluation time).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function walkGlob(cwd: string, pattern: string): Promise<string[]> {
	// Minimal glob: support `*.ext`, `sets/*.ext`, `**/*.ext`.
	const out: string[] = [];
	async function walk(
		dir: string,
		rel: string,
		recurse: boolean,
	): Promise<void> {
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
		}>;
		try {
			entries = (await readdir(dir, {
				withFileTypes: true,
			})) as unknown as typeof entries;
		} catch {
			return;
		}
		for (const e of entries) {
			const name = String(e.name);
			const sub = rel ? path.join(rel, name) : name;
			if (e.isDirectory()) {
				if (recurse) await walk(path.join(dir, name), sub, true);
			} else if (e.isFile()) {
				out.push(sub);
			}
		}
	}

	if (pattern.startsWith("**/")) {
		const ext = pattern.slice(3);
		await walk(cwd, "", true);
		return out.filter((f) => matchExt(f, ext));
	}
	const slash = pattern.indexOf("/");
	if (slash >= 0) {
		const sub = pattern.slice(0, slash);
		const rest = pattern.slice(slash + 1);
		await walk(path.join(cwd, sub), sub, false);
		return out.filter((f) => matchExt(path.basename(f), rest));
	}
	await walk(cwd, "", false);
	return out.filter((f) => matchExt(f, pattern));
}

function matchExt(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
	(globalThis as { Bun: unknown }).Bun = {
		file(p: string) {
			return {
				async text(): Promise<string> {
					return (await readFile(p)).toString("utf8");
				},
				async arrayBuffer(): Promise<ArrayBuffer> {
					const buf = await readFile(p);
					return buf.buffer.slice(
						buf.byteOffset,
						buf.byteOffset + buf.byteLength,
					) as ArrayBuffer;
				},
				async bytes(): Promise<Uint8Array> {
					return new Uint8Array(await readFile(p));
				},
				async json(): Promise<unknown> {
					return JSON.parse((await readFile(p)).toString("utf8"));
				},
			};
		},
		async write(
			p: string,
			data: string | Uint8Array | ArrayBuffer | Blob,
		): Promise<number> {
			let bytes: Uint8Array | string;
			if (typeof data === "string") bytes = data;
			else if (data instanceof Uint8Array) bytes = data;
			else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
			else bytes = new Uint8Array(await (data as Blob).arrayBuffer());
			await writeFile(p, bytes);
			return typeof bytes === "string"
				? Buffer.byteLength(bytes)
				: bytes.byteLength;
		},
		Glob: class {
			pattern: string;
			constructor(pattern: string) {
				this.pattern = pattern;
			}
			async *scan(opts: { cwd: string }): AsyncGenerator<string> {
				const matches = await walkGlob(opts.cwd, this.pattern);
				for (const m of matches) yield m;
			}
		},
	};
}

import "@/infra/config";

import { afterEach } from "vitest";
import { agentRegistry } from "@/pipeline/agents";
import { overrideRegistry } from "@/pipeline/overrides";
import { toolRegistry, toolsetRegistry } from "@/primitives/tools";
import { skillRegistry } from "@/primitives/tools/skill";

afterEach(() => {
	agentRegistry.clear();
	overrideRegistry.clear();
	toolRegistry.clear();
	toolsetRegistry.clear();
	skillRegistry.clear();
});
