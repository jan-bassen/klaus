import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../../../src/infra/config.ts";
import {
	clearLoginFolder,
	prepareLoginFolderForStartup,
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
		settings.vault.loginQrPath = path.join(settings.vault.loginDir, "qr-code.svg");
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

		expect(existsSync(path.join(settings.vault.loginDir, "instructions.md"))).toBe(
			true,
		);
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
});
