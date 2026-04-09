import path from "node:path";

export const config = {
	vault: {
		get root() {
			return process.env.VAULT_DIR ?? path.join(process.cwd(), "vault");
		},
		// Bootstrap anchor — hardcoded because settings.yml lives inside this folder.
		internal: "Klaus",
		get internalPath() {
			return path.join(this.root, this.internal);
		},
		get agentsDir() {
			return path.join(this.internalPath, "agents");
		},
		get skillsDir() {
			return path.join(this.internalPath, "skills");
		},
		get snippetsDir() {
			return path.join(this.internalPath, "snippets");
		},
		get trailDir() {
			return path.join(this.internalPath, "trail");
		},
		get loginDir() {
			return path.join(this.internalPath, "_login");
		},
		get loginQrPath() {
			return path.join(this.internalPath, "_login", "qr-code.svg");
		},
		get settingsPath() {
			return path.join(this.internalPath, "settings.yml");
		},
	},
	get dataDir() {
		return (
			process.env.DATA_DIR ??
			path.join(process.env.HOME ?? process.cwd(), ".klaus", "data")
		);
	},
	log: {
		format: (process.env.LOG_FORMAT === "json" ? "json" : "pretty") as
			| "pretty"
			| "json",
	},
	startup: {
		connectionWarnAfterMs: Number(
			process.env.STARTUP_CONNECTION_WARN_AFTER_MS ?? 60_000,
		),
	},
} as const;
