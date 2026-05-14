type Level = "debug" | "info" | "warn" | "error";
type LogFormat = "text" | "json";

// JSON mode for machine-readable logs (Docker, NAS viewers). Text mode is default.
// Tests always use JSON so assertions can parse output.
let logFormat: LogFormat = process.env.LOG_FORMAT === "json" ? "json" : "text";

export function configureLogger(format: LogFormat): void {
	logFormat = format;
}

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

function formatText(
	level: Level,
	msg: string,
	data?: Record<string, unknown>,
): string {
	const time = new Date().toISOString().slice(11, 23);
	const badge = `${LEVEL_COLOR[level]}${LEVEL_LABEL[level]}${RESET}`;
	const tail =
		data && Object.keys(data).length > 0
			? ` ${DIM}${formatData(data)}${RESET}`
			: "";

	const match = MODULE_RE.exec(msg);
	if (match) {
		const module = match[1];
		const rest = msg.slice(match[0].length);
		return `${DIM}${time}${RESET} ${badge} ${CYAN}${BOLD}[${module}]${RESET} ${rest}${tail}`;
	}
	return `${DIM}${time}${RESET} ${badge} ${msg}${tail}`;
}

function formatData(data: Record<string, unknown>): string {
	return Object.entries(data)
		.map(([k, v]) => `${k}=${formatValue(v)}`)
		.join(" ");
}

function formatValue(v: unknown): string {
	if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
	if (v instanceof Error) return JSON.stringify(v.message);
	if (typeof v === "object" && v !== null) return JSON.stringify(v);
	return String(v);
}

// Silenced during test runs so assertions can inspect stdout/stderr without noise.
const SILENT = process.env.NODE_ENV === "test";

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
	if (SILENT) return;
	const line =
		logFormat === "json"
			? JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })
			: formatText(level, msg, data);
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
