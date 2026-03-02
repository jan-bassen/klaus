import path from 'path';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';

let socket: WASocket | null = null;

const AUTH_DIR =
  process.env.BAILEYS_AUTH_DIR ?? path.join(process.cwd(), '.baileys-auth');

/**
 * Initialize Baileys, handle QR pairing on first run, and manage reconnects.
 * Returns the active WASocket once the connection is open.
 *
 * On disconnect: logs the reason. If not a deliberate logout, the process
 * should be restarted by the supervisor (PM2, systemd, Docker restart policy).
 */
export async function startConnection(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise<WASocket>((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        socket = sock;
        console.log('[whatsapp] connected');
        resolve(sock);
      } else if (connection === 'close') {
        const code = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          const msg = '[whatsapp] logged out — delete .baileys-auth and restart';
          console.error(msg);
          // Only reject if we haven't resolved yet (never connected)
          reject(new Error(msg));
        } else {
          console.warn(
            `[whatsapp] disconnected (code ${code ?? 'unknown'}) — restart process to reconnect`,
          );
        }
      }
    });
  });
}

export function getSocket(): WASocket {
  if (!socket) throw new Error('WhatsApp socket not initialized — call startConnection() first');
  return socket;
}
