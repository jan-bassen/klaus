import { settings } from "@/config";

type Level = "debug" | "info" | "warn" | "error";

// JSON mode for machine-readable logs (Docker, NAS viewers). Text mode is default.
// Tests always use JSON so assertions can parse output.
const JSON_MODE =
	process.env.NODE_ENV === "test" || settings.log.format === "json";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const LEVEL_COLOR: Record<Level, string> = {
	debug: DIM,
	info: CYAN,
	warn: YELLOW,
	error: RED,
};
const LEVEL_LABEL: Record<Level, string> = {
	debug: "DBG",
	info: "INF",
	warn: "WRN",
	error: "ERR",
};

const MODULE_RE = /^\[([^\]]+)\]\s*/;

function formatText(level: Level, msg: string): string {
	const time = new Date().toISOString().slice(11, 23);
	const badge = `${LEVEL_COLOR[level]}${LEVEL_LABEL[level]}${RESET}`;

	const match = MODULE_RE.exec(msg);
	if (match) {
		const module = match[1];
		const rest = msg.slice(match[0].length);
		return `${DIM}${time}${RESET} ${badge} ${CYAN}${BOLD}[${module}]${RESET} ${rest}`;
	}
	return `${DIM}${time}${RESET} ${badge} ${msg}`;
}

// Silenced during test runs so assertions can inspect stdout/stderr without noise.
const SILENT = process.env.NODE_ENV === "test";

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
	if (SILENT) return;
	const line = JSON_MODE
		? JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })
		: formatText(level, msg);
	(level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
	debug: (msg: string, data?: Record<string, unknown>) =>
		emit("debug", msg, data),
	info: (msg: string, data?: Record<string, unknown>) =>
		emit("info", msg, data),
	warn: (msg: string, data?: Record<string, unknown>) =>
		emit("warn", msg, data),
	error: (msg: string, data?: Record<string, unknown>) =>
		emit("error", msg, data),
};
