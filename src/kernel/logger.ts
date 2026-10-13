export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Fields = Record<string, unknown>;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /pass|token|secret|cookie|authorization|pepper|api_?key|private|credential/i;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

/** Remove anything that looks like a credential before it can reach a log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '…' : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level: LogLevel;
  sink?: (line: string) => void;
  base?: Fields;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const base = options.base ?? {};
  const write = (level: LogLevel, message: string, fields?: Fields): void => {
    if (ORDER[level] < ORDER[options.level]) return;
    const line = { ts: new Date().toISOString(), level, msg: message, ...(redact({ ...base, ...fields }) as Fields) };
    sink(JSON.stringify(line));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });
