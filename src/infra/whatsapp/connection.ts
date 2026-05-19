import path from "node:path";
import {
	DisconnectReason,
	fetchLatestBaileysVersion,
	jidNormalizedUser,
	makeWASocket,
	useMultiFileAuthState,
	type WASocket,
} from "baileys";
import type { ILogger } from "baileys/lib/Utils/logger.js";
import { settings } from "../config.ts";
import { log } from "../logger.ts";

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

const AUTH_DIR = path.join(settings.dataDir, "baileys-auth");

type ConnectionHandlers = {
	onOpen?: (socket: WASocket) => void | Promise<void>;
	onClose?: () => void | Promise<void>;
	onQr?: (qr: string) => void | Promise<void>;
};

/**
 * Initialize Baileys, handle QR pairing on first run, and manage reconnects.
 * Returns the active WASocket once the connection is open.
 *
 * Uses an inner connect() loop so reconnects never create concurrent sockets.
 * On loggedOut: rejects the startup promise (or exits if already running).
 * On any other disconnect: waits 1.5s and reconnects with the same auth state.
 */
export async function startConnection(
	handlers: ConnectionHandlers = {},
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
						log.info(
							"[connection] QR code written to vault — open in Obsidian to scan",
						);
						handlers.onQr?.(qr)?.catch((err) =>
							log.error("[connection] QR handler failed", {
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
						retryCount = 0;
						if (handlers.onOpen) {
							try {
								await handlers.onOpen(sock);
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
						if (handlers.onClose) {
							try {
								await handlers.onClose();
							} catch (err) {
								log.error("[connection] onClose callback failed", {
									error: err instanceof Error ? err.message : String(err),
								});
							}
						}
						if (closing) return;
						const code = (
							lastDisconnect?.error as
								| { output?: { statusCode?: number } }
								| undefined
						)?.output?.statusCode;

						if (code === DisconnectReason.loggedOut) {
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

/** Normalize a raw JID to user@s.whatsapp.net form. */
export function normalizeJid(rawJid: string): string {
	return jidNormalizedUser(rawJid);
}
