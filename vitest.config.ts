import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Bun provides `import.meta.dir` on every module. Node/Vitest does not.
 * This plugin rewrites the Bun-only property to the Node equivalent so
 * production code runs under Vitest without modification.
 */
function bunCompat(): Plugin {
	return {
		name: "bun-compat",
		transform(code) {
			if (!code.includes("import.meta.dir")) return;
			// Word-boundary match so we don't clobber import.meta.dirname
			return code.replace(
				/import\.meta\.dir\b(?!name)/g,
				"import.meta.dirname",
			);
		},
	};
}

export default defineConfig({
	plugins: [bunCompat()],
	resolve: {
		alias: { "@/": `${path.resolve(__dirname, "src")}/` },
	},
	test: {
		testTimeout: 30_000,
		pool: "forks",
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/bun-polyfill.ts", "test/setup.ts"],
	},
});
