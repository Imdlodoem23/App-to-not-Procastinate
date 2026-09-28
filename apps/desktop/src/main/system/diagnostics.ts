/**
 * «Copiar diagnóstico» (docs/DESKTOP.md §6.6, ARCHITECTURE §8.8 `/v1/diagnostics`). Main
 * writes the text to the clipboard itself; it never crosses IPC.
 *
 * - Guardian answering: `GET /v1/diagnostics` (no domains, reasons, tasks or usernames by
 *   contract) plus app info (version, OS, link, counts) and the last 20 app-log lines.
 * - Guardian not answering: the health error code, the JSON of the unprivileged
 *   `centrate-guardian status`, the last 200 lines of `<sys>/logs/guardian.log` (no personal
 *   data by contract) and the app-log tail.
 *
 * Every line goes through `scrubLogText` (tokens, `Authorization`, the home directory), and
 * the snapshot contributes only counts and versions: never reasons, targets or codes.
 */
import { posix, win32 } from 'node:path';
import type { GuardianClient } from '@centrate/shared/guardian-api';
import { UI_TIMINGS, toUiError, type Platform, type UiSnapshot } from '../../shared/ui-state';
import type { Clock } from '../contracts';
import { withTimeout } from '../guardian/client';
import { scrubLogText, type AppLogger } from '../logs/logger';

export const APP_LOG_TAIL_LINES = 20;
export const GUARDIAN_LOG_TAIL_LINES = 200;

export interface DiagnosticsDeps {
  client: GuardianClient;
  clock: Clock;
  snapshot: UiSnapshot;
  appLog: AppLogger;
  sysDir: string;
  platform: Platform;
  /** `centrate-guardian status` output (or why it failed). */
  guardianStatus: () => Promise<string>;
  /** Reads a text file; `null` when it cannot. */
  readText: (path: string) => string | null;
  runtime: { os: string; arch: string; electron: string | null; node: string };
}

export interface DiagnosticsResult {
  text: string;
  source: 'guardian' | 'fallback';
}

/** Counts and versions only (no reasons, targets or ids). */
export function snapshotSummary(s: UiSnapshot): Record<string, unknown> {
  const state = s.state;
  return {
    link: { status: s.link.status, reason: s.link.reason, failures: s.link.failures },
    guardian: s.health
      ? {
          version: s.health.version,
          apiVersion: s.health.apiVersion,
          mode: s.health.mode,
          problems: s.health.problems,
          capabilities: s.health.capabilities.length,
        }
      : null,
    state: state
      ? {
          stateVersion: state.stateVersion,
          lastEventSeq: state.lastEventSeq,
          clockTrust: state.clock.trust,
          wallOffsetMs: state.clock.wallOffsetMs,
          hosts: state.protection.hosts.status,
          processWatcher: state.protection.processWatcher.ok,
          extensions: state.protection.extensions.map((e) => ({
            browser: e.browser,
            version: e.extVersion,
            connected: e.connected,
            protecting: e.protecting,
            incognito: e.incognitoAllowed,
            hostPermission: e.hostPermission,
          })),
          browsersWithoutExtension: state.protection.browsersWithoutExtension,
          blocks: state.blocks.length,
          modes: state.blocks.map((b) => b.mode),
          punishments: state.punishments.length,
          emergency: state.emergency?.status ?? null,
        }
      : null,
    ops: {
      create: s.ops.create?.status ?? null,
      extendQueue: s.ops.extendQueue.map((e) => e.status),
    },
    features: s.features,
  };
}

function scrubLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => scrubLogText(line, 2_000))
    .join('\n');
}

function tail(text: string | null, lines: number): string {
  if (text === null) return '(no disponible)';
  const all = text.split(/\r?\n/).filter((l) => l !== '');
  return all.slice(-lines).join('\n');
}

export async function buildDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsResult> {
  const { client, clock, snapshot, appLog, runtime } = deps;
  const header = [
    'Céntrate · diagnóstico',
    `generado: ${new Date(clock.now()).toISOString()}`,
    `app: ${JSON.stringify({
      version: snapshot.app.version,
      packaged: snapshot.app.packaged,
      platform: snapshot.app.platform,
      os: runtime.os,
      arch: runtime.arch,
      electron: runtime.electron,
      node: runtime.node,
    })}`,
    `resumen: ${JSON.stringify(snapshotSummary(snapshot))}`,
  ];
  const appTail = appLog.tail(APP_LOG_TAIL_LINES).join('\n') || '(vacío)';

  try {
    const diagnostics = await withTimeout(client.diagnostics(), clock, UI_TIMINGS.requestTimeoutMs);
    const text = [
      ...header,
      '',
      '== guardián (/v1/diagnostics) ==',
      JSON.stringify(diagnostics, null, 2),
      '',
      `== registro de la app (últimas ${APP_LOG_TAIL_LINES} líneas) ==`,
      appTail,
    ].join('\n');
    return { text: scrubLines(text), source: 'guardian' };
  } catch (error) {
    let healthLine: string;
    try {
      await withTimeout(client.health(), clock, UI_TIMINGS.requestTimeoutMs);
      healthLine = `health: ok (diagnostics: ${toUiError(error).code})`;
    } catch (healthError) {
      const e = toUiError(healthError);
      healthLine = `health: ${e.code}${e.status ? ` (HTTP ${e.status})` : ''}`;
    }
    const path = deps.platform === 'win32' ? win32 : posix;
    const logFile = path.join(deps.sysDir, 'logs', 'guardian.log');
    const text = [
      ...header,
      '',
      '== guardián: sin respuesta ==',
      healthLine,
      '',
      '== centrate-guardian status ==',
      await deps.guardianStatus().catch(() => 'status failed'),
      '',
      `== guardian.log (últimas ${GUARDIAN_LOG_TAIL_LINES} líneas) ==`,
      tail(deps.readText(logFile), GUARDIAN_LOG_TAIL_LINES),
      '',
      `== registro de la app (últimas ${APP_LOG_TAIL_LINES} líneas) ==`,
      appTail,
    ].join('\n');
    return { text: scrubLines(text), source: 'fallback' };
  }
}
