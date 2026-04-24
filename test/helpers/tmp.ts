import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create a fresh tmp directory per test. Registers its own cleanup via the
 * vitest `afterEach` import from the caller (we return both the path and a
 * `cleanup()` fn — caller decides when to run it).
 */
export function makeTmpDir(prefix = "klaus-test-"): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

export function rmTmpDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}
