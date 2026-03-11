import path from "node:path";
import makeWASocket, {
	DisconnectReason,
	fetchLatestBaileysVersion,
	useMultiFileAuthState,
	type WASocket,
} from "@whiskeysockets/baileys";
import { log } from "@/logger";

let socket: WASocket | null = null;
let closing = false;

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
export async function startConnection(): Promise<WASocket> {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();

	return new Promise<WASocket>((resolve, reject) => {
		let settled = false;
		let retryCount = 0;

		function connect(): void {
			const sock = makeWASocket({
				version,
				auth: state,
				printQRInTerminal: true,
			});

			sock.ev.on("creds.update", saveCreds);

			sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
				if (connection === "open") {
					socket = sock;
					retryCount = 0;
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
						log.error(
							"[connection] logged out — delete auth folder and restart",
							{ authDir: AUTH_DIR },
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
						log.warn("[connection] disconnected, reconnecting", {
							code: code ?? "unknown",
							attempt: retryCount,
							delayMs,
						});
						setTimeout(connect, delayMs);
					}
				}
			});
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
	socket?.end(undefined);
	socket = null;
}

export function isConnected(): boolean {
	return socket !== null;
}
