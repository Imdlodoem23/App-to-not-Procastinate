/**
 * The app token (docs/ARCHITECTURE.md §9.2, docs/DESKTOP.md §6.1).
 *
 * The guardian writes `<sys>/client.json` = `{v, port, token, guardianVersion, pid, issuedAt}`
 * atomically on **every** start (the token rotates), world-readable, admin-writable. The
 * main process reads it at startup and again whenever the file changed (mtime, size or
 * inode), which also covers the client's re-read after a 401. The token never leaves the
 * main process: it is not logged, not put in the snapshot and not sent over IPC.
 *
 * `<sys>`: `%ProgramData%\Centrate`, `/Library/Application Support/Centrate`,
 * `/var/lib/centrate`; `CENTRATE_DATA_DIR` overrides it only when the app is unpackaged (the
 * guardian's own test variable, used by the wire e2e tests with a mock guardian).
 */
import * as nodeFs from 'node:fs';
import { posix, win32 } from 'node:path';
import { APP_TOKEN_PREFIX, DEFAULT_GUARDIAN_PORT } from '@centrate/shared/guardian-api';
import type { Platform } from '../../shared/ui-state';
import { HARNESS_ENV } from '../contracts';

export const CLIENT_JSON_NAME = 'client.json';

/** The guardian's system directory for a platform (without overrides). */
export function defaultSysDir(platform: Platform, env: Readonly<Record<string, string | undefined>> = {}): string {
  if (platform === 'win32') {
    const programData = env['ProgramData'] || env['PROGRAMDATA'] || 'C:\\ProgramData';
    return win32.join(programData, 'Centrate');
  }
  if (platform === 'darwin') return '/Library/Application Support/Centrate';
  return '/var/lib/centrate';
}

/** `CENTRATE_DATA_DIR` when unpackaged and absolute, else the platform default. */
export function resolveSysDir(options: {
  platform: Platform;
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): string {
  const override = options.env[HARNESS_ENV.sysDir];
  if (!options.packaged && override && isAbsolutePath(override, options.platform)) return override;
  return defaultSysDir(options.platform, options.env);
}

export function clientJsonPath(sysDir: string, platform: Platform): string {
  return platform === 'win32' ? win32.join(sysDir, CLIENT_JSON_NAME) : posix.join(sysDir, CLIENT_JSON_NAME);
}

function isAbsolutePath(path: string, platform: Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path);
}

export interface ClientJson {
  v: 1;
  port: number;
  token: string;
  guardianVersion: string;
  pid: number;
  issuedAt: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** Strict-enough check of `client.json` (unknown fields ignored, like API responses). */
export function parseClientJson(text: string): ClientJson | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const port = r['port'] ?? DEFAULT_GUARDIAN_PORT;
  const token = r['token'];
  if (r['v'] !== 1) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (typeof token !== 'string' || !token.startsWith(APP_TOKEN_PREFIX) || !TOKEN_RE.test(token)) {
    return null;
  }
  const guardianVersion = typeof r['guardianVersion'] === 'string' ? r['guardianVersion'] : '';
  const pid = typeof r['pid'] === 'number' && Number.isInteger(r['pid']) ? r['pid'] : 0;
  const issuedAt = typeof r['issuedAt'] === 'string' ? r['issuedAt'] : '';
  return { v: 1, port, token, guardianVersion, pid, issuedAt };
}

/** What the core needs from the token file. */
export interface TokenSource {
  /** The current token (re-reads the file when it changed); `null` when missing or invalid. */
  token(): string | null;
  /** Port from the file, else 47600. */
  port(): number;
  /** `client.json` does not exist: the guardian is not installed (`not_installed`). */
  missing(): boolean;
  /** Guardian version written in the file (diagnostics), or `null`. */
  guardianVersion(): string | null;
}

export interface ClientJsonFs {
  statSync(path: string): { mtimeMs: number; size: number; ino: number };
  readFileSync(path: string, encoding: 'utf8'): string;
}

/**
 * Reads `client.json` lazily. Every call stats the file (cheap) and re-reads it only when
 * mtime, size or inode changed, so a rotated token (guardian restart) is picked up by the
 * next request, including the client's automatic retry after a 401.
 */
export function createClientJsonSource(path: string, fs: ClientJsonFs = nodeFs): TokenSource {
  let stamp: string | null = null;
  let parsed: ClientJson | null = null;
  let isMissing = true;

  function refresh(): void {
    let st: { mtimeMs: number; size: number; ino: number };
    try {
      st = fs.statSync(path);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      isMissing = code === 'ENOENT' || code === 'ENOTDIR';
      stamp = null;
      parsed = null;
      return;
    }
    isMissing = false;
    const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (next === stamp && parsed !== null) return;
    try {
      parsed = parseClientJson(fs.readFileSync(path, 'utf8'));
      stamp = parsed ? next : null;
    } catch {
      parsed = null;
      stamp = null;
    }
  }

  return {
    token(): string | null {
      refresh();
      return parsed?.token ?? null;
    },
    port(): number {
      refresh();
      return parsed?.port ?? DEFAULT_GUARDIAN_PORT;
    },
    missing(): boolean {
      refresh();
      return isMissing;
    },
    guardianVersion(): string | null {
      refresh();
      return parsed?.guardianVersion || null;
    },
  };
}

/** A fixed source (harness and mock mode). */
export function staticTokenSource(options: { missing: boolean; port?: number }): TokenSource {
  return {
    token: () => (options.missing ? null : `${APP_TOKEN_PREFIX}harness-token`),
    port: () => options.port ?? DEFAULT_GUARDIAN_PORT,
    missing: () => options.missing,
    guardianVersion: () => null,
  };
}
