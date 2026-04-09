import QRCode from "qrcode";
import type { WhatsAppConnectionState } from "@/whatsapp/connection";

export async function renderSetupPage(
	state: WhatsAppConnectionState,
	qr: string | null,
): Promise<string> {
	let body: string;

	if (state === "connected") {
		const chatIdSet = !!process.env.ALLOWED_CHAT_ID;
		body = `<div class="status connected">Connected</div>
			<p>WhatsApp is paired and running.</p>
			${chatIdSet ? "" : "<p>Send a message on WhatsApp to see your chat ID.</p>"}`;
	} else if (qr) {
		const svg = await QRCode.toString(qr, { type: "svg", margin: 2 });
		body = `<div class="status pairing">Waiting for scan...</div>
			<div class="qr">${svg}</div>
			<p>Scan with WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>`;
	} else {
		body = `<div class="status connecting">${state === "logged_out" ? "Logged out" : "Connecting..."}</div>
			<p>${state === "logged_out" ? "Delete the auth folder and restart Klaus." : "Waiting for WhatsApp connection. Refresh in a few seconds."}</p>`;
	}

	const refresh =
		state !== "connected" && state !== "logged_out"
			? '<meta http-equiv="refresh" content="5">'
			: "";

	return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>Klaus Setup</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; text-align: center; color: #1a1a1a; }
h1 { margin-bottom: 0.5rem; }
.qr svg { width: 100%; max-width: 320px; }
.status { font-size: 1.25rem; font-weight: 600; margin: 1rem 0; }
.connected { color: #16a34a; }
.pairing { color: #ca8a04; }
.connecting { color: #6b7280; }
p { color: #4b5563; }
</style>
</head><body>
<h1>Klaus Setup</h1>
${body}
</body></html>`;
}
