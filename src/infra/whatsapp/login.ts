import { existsSync } from "node:fs";
import { watch as fsWatch, mkdir, readFile, rm } from "node:fs/promises";
import QRCode from "qrcode";
import { renderTemplate } from "../../pipeline/templates.ts";
import { settings, updateAllowedChat, updateSelfMode } from "../config.ts";
import { activateFutureWorkIfReady } from "../future.ts";
import { log } from "../logger.ts";
import { readText, writeData } from "../runtime.ts";
import { getSocket, normalizeJid } from "./connection.ts";
import { enqueueMessage } from "./send.ts";

const LOGIN_INSTRUCTIONS = `# Klaus Login

1. Open WhatsApp on your phone → Settings → Linked Devices → Link a device
2. Choose how Klaus should listen:
   - **Solo mode**: Klaus runs inside the WhatsApp account you are linking. Check the box below before scanning the QR code. After login, Klaus will message its own chat and setup is complete.
   - **Active chat mode**: Leave the box unchecked. After scanning, send the setup code from the chat Klaus should listen to.
3. Scan the QR code in this folder

- [ ] Solo mode (I am linking the account Klaus should message itself from)

Active chat setup code:

\`{{code}}\`
`;

let _setupCode: string | null = null;
let _watcherCtl: AbortController | null = null;

export function getSetupCode(): string | null {
	return _setupCode;
}

export function clearSetupCode(): void {
	_setupCode = null;
}

async function ensureLoginFolder(): Promise<void> {
	const dir = settings.vault.loginDir;
	await mkdir(dir, { recursive: true });

	_setupCode = Math.floor(100_000 + Math.random() * 900_000).toString();

	const path = `${dir}/instructions.md`;
	let content: string;
	if (existsSync(path)) {
		content = await readText(path);
		content = content.replace(/`\d{6}`/g, `\`${_setupCode}\``);
		content = content.replace(/\{\{code\}\}/g, _setupCode);
	} else {
		content = LOGIN_INSTRUCTIONS.replace(/\{\{code\}\}/g, _setupCode);
	}

	// If selfMode is preset in settings.yml, ship the box pre-ticked so the
	// watcher fires immediately once the file lands and the socket is up.
	if (settings.whatsapp.selfMode) {
		content = content.replace(/^- \[ \] (.*solo.*)$/im, "- [x] $1");
	}

	await writeData(path, content);
	log.info("[login] wrote instructions.md", {
		selfMode: settings.whatsapp.selfMode,
	});
}

export async function prepareLoginFolderForStartup(): Promise<void> {
	if (settings.allowedChat) {
		await clearLoginFolder();
		return;
	}

	await ensureLoginFolder();
	startLoginModeWatcher();
}

export async function writeQrToVault(qrData: string): Promise<void> {
	await mkdir(settings.vault.loginDir, { recursive: true });
	const svg = await QRCode.toString(qrData, {
		type: "svg",
		margin: 2,
		errorCorrectionLevel: "M",
	});
	await writeData(settings.vault.loginQrPath, svg);
	log.info("[login] QR code written to vault");
}

export async function clearLoginFolder(): Promise<void> {
	stopLoginModeWatcher();
	try {
		if (existsSync(settings.vault.loginDir)) {
			await rm(settings.vault.loginDir, { recursive: true });
			log.info("[login] removed _login folder from vault");
		}
	} catch (err) {
		log.warn("[login] failed to remove _login folder", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Watch instructions.md for the user choosing solo mode before scanning QR.
 * The choice is persisted into settings because self-mode changes both receive
 * and send behavior after setup.
 */
function startLoginModeWatcher(): void {
	if (_watcherCtl) return;
	const ctl = new AbortController();
	_watcherCtl = ctl;
	const dir = settings.vault.loginDir;
	const target = "instructions.md";

	void (async () => {
		try {
			if (await syncLoginModeFromInstructions()) {
				return;
			}
			const watcher = fsWatch(dir, { signal: ctl.signal });
			for await (const ev of watcher) {
				if (ev.filename !== target) continue;
				if (await syncLoginModeFromInstructions()) {
					return;
				}
			}
		} catch (err) {
			if (ctl.signal.aborted) return;
			log.warn("[login] solo watcher error", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	})();
}

function stopLoginModeWatcher(): void {
	_watcherCtl?.abort();
	_watcherCtl = null;
}

async function syncLoginModeFromInstructions(): Promise<boolean> {
	const solo = await isSoloTicked();
	if (settings.whatsapp.selfMode !== solo) {
		await updateSelfMode(solo);
	}
	if (!solo || settings.allowedChat) return false;
	return completeSoloSetup();
}

async function isSoloTicked(): Promise<boolean> {
	const path = `${settings.vault.loginDir}/instructions.md`;
	if (!existsSync(path)) return false;
	try {
		const text = await readFile(path, "utf8");
		return /^- \[x\] .*solo/im.test(text);
	} catch {
		return false;
	}
}

export async function completeSoloSetup(): Promise<boolean> {
	let ownJid = "";
	try {
		ownJid = normalizeJid(getSocket().user?.id ?? "");
	} catch {
		ownJid = "";
	}
	if (!ownJid) {
		log.warn("[login] solo tick detected but bot JID unavailable yet");
		return false;
	}
	log.info("[login] solo mode chosen — auto-configuring");
	await updateAllowedChat(ownJid);
	activateFutureWorkIfReady();
	clearSetupCode();
	enqueueMessage({
		chatId: ownJid,
		content: renderTemplate("welcome", {}),
		dedupKey: `solo-setup:${ownJid}`,
		label: settings.whatsapp.systemLabel,
	});
	await clearLoginFolder();
	return true;
}
