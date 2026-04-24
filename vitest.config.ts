import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "@": path.resolve(__dirname, "./src") },
	},
	test: {
		// Fork pool gives module isolation — each suite gets a fresh module cache,
		// which matters because most stores + registries are module-level singletons.
		pool: "forks",
		setupFiles: ["./test/setup.ts"],
		testTimeout: 30_000,
		// Point vault at the repo so templates/agents load without a vault copy.
		env: {
			NODE_ENV: "test",
			VAULT_DIR: path.resolve(__dirname),
		},
	},
});
