/**
 * Running processes for the apps autocomplete in Bloqueos (`system:processes`), each with the
 * catalog app it belongs to. **Fixed commands** (ARCHITECTURE §9.7):
 *
 * - Windows: `tasklist /fo csv /nh`;
 * - macOS: `/bin/ps -axo comm=` (full executable paths: the base name is kept);
 * - Linux: `ps -eo comm=`.
 *
 * Protected processes (the system, the shell, Céntrate itself) are left out: they can never be
 * blocked. The list stays in memory for the Bloqueos window and is never logged.
 */
import { findAppByProcessName, isProtectedProcessName } from '@centrate/shared/catalog';
import type { RunningProcess } from '../../shared/platform';
import type { Platform } from '../../shared/ui-state';
import { catalogPlatform } from '../activewin/match';
import type { ExecRunner } from '../system/exec';
import { normalizeProcessNames, parsePsOutput, parseTasklistCsv } from '../system/processes';

const TIMEOUT_MS = 5_000;

/** `/Applications/Discord.app/Contents/MacOS/Discord` → `Discord`. */
export function processBaseName(path: string): string {
  const trimmed = path.trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Names → unique running processes with their catalog app (protected ones dropped). */
export function toRunningProcesses(names: readonly string[], platform: Platform): RunningProcess[] {
  const cp = catalogPlatform(platform);
  return normalizeProcessNames(names.map(processBaseName))
    .filter((name) => !isProtectedProcessName(name))
    .map((name) => ({ name, appId: findAppByProcessName(name, cp)?.id ?? null }));
}

export async function listRunningProcesses(
  platform: Platform,
  exec: ExecRunner,
): Promise<RunningProcess[]> {
  if (platform === 'win32') {
    const r = await exec('tasklist', ['/fo', 'csv', '/nh'], { timeoutMs: TIMEOUT_MS });
    return toRunningProcesses(parseTasklistCsv(r.stdout), platform);
  }
  if (platform === 'darwin') {
    const r = await exec('/bin/ps', ['-axo', 'comm='], { timeoutMs: TIMEOUT_MS });
    return toRunningProcesses(parsePsOutput(r.stdout), platform);
  }
  const r = await exec('ps', ['-eo', 'comm='], { timeoutMs: TIMEOUT_MS });
  return toRunningProcesses(parsePsOutput(r.stdout), platform);
}
