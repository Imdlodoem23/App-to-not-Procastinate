/**
 * Running process names for the apps autocomplete in Bloqueos (PROMPT §4 «apps con
 * autocompletado de los procesos abiertos»). Fixed commands only:
 * - Windows: `tasklist /FO CSV /NH` (image names such as `Discord.exe`);
 * - macOS: `/bin/ps -axco comm=` (executable names);
 * - Linux: `/proc/<pid>/exe` base names of the user's own processes, else `/proc/<pid>/comm`.
 *
 * The list stays in memory for the Bloqueos window; it is never logged.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import type { Platform } from '../../shared/ui-state';
import type { ExecRunner } from './exec';

export const PROCESS_LIST_MAX = 400;
const TIMEOUT_MS = 5_000;

/** `"Discord.exe","1234","Console","1","120.000 K"` lines → image names. */
export function parseTasklistCsv(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** One name per line (`ps -axco comm=`). */
export function parsePsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Unique (case-insensitive), sorted, without kernel threads or helpers that are not apps. */
export function normalizeProcessNames(
  names: readonly string[],
  max: number = PROCESS_LIST_MAX,
): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === '' || name.length > 128) continue;
    if (/^\[.*\]$/.test(name) || /[\\/]/.test(name)) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
    .slice(0, max);
}

function linuxProcessNames(): string[] {
  const names: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      names.push(basename(readlinkSync(`/proc/${entry}/exe`)).replace(/ \(deleted\)$/, ''));
      continue;
    } catch {
      // not ours: fall back to comm
    }
    try {
      names.push(readFileSync(`/proc/${entry}/comm`, 'utf8').trim());
    } catch {
      // process gone
    }
  }
  return names;
}

export async function listProcessNames(platform: Platform, exec: ExecRunner): Promise<string[]> {
  if (platform === 'win32') {
    const r = await exec('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: TIMEOUT_MS });
    return normalizeProcessNames(parseTasklistCsv(r.stdout));
  }
  if (platform === 'darwin') {
    const r = await exec('/bin/ps', ['-axco', 'comm='], { timeoutMs: TIMEOUT_MS });
    return normalizeProcessNames(parsePsOutput(r.stdout));
  }
  return normalizeProcessNames(linuxProcessNames());
}
