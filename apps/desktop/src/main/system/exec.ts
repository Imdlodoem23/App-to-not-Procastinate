/**
 * Runs a **fixed** executable with **fixed** arguments (`execFile`, never a shell string
 * built from data: ARCHITECTURE §9.7). Used for the bundled guardian CLI (`status`,
 * `version`, elevated `install`/`start`), `tasklist`/`ps` and the elevation helpers.
 */
import { execFile } from 'node:child_process';

export interface ExecResult {
  /** Exit code; `null` when killed (timeout) or when it could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (`ENOENT`…) or `timeout`. */
  error: string | null;
}

export interface ExecOptions {
  timeoutMs: number;
  /** Extra environment variables (the rest is inherited). */
  env?: Readonly<Record<string, string>>;
  maxBuffer?: number;
}

export type ExecRunner = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export const runFile: ExecRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: 'utf8',
        env: options.env ? { ...process.env, ...options.env } : process.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr, error: null });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
        const code = typeof e.code === 'number' ? e.code : null;
        const spawnError = typeof e.code === 'string' ? e.code : e.killed ? 'timeout' : null;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', error: spawnError });
      },
    );
  });
