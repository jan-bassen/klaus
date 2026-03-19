import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ConnectionUpdate = {
	connection?: "open" | "close";
	lastDisconnect?: { error?: { output?: { statusCode?: number } } };
	qr?: string;
};

type CredsHandler = () => void;
type ConnectionUpdateHandler = (
	update: ConnectionUpdate,
) => void | Promise<void>;

let lastConnectionUpdateHandler: ConnectionUpdateHandler | null = null;
const mockRequestPairingCode = mock(async (_phone: string) => "123-456");
const mockUseMultiFileAuthState = mock(async (_dir: string) => ({
	state: {},
	saveCreds: (() => {}) as CredsHandler,
}));
const mockFetchLatestBaileysVersion = mock(async () => ({
	version: [2, 3000, 0] as [number, number, number],
}));
const mockMakeWASocket = mock(() => ({
	ev: {
		on: (event: string, handler: unknown) => {
			if (event === "connection.update") {
				lastConnectionUpdateHandler = handler as ConnectionUpdateHandler;
			}
		},
	},
	requestPairingCode: mockRequestPairingCode,
	end: mock(() => {}),
}));

async function waitForConnectionHandler(): Promise<ConnectionUpdateHandler> {
	for (let attempt = 0; attempt < 10; attempt++) {
		if (lastConnectionUpdateHandler) return lastConnectionUpdateHandler;
		await Promise.resolve();
	}
	throw new Error("connection.update handler was not installed");
}

mock.module("@/logger", () => ({
	log: {
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		debug: mock(() => {}),
	},
}));

mock.module("@whiskeysockets/baileys", () => ({
	default: mockMakeWASocket,
	DisconnectReason: {
		loggedOut: 401,
	},
	fetchLatestBaileysVersion: mockFetchLatestBaileysVersion,
	useMultiFileAuthState: mockUseMultiFileAuthState,
}));

describe("whatsapp connection", () => {
	let originalPhone: string | undefined;

	beforeEach(() => {
		originalPhone = process.env.WHATSAPP_PHONE;
		process.env.WHATSAPP_PHONE = "+49 151 23456789";
		lastConnectionUpdateHandler = null;
		mockRequestPairingCode.mockClear();
		mockMakeWASocket.mockClear();
		mockUseMultiFileAuthState.mockClear();
		mockFetchLatestBaileysVersion.mockClear();
	});

	afterEach(async () => {
		if (originalPhone === undefined) {
			delete process.env.WHATSAPP_PHONE;
		} else {
			process.env.WHATSAPP_PHONE = originalPhone;
		}
	});

	test("requests pairing code only once for repeated qr updates in the same attempt", async () => {
		const connection = await import("@/whatsapp/connection");
		const startPromise = connection.startConnection();
		const updateConnection = await waitForConnectionHandler();

		await updateConnection({ qr: "qr-1" });
		await updateConnection({ qr: "qr-2" });
		await updateConnection({ qr: "qr-3" });

		expect(mockRequestPairingCode).toHaveBeenCalledTimes(1);
		expect(connection.getConnectionState()).toBe("pairing");

		await updateConnection({ connection: "open" });
		await startPromise;
		connection.closeSocket();
	});

	test("transitions through pairing, connected, disconnected, and logged_out states", async () => {
		const connection = await import("@/whatsapp/connection");
		const startPromise = connection.startConnection();
		const updateConnection = await waitForConnectionHandler();

		expect(connection.getConnectionState()).toBe("connecting");

		await updateConnection({ qr: "qr-1" });
		expect(connection.getConnectionState()).toBe("pairing");

		await updateConnection({ connection: "open" });
		await startPromise;

		expect(connection.isConnected()).toBe(true);
		expect(connection.getConnectionState()).toBe("connected");

		await updateConnection({
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: 500 } } },
		});
		expect(connection.isConnected()).toBe(false);
		expect(connection.getConnectionState()).toBe("disconnected");

		connection.closeSocket();
		expect(connection.getConnectionState()).toBe("idle");

		lastConnectionUpdateHandler = null;
		const loggedOutPromise = connection.startConnection();
		const nextUpdateConnection = await waitForConnectionHandler();

		expect(connection.getConnectionState()).toBe("connecting");

		await expect(
			nextUpdateConnection({
				connection: "close",
				lastDisconnect: { error: { output: { statusCode: 401 } } },
			}),
		).resolves.toBeUndefined();

		await expect(loggedOutPromise).rejects.toThrow("WhatsApp logged out");
		expect(connection.getConnectionState()).toBe("logged_out");

		connection.closeSocket();
		expect(connection.getConnectionState()).toBe("idle");
	});
});
