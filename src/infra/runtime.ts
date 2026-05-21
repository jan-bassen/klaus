import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readText(filePath: string): Promise<string> {
	return await readFile(filePath, "utf8");
}

async function readBytes(filePath: string): Promise<Uint8Array> {
	return await readFile(filePath);
}

export async function readArrayBuffer(filePath: string): Promise<ArrayBuffer> {
	const bytes = await readBytes(filePath);
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

export async function writeData(
	filePath: string,
	data: string | Uint8Array | ArrayBuffer | Blob,
): Promise<number> {
	let bytes: string | Uint8Array;
	if (typeof data === "string") {
		bytes = data;
	} else if (data instanceof Uint8Array) {
		bytes = data;
	} else if (data instanceof ArrayBuffer) {
		bytes = new Uint8Array(data);
	} else {
		bytes = new Uint8Array(await data.arrayBuffer());
	}

	await writeFile(filePath, bytes);
	return typeof bytes === "string"
		? Buffer.byteLength(bytes)
		: bytes.byteLength;
}

export async function* scanFiles(
	cwd: string,
	pattern: "*.ts" | "*.md" | "sets/*.ts" | "**/*.md",
): AsyncGenerator<string> {
	const matches = await collectMatches(cwd, pattern);
	for (const match of matches) yield match;
}

async function collectMatches(
	cwd: string,
	pattern: "*.ts" | "*.md" | "sets/*.ts" | "**/*.md",
): Promise<string[]> {
	if (pattern === "**/*.md") {
		const files = await walk(cwd, "", true);
		return files.filter((file) => file.endsWith(".md")).sort();
	}

	const slash = pattern.indexOf("/");
	if (slash >= 0) {
		const subdir = pattern.slice(0, slash);
		const rest = pattern.slice(slash + 1);
		const files = await walk(path.join(cwd, subdir), subdir, false);
		return files.filter((file) => matchesBasename(file, rest)).sort();
	}

	const files = await walk(cwd, "", false);
	return files.filter((file) => matchesBasename(file, pattern)).sort();
}

async function walk(
	dir: string,
	relativeDir: string,
	recurse: boolean,
): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const relativePath = relativeDir
			? path.join(relativeDir, entry.name)
			: entry.name;
		if (entry.isDirectory()) {
			if (recurse) {
				files.push(
					...(await walk(path.join(dir, entry.name), relativePath, true)),
				);
			}
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}
	return files;
}

function matchesBasename(filePath: string, pattern: string): boolean {
	return path.basename(filePath).endsWith(pattern.slice(1));
}
