type Level = 'debug' | 'info' | 'warn' | 'error'

// Silent during test runs by default. Use _enableForTest() / _disableForTest() in logger tests.
let _silent = process.env.NODE_ENV === 'test';

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (_silent) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  (level === 'error' || level === 'warn' ? console.error : console.log)(
    JSON.stringify(entry)
  );
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
