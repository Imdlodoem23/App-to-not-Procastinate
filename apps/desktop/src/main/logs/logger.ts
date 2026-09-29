/**
 * The app log (docs/DESKTOP.md §6.6): `userData/logs/app.log`, rotated at 1 MiB into
 * `app.log.1` and `app.log.2` (3 files at most).
 *
 * No personal data, by construction and by a last-line scrubber:
 * - callers log an event name plus primitive fields that hold codes, counts and ids, never
 *   reasons, domains, typed phrases, tokens or pairing codes;
 * - every string is scrubbed anyway: app and extension tokens (`cta_…`, `cte_…`),
 *   `Authorization`/`Bearer` values and the home directory (usernames) are replaced, control
 *   characters removed and length capped.
 *
 * `appLog()` is the process-wide logger (a no-op until `initAppLog`), so MAIN-WINDOW can log
 * `app:renderer-error` through `logRendererError` without a reference to the core.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_LOG_FILE = 'app.log';
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_MAX_FILES = 3;
const VALUE_MAX = 300;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface AppLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Last `lines` lines (current file, then the previous one if needed). */
  tail(lines: number): string[];
  /** Where it writes (`null` for the no-op and memory loggers). */
  readonly file: string | null;
}

let home: string | null = null;
function homeDir(): string | null {
  if (home === null) {
    try {
      home = homedir();
    } catch {
      home = '';
    }
  }
  return home || null;
}

/** Removes secrets and usernames from one value (also used by diagnostics). */
export function scrubLogText(value: string, max: number = VALUE_MAX): string {
  let out = value
    .replace(/\bct[ae]_[A-Za-z0-9_-]+/g, (m) => `${m.slice(0, 4)}[redacted]`)
    .replace(/\b(Bearer)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/("?authorization"?\s*[:=]\s*)("[^"]*"|[^\s,;]+)/gi, '$1[redacted]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const h = homeDir();
  if (h && h.length > 1) out = out.split(h).join('~');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function formatValue(value: string | number | boolean | null): string {
  if (typeof value === 'string') {
    const clean = scrubLogText(value);
    return /^[A-Za-z0-9_.:/@+-]*$/.test(clean) && clean !== '' ? clean : JSON.stringify(clean);
  }
  return String(value);
}

export function formatLogLine(
  atMs: number,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): string {
  const parts = [new Date(atMs).toISOString(), level.toUpperCase(), scrubLogText(event, 80)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || !/^[A-Za-z0-9_.]{1,40}$/.test(key)) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

export interface FileLoggerOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
  /** Also print to stderr (unpackaged runs). */
  echo?: boolean;
  minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createFileLogger(options: FileLoggerOptions): AppLogger {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? LOG_MAX_FILES);
  const now = options.now ?? Date.now;
  const minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
  const file = join(options.dir, APP_LOG_FILE);
  let size: number | null = null;
  let broken = false;

  function currentSize(): number {
    if (size === null) {
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    return size;
  }

  function rotate(): void {
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          // keep going: a failed rotation only loses old lines
        }
      }
    }
    size = 0;
  }

  function write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < minLevel) return;
    const line = `${formatLogLine(now(), level, event, fields)}\n`;
    if (options.echo) process.stderr.write(line);
    if (broken) return;
    try {
      mkdirSync(options.dir, { recursive: true });
      const bytes = Buffer.byteLength(line);
      if (currentSize() + bytes > maxBytes && currentSize() > 0) rotate();
      appendFileSync(file, line, { encoding: 'utf8' });
      size = currentSize() + bytes;
    } catch {
      // Logging must never break the app (read-only profile, disk full…).
      broken = true;
    }
  }

  return {
    file,
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    tail(lines: number): string[] {
      const read = (path: string): string[] => {
        try {
          return readFileSync(path, 'utf8')
            .split('\n')
            .filter((l) => l !== '');
        } catch {
          return [];
        }
      };
      let out = read(file);
      if (out.length < lines && maxFiles > 1) out = [...read(`${file}.1`), ...out];
      return out.slice(-lines);
    },
  };
}

/** Keeps lines in memory (tests, harness). */
export function createMemoryLogger(now: () => number = Date.now): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    lines.push(formatLogLine(now(), level, event, fields));
    if (lines.length > 1_000) lines.shift();
  };
  return {
    lines,
    file: null,
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
    tail: (n) => lines.slice(-n),
  };
}

const NOOP: AppLogger = {
  file: null,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  tail: () => [],
};

let shared: AppLogger = NOOP;

/** The process-wide app logger (no-op until `initAppLog`). */
export function appLog(): AppLogger {
  return shared;
}

export function setAppLog(logger: AppLogger): void {
  shared = logger;
}

/** Create the file logger in `<userData>/logs` and make it the process-wide one. */
export function initAppLog(userDataDir: string, options: { echo?: boolean } = {}): AppLogger {
  const logger = createFileLogger({ dir: join(userDataDir, 'logs'), echo: options.echo ?? false });
  setAppLog(logger);
  return logger;
}

/**
 * `app:renderer-error`: only the error's first line and the first stack frames, scrubbed.
 * Messages can quote UI text, so they are capped short.
 */
export function logRendererError(message: string, stack: string | null): void {
  const firstLine = (message.split('\n')[0] ?? '').slice(0, 160);
  const frames = (stack ?? '')
    .split('\n')
    .filter((l) => l.trim().startsWith('at '))
    .slice(0, 3)
    .map((l) => l.trim().replace(/\((?:file|https?):\/\/[^)]*\/([^/)]+)\)/g, '($1)'))
    .join(' | ');
  shared.error('renderer_error', { message: firstLine, stack: frames || null });
}
