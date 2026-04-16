import path from "node:path";
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	jidNormalizedUser,
	useMultiFileAuthState,
	type WASocket,
} from "@whiskeysockets/baileys";
import type { ILogger } from "@whiskeysockets/baileys/lib/Utils/logger";
import { log } from "@/logger";
import { clearLoginFolder, writeQrToVault } from "@/whatsapp/login";

const baileysLogger: ILogger = {
	level: "warn",
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: (obj: unknown, msg?: string) =>
		log.warn(`[baileys] ${msg ?? ""}`, obj as Record<string, unknown>),
	error: (obj: unknown, msg?: string) =>
		log.error(`[baileys] ${msg ?? ""}`, obj as Record<string, unknown>),
	child: () => baileysLogger,
};

let socket: WASocket | null = null;
let closing = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export type WhatsAppConnectionState =
	| "idle"
	| "connecting"
	| "pairing"
	| "connected"
	| "disconnected"
	| "logged_out";

let connectionState: WhatsAppConnectionState = "idle";
let latestQr: string | null = null;

const AUTH_DIR =
	process.env.BAILEYS_AUTH_FOLDER ?? path.join(process.cwd(), ".baileys-auth");

/**
 * Initialize Baileys, handle QR pairing on first run, and manage reconnects.
 * Returns the active WASocket once the connection is open.
 *
 * Uses an inner connect() loop so reconnects never create concurrent sockets.
 * On loggedOut: rejects the startup promise (or exits if already running).
 * On any other disconnect: waits 1.5s and reconnects with the same auth state.
 */
export async function startConnection(
	onOpen?: (socket: WASocket) => void | Promise<void>,
): Promise<WASocket> {
	closing = false;
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();

	return new Promise<WASocket>((resolve, reject) => {
		let settled = false;
		let retryCount = 0;

		function connect(): void {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			connectionState = "connecting";
			const sock = makeWASocket({
				version,
				auth: state,
				printQRInTerminal: false,
				logger: baileysLogger,
			});

			sock.ev.on("creds.update", saveCreds);

			sock.ev.on(
				"connection.update",
				async ({ connection, lastDisconnect, qr }) => {
					if (qr) {
						connectionState = "pairing";
						latestQr = qr;
						log.info(
							"[connection] QR code written to vault — open in Obsidian to scan",
						);
						writeQrToVault(qr).catch((err) =>
							log.error("[connection] failed to write QR to vault", {
								error: err instanceof Error ? err.message : String(err),
							}),
						);
					}
					if (connection === "open") {
						if (reconnectTimer) {
							clearTimeout(reconnectTimer);
							reconnectTimer = null;
						}
						socket = sock;
						connectionState = "connected";
						latestQr = null;
						retryCount = 0;
						clearLoginFolder().catch(() => {});
						if (onOpen) {
							try {
								await onOpen(sock);
							} catch (err) {
								log.error("[connection] onOpen callback failed", {
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}
						log.info("[connection] connected");
						if (!settled) {
							settled = true;
							resolve(sock);
						}
					} else if (connection === "close") {
						socket = null;
						if (closing) return;
						const code = (
							lastDisconnect?.error as
								| { output?: { statusCode?: number } }
								| undefined
						)?.output?.statusCode;

						if (code === DisconnectReason.loggedOut) {
							connectionState = "logged_out";
							log.error(
								"[connection] logged out, delete auth folder and restart",
							);
							if (!settled) {
								settled = true;
								reject(new Error("WhatsApp logged out"));
							} else {
								process.exit(1);
							}
						} else {
							connectionState = "disconnected";
							const delayMs =
								Math.min(30_000, 1_500 * 2 ** retryCount) +
								Math.floor(Math.random() * 500);
							retryCount++;
							log.warn(
								`[connection] disconnected (code ${code ?? "unknown"}), reconnecting (attempt ${retryCount})`,
							);
							reconnectTimer = setTimeout(() => {
								reconnectTimer = null;
								connect();
							}, delayMs);
						}
					}
				},
			);
		}

		connect();
	});
}

export function getSocket(): WASocket {
	if (!socket)
		throw new Error(
			"WhatsApp socket not initialized — call startConnection() first",
		);
	return socket;
}

export function closeSocket(): void {
	closing = true;
	connectionState = "idle";
	latestQr = null;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	socket?.end(undefined);
	socket = null;
}

export function isConnected(): boolean {
	return socket !== null;
}

export function getConnectionState(): WhatsAppConnectionState {
	return connectionState;
}

export function getLatestQr(): string | null {
	return latestQr;
}

/** Normalize a raw JID to user@s.whatsapp.net form. */
export function normalizeJid(rawJid: string): string {
	return jidNormalizedUser(rawJid);
}
