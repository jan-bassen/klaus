import { existsSync } from "node:fs";
import { watch as fsWatch, mkdir, readFile, rm } from "node:fs/promises";
import QRCode from "qrcode";
import { settings, updateAllowedChatId } from "../config.ts";
import { log } from "../logger.ts";
import { readText, writeData } from "../runtime.ts";
import { getSocket, normalizeJid } from "./connection.ts";
import { enqueueMessage } from "./send.ts";

const FALLBACK_INSTRUCTIONS = `# Klaus Login

1. Open WhatsApp on your phone → Settings → Linked Devices → Link a device
2. Scan the QR code in this folder

Then, **one** of the following:

- [ ] Solo mode (I'm the only user — Klaus will message itself)

…or send the setup code below from the chat you want Klaus to listen on:

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

export async function ensureLoginFolder(): Promise<void> {
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
		content = FALLBACK_INSTRUCTIONS.replace(/\{\{code\}\}/g, _setupCode);
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
	stopSoloWatcher();
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
 * Watch instructions.md for the user ticking the "solo mode" checkbox.
 * Fires once, then stops itself. Safe to call when allowedChatId is already
 * set — it will no-op via stopSoloWatcher().
 */
export function startSoloWatcher(): void {
	if (_watcherCtl) return;
	const ctl = new AbortController();
	_watcherCtl = ctl;
	const dir = settings.vault.loginDir;
	const target = "instructions.md";

	void (async () => {
		try {
			// Re-check immediately in case the box is already ticked when we start
			// (e.g. selfMode preset or hot-reload after restart).
			if (await isSoloTicked()) {
				await completeSoloSetup();
				return;
			}
			const watcher = fsWatch(dir, { signal: ctl.signal });
			for await (const ev of watcher) {
				if (ev.filename !== target) continue;
				if (await isSoloTicked()) {
					await completeSoloSetup();
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

function stopSoloWatcher(): void {
	_watcherCtl?.abort();
	_watcherCtl = null;
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

async function completeSoloSetup(): Promise<void> {
	const ownJid = normalizeJid(getSocket().user?.id ?? "");
	if (!ownJid) {
		log.warn("[login] solo tick detected but bot JID unavailable yet");
		return;
	}
	log.info("[login] solo mode chosen — auto-configuring");
	await updateAllowedChatId(ownJid);
	clearSetupCode();
	enqueueMessage({
		chatId: ownJid,
		content: "Hey! Klaus is set up and ready to go 🤙",
		dedupKey: `solo-setup:${ownJid}`,
		label: settings.whatsapp.systemLabel,
	});
	await clearLoginFolder();
}
