type Level = 'debug' | 'info' | 'warn' | 'error'

// Pretty by default; set LOG_FORMAT=json for newline-delimited JSON (e.g. log aggregators).
const PRETTY = process.env.NODE_ENV !== 'test' && process.env.LOG_FORMAT !== 'json';

const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const WHITE  = '\x1b[37m';

const LEVEL_COLOR: Record<Level, string> = { debug: DIM, info: CYAN, warn: YELLOW, error: RED };
const LEVEL_LABEL: Record<Level, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

function serializeValue(v: unknown): string {
  if (v instanceof Error) return `"${v.name}: ${v.message.replace(/\n/g, '\\n')}"`;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') {
    const s = v.replace(/\n/g, '\\n');
    return s.includes(' ') ? `"${s}"` : s;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 80 ? `"${s.slice(0, 77)}\u2026"` : s;
}

function formatKV(data: Record<string, unknown>): string {
  const pairs = Object.entries(data).map(([k, v]) => `${k}=${serializeValue(v)}`).join(' ');
  return pairs ? `  ${DIM}${pairs}${RESET}` : '';
}

function formatPretty(level: Level, msg: string, data?: Record<string, unknown>): string {
  const time = new Date().toISOString().slice(11, 23);
  const badge = `${LEVEL_COLOR[level]}${LEVEL_LABEL[level]}${RESET}`;
  return `${DIM}${time}${RESET} ${badge} ${WHITE}${msg}${RESET}${data ? formatKV(data) : ''}`;
}

// Silent during test runs by default. Use _enableForTest() / _disableForTest() in logger tests.
let _silent = process.env.NODE_ENV === 'test';

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (_silent) return;
  const line = PRETTY
    ? formatPretty(level, msg, data)
    : JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => emit('info',  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => emit('warn',  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
}

/** Test-only: re-enable log output so logger behaviour can be asserted. */
export function _enableForTest(): void  { _silent = false; }
/** Test-only: restore silent mode after logger tests. */
export function _disableForTest(): void { _silent = true;  }
