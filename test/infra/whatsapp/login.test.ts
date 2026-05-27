import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import {
	clearLoginFolder,
	completeConfiguredLogin,
	getSetupCode,
	prepareLoginFolderForStartup,
	writeQrToVault,
} from "../../../src/infra/whatsapp/login.ts";
import { makeTmpDir, rmTmpDir } from "../../helpers/tmp.ts";

describe("infra/whatsapp/login.prepareLoginFolderForStartup", () => {
	let tmpDir = "";
	let savedLoginDir = "";
	let savedLoginQrPath = "";
	let savedAllowedChat: string | undefined;
	let savedEnvAllowedChat: string | undefined;

	beforeEach(() => {
		tmpDir = makeTmpDir("klaus-login-");
		savedLoginDir = settings.vault.loginDir;
		savedLoginQrPath = settings.vault.loginQrPath;
		savedAllowedChat = settings.basics.allowedChat;
		savedEnvAllowedChat = process.env.ALLOWED_CHAT_ID;

		settings.vault.loginDir = path.join(tmpDir, "_login");
		settings.vault.loginQrPath = path.join(
			settings.vault.loginDir,
			"qr-code.svg",
		);
		delete settings.basics.allowedChat;
		delete process.env.ALLOWED_CHAT_ID;
	});

	afterEach(async () => {
		await clearLoginFolder();
		settings.vault.loginDir = savedLoginDir;
		settings.vault.loginQrPath = savedLoginQrPath;
		if (savedAllowedChat === undefined) {
			delete settings.basics.allowedChat;
		} else {
			settings.basics.allowedChat = savedAllowedChat;
		}
		if (savedEnvAllowedChat === undefined) {
			delete process.env.ALLOWED_CHAT_ID;
		} else {
			process.env.ALLOWED_CHAT_ID = savedEnvAllowedChat;
		}
		rmTmpDir(tmpDir);
	});

	it("creates setup instructions when no allowed chat is configured", async () => {
		await prepareLoginFolderForStartup();

		expect(
			existsSync(path.join(settings.vault.loginDir, "instructions.md")),
		).toBe(true);
	});

	it("removes stale setup instructions when an allowed chat is configured", async () => {
		mkdirSync(settings.vault.loginDir, { recursive: true });
		writeFileSync(
			path.join(settings.vault.loginDir, "instructions.md"),
			"stale setup notes",
		);
		settings.basics.allowedChat = "123@s.whatsapp.net";

		await prepareLoginFolderForStartup();

		expect(existsSync(settings.vault.loginDir)).toBe(false);
	});

	it("writes pairing instructions for a pinned chat and clears them after connection opens", async () => {
		settings.basics.allowedChat = "123@s.whatsapp.net";

		await writeQrToVault("pairing-code");

		const instructions = readFileSync(
			path.join(settings.vault.loginDir, "instructions.md"),
			"utf8",
		);
		expect(instructions).toContain("already has an allowed chat configured");
		expect(existsSync(settings.vault.loginQrPath)).toBe(true);

		await completeConfiguredLogin();

		expect(existsSync(settings.vault.loginDir)).toBe(false);
	});

	it("clears the setup code when setup finishes through a pinned chat", async () => {
		await prepareLoginFolderForStartup();
		expect(getSetupCode()).not.toBeNull();
		settings.basics.allowedChat = "123@s.whatsapp.net";

		await completeConfiguredLogin();

		expect(getSetupCode()).toBeNull();
		expect(existsSync(settings.vault.loginDir)).toBe(false);
	});
});
