import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import QRCode from "qrcode";
import { log } from "@/logger";
import { settings } from "@/settings";

const FALLBACK_INSTRUCTIONS = `# Klaus Login

Scan the QR code, then send this code to the agent: \`{{code}}\`
`;

let _setupCode: string | null = null;

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

	const instructionsPath = `${dir}/instructions.md`;
	let content: string;
	if (existsSync(instructionsPath)) {
		content = await Bun.file(instructionsPath).text();
		content = content.replace(/`\d{6}`/g, `\`${_setupCode}\``);
		content = content.replace(/\{\{code\}\}/g, _setupCode);
	} else {
		content = FALLBACK_INSTRUCTIONS.replace(/\{\{code\}\}/g, _setupCode);
	}
	await Bun.write(instructionsPath, content);
	log.info("[login] wrote instructions.md with setup code", {
		path: instructionsPath,
	});
}

export async function writeQrToVault(qrData: string): Promise<void> {
	await mkdir(settings.vault.loginDir, { recursive: true });
	const svg = await QRCode.toString(qrData, {
		type: "svg",
		margin: 2,
		errorCorrectionLevel: "M",
	});
	await Bun.write(settings.vault.loginQrPath, svg);
	log.info("[login] QR code written to vault", {
		path: settings.vault.loginQrPath,
	});
}

export async function clearLoginFolder(): Promise<void> {
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
