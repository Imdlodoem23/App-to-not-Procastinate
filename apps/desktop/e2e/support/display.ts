/**
 * One X display per Playwright worker on Linux.
 *
 * Under `xvfb-run` every worker's Electron app shares one X server, and X has one keyboard
 * focus: a window that another worker shows or focuses steals it from this worker's windows
 * (there is no window manager to keep each app's focus apart). The tray toggle reads the
 * focus (`windows/toggle.ts`: focused → hide, covered → raise), so a focus-sensitive test
 * failed whenever the other worker's app took the focus at the wrong moment. Each worker
 * therefore starts its own Xvfb (same screen as the `xvfb-run -s` of the docs) the first
 * time it launches the app, and every launch of that worker uses it.
 *
 * Without the `Xvfb` binary (or with `CENTRATE_E2E_SHARED_DISPLAY=1`) the launches keep the
 * inherited `DISPLAY`. The server is stopped when the worker exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** The screen `xvfb-run -s "-screen 0 2880x1800x24"` gives (docs/DESKTOP.md §12). */
const SCREEN = '2880x1800x24';
const START_TIMEOUT_MS = 10_000;

let started: Promise<string | null> | null = null;

/** This worker's `DISPLAY` (`:N`), or `null` to keep the inherited one. */
export function workerDisplay(): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(null);
  if (process.env['CENTRATE_E2E_SHARED_DISPLAY'] === '1') return Promise.resolve(null);
  started ??= startXvfb();
  return started;
}

function startXvfb(): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // -displayfd: Xvfb picks a free display number and writes it to fd 3 once it listens.
      child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', SCREEN, '-nolisten', 'tcp'], {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (display: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (display === null) child.kill();
      resolve(display);
    };
    const timer = setTimeout(() => finish(null), START_TIMEOUT_MS);
    child.once('error', () => finish(null));
    child.once('exit', () => finish(null));
    let out = '';
    const fd = child.stdio[3];
    fd?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const match = /^(\d+)\n/.exec(out);
      if (match) finish(`:${match[1]}`);
    });
    process.once('exit', () => child.kill());
    // The server must not keep the worker alive.
    child.unref();
    (fd as { unref?: () => void } | null | undefined)?.unref?.();
  });
}
