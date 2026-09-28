/**
 * The app shell's logging: MAIN-GUARDIAN's process-wide app log (`logs/logger.ts`,
 * `userData/logs/app.log`, rotated and scrubbed), or the console while that is still the
 * no-op logger (before `initAppLog`, and in unit tests). Events are snake_case names with
 * primitive fields: never reasons, domains, tokens or pairing codes.
 */
import { appLog as sharedLog, type LogFields } from '../logs/logger';

export type { LogFields };

export interface AppLog {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function consoleLine(scope: string, event: string, fields?: LogFields): string {
  const extra = fields
    ? Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ')
    : '';
  return `[${scope}] ${event}${extra ? ` ${extra}` : ''}`;
}

/** A logger whose events are prefixed with `scope` (`windows.show`, `tray.icon_missing`). */
export function appLog(scope: string): AppLog {
  const write = (level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void => {
    const shared = sharedLog();
    if (shared.file !== null) {
      shared[level](`${scope}.${event}`, fields);
      return;
    }
    console[level](consoleLine(scope, event, fields));
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
