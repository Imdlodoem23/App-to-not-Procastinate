import { PROTECTED_PROCESS_NAMES } from './data/index';
import type { CatalogPlatform } from './types';

const MAX_PROCESS_NAME_LENGTH = 128;
/** Path separators and characters Windows forbids in file names. */
const FORBIDDEN_CHARS_RE = /[\\/<>:"|?*]/;
/** Control, format (bidi overrides, zero-width), private-use and unassigned code points. */
const INVISIBLE_CHARS_RE = /\p{C}/u;

/**
 * True when `name` is a plain executable name the guardian can match: 1-128 characters,
 * no path separators, no control or invisible characters, no characters that Windows
 * forbids in file names, and no leading or trailing spaces.
 */
export function isValidProcessName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_PROCESS_NAME_LENGTH &&
    name === name.trim() &&
    name !== '.' &&
    name !== '..' &&
    !FORBIDDEN_CHARS_RE.test(name) &&
    !INVISIBLE_CHARS_RE.test(name)
  );
}

/**
 * Comparison key for a process name: Unicode NFC (macOS file names come decomposed) and,
 * on Windows and macOS, lowercase, because those file systems ignore case.
 */
export function processNameKey(name: string, platform: CatalogPlatform): string {
  const composed = name.normalize('NFC');
  return platform === 'linux' ? composed : composed.toLowerCase();
}

/**
 * Deny-list key, the same as the guardian's `denyKey` (guardian/internal/procwatch/fold.go):
 * trimmed, lowercase, without accents and without a trailing `.exe` or `.app`.
 */
function protectedKey(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/\.app$/, '')
    .trim();
}

const PROTECTED_KEYS: ReadonlySet<string> = new Set(PROTECTED_PROCESS_NAMES.map(protectedKey));

/**
 * Keys that protect every name starting with them: the Céntrate app, its helpers, the
 * guardian, the installers («Céntrate Setup 1.0.0.exe») and the uninstaller. Same as the
 * guardian's `protectedPrefixes`.
 */
const PROTECTED_PREFIXES: readonly string[] = ['centrate', 'uninstall centrate'];

/**
 * True for processes that must never be killed (system processes, Task Manager and
 * Settings, accessibility tools, Céntrate itself). Case-insensitive, accent-insensitive
 * and with or without `.exe`/`.app` on every platform, like the guardian's deny-list and
 * on purpose stricter than normal matching.
 */
export function isProtectedProcessName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const key = protectedKey(name);
  if (key.length === 0) return false;
  return PROTECTED_KEYS.has(key) || PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}
