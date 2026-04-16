import { beforeEach, describe, expect, test, vi } from "vitest";

type SocketOpenHandler = (socket: unknown) => void | Promise<void>;

const {
	mockWriteQrToVault,
	mockClearLoginFolder,
	mockMakeWASocket,
	mockUseMultiFileAuthState,
	mockFetchLatestBaileysVersion,
} = vi.hoisted(() => {
	const mockWriteQrToVault = vi.fn(async (_qr: string) => {});
	const mockClearLoginFolder = vi.fn(async () => {});
	const mockMakeWASocket = vi.fn(() => ({
		ev: {
			on: (event: string, handler: unknown) => {
				if (event === "connection.update") {
					lastConnectionUpdateHandler = handler as ConnectionUpdateHandler;
				}
			},
		},
		end: vi.fn(() => {}),
	}));
	const mockUseMultiFileAuthState = vi.fn(async (_dir: string) => ({
		state: {},
		saveCreds: (() => {}) as CredsHandler,
	}));
	const mockFetchLatestBaileysVersion = vi.fn(async () => ({
		version: [2, 3000, 0] as [number, number, number],
	}));
	return {
		mockWriteQrToVault,
		mockClearLoginFolder,
		mockMakeWASocket,
		mockUseMultiFileAuthState,
		mockFetchLatestBaileysVersion,
	};
});

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

async function waitForConnectionHandler(): Promise<ConnectionUpdateHandler> {
	for (let attempt = 0; attempt < 10; attempt++) {
		if (lastConnectionUpdateHandler) return lastConnectionUpdateHandler;
		await Promise.resolve();
	}
	throw new Error("connection.update handler was not installed");
}

vi.mock("@/whatsapp/login", () => ({
	writeQrToVault: mockWriteQrToVault,
	clearLoginFolder: mockClearLoginFolder,
	ensureLoginFolder: vi.fn(async () => {}),
}));

vi.mock("@/logger", () => ({
	log: {
		info: vi.fn(() => {}),
		warn: vi.fn(() => {}),
		error: vi.fn(() => {}),
		debug: vi.fn(() => {}),
	},
}));

vi.mock("@whiskeysockets/baileys", () => ({
	default: mockMakeWASocket,
	DisconnectReason: {
		loggedOut: 401,
	},
	jidNormalizedUser: (jid: string) => jid,
	fetchLatestBaileysVersion: mockFetchLatestBaileysVersion,
	useMultiFileAuthState: mockUseMultiFileAuthState,
}));

describe("whatsapp connection", () => {
	beforeEach(() => {
		lastConnectionUpdateHandler = null;
		mockWriteQrToVault.mockClear();
		mockClearLoginFolder.mockClear();
		mockMakeWASocket.mockClear();
		mockUseMultiFileAuthState.mockClear();
		mockFetchLatestBaileysVersion.mockClear();
	});

	test("transitions to pairing while qr is available before connecting", async () => {
		const connection = await import("@/whatsapp/connection");
		const startPromise = connection.startConnection();
		const updateConnection = await waitForConnectionHandler();

		await updateConnection({ qr: "qr-1" });
		expect(connection.getConnectionState()).toBe("pairing");
		expect(mockWriteQrToVault).toHaveBeenCalledWith("qr-1");

		await updateConnection({ qr: "qr-2" });
		expect(connection.getConnectionState()).toBe("pairing");
		expect(mockWriteQrToVault).toHaveBeenCalledWith("qr-2");

		await updateConnection({ qr: "qr-3" });
		expect(connection.getConnectionState()).toBe("pairing");
		expect(mockWriteQrToVault).toHaveBeenCalledWith("qr-3");

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

	test("calls the socket-open callback on initial connect and reconnect", async () => {
		const connection = await import("@/whatsapp/connection");
		const onOpen = vi.fn((_socket: unknown) => {});
		const startPromise = connection.startConnection(
			onOpen as SocketOpenHandler,
		);
		const firstUpdateConnection = await waitForConnectionHandler();

		await firstUpdateConnection({ connection: "open" });
		await startPromise;

		expect(onOpen).toHaveBeenCalledTimes(1);
		const firstSocket = onOpen.mock.calls[0]?.[0];
		expect(firstSocket).toBeDefined();

		await firstUpdateConnection({
			connection: "close",
			lastDisconnect: { error: { output: { statusCode: 500 } } },
		});
		expect(connection.getConnectionState()).toBe("disconnected");

		for (let attempt = 0; attempt < 10; attempt++) {
			if (mockMakeWASocket.mock.calls.length >= 2) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}

		expect(mockMakeWASocket.mock.calls.length).toBeGreaterThanOrEqual(2);

		const secondUpdateConnection = await waitForConnectionHandler();
		await secondUpdateConnection({ connection: "open" });

		expect(onOpen).toHaveBeenCalledTimes(2);
		const secondSocket = onOpen.mock.calls[1]?.[0];
		expect(secondSocket).toBeDefined();
		expect(secondSocket).not.toBe(firstSocket);

		connection.closeSocket();
	});
});
