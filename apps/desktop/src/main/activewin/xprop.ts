/**
 * Linux (X11) foreground window through `xprop`, with **fixed argv** (ARCHITECTURE §9.7): the
 * only value that comes from outside is the window id, and it is used only when it is a plain
 * hex number. Wayland has no way for an app to read another app's window, so the layer is off
 * there (the extension and the process watcher still block).
 *
 * The parsers are pure; `readX11Foreground` runs the two commands.
 */
import { readFileSync } from 'node:fs';
import type { ExecRunner } from '../system/exec';
import type { ForegroundWindow } from './match';

const XPROP = 'xprop';
const TIMEOUT_MS = 1_500;
const WINDOW_ID_RE = /^0x[0-9a-f]{1,8}$/i;

/** Whether this Linux session can use xprop (X11 with a display; not Wayland). */
export function x11Available(env: Readonly<Record<string, string | undefined>>): boolean {
  if ((env['XDG_SESSION_TYPE'] ?? '').toLowerCase() === 'wayland') return false;
  if (!env['DISPLAY']) return false;
  return true;
}

/** `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007` → `0x3a00007` (`null`: none). */
export function parseActiveWindowId(stdout: string): string | null {
  const m = /_NET_ACTIVE_WINDOW\(WINDOW\):\s*window id #\s*(0x[0-9a-f]+)/i.exec(stdout);
  const id = m?.[1]?.toLowerCase() ?? null;
  if (id === null || !WINDOW_ID_RE.test(id) || /^0x0+$/.test(id)) return null;
  return id;
}

/** Undoes xprop's string escapes (`\"`, `\\`, `\n`, octal `\303\251` for UTF-8 bytes). */
export function unescapeXpropString(body: string): string {
  const bytes: number[] = [];
  const pushText = (text: string): void => {
    for (const b of Buffer.from(text, 'utf8')) bytes.push(b);
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    if (ch !== '\\') {
      pushText(ch);
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (next === 'n') {
      bytes.push(0x0a);
      i += 1;
    } else if (next === 't') {
      bytes.push(0x09);
      i += 1;
    } else if (next !== '') {
      pushText(next);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function quotedValue(stdout: string, property: string): string | null {
  const re = new RegExp(`^${property}\\([A-Z0-9_]+\\) = "((?:[^"\\\\]|\\\\.)*)"`, 'm');
  const m = re.exec(stdout);
  return m?.[1] !== undefined ? unescapeXpropString(m[1]) : null;
}

/** Title (`_NET_WM_NAME`, else `WM_NAME`) and pid of `xprop -id <id> …` output. */
export function parseWindowProperties(stdout: string): {
  title: string | null;
  pid: number | null;
} {
  const title = quotedValue(stdout, '_NET_WM_NAME') ?? quotedValue(stdout, 'WM_NAME');
  const pidMatch = /^_NET_WM_PID\(CARDINAL\) = (\d{1,10})$/m.exec(stdout);
  const pid = pidMatch?.[1] ? Number(pidMatch[1]) : null;
  return { title, pid: pid !== null && pid > 0 && pid < 2 ** 31 ? pid : null };
}

function processName(pid: number | null): string | null {
  if (pid === null) return null;
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export type X11Read =
  | { kind: 'window'; window: ForegroundWindow }
  | { kind: 'none' }
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** The foreground window of the X11 session (two fixed xprop calls). */
export async function readX11Foreground(exec: ExecRunner): Promise<X11Read> {
  const env = { LC_ALL: 'C.UTF-8' };
  const root = await exec(XPROP, ['-root', '_NET_ACTIVE_WINDOW'], { timeoutMs: TIMEOUT_MS, env });
  if (root.error === 'ENOENT') return { kind: 'unsupported' };
  if (root.code !== 0) return { kind: 'error' };
  const id = parseActiveWindowId(root.stdout);
  if (id === null) return { kind: 'none' };
  const props = await exec(XPROP, ['-id', id, '_NET_WM_PID', '_NET_WM_NAME', 'WM_NAME'], {
    timeoutMs: TIMEOUT_MS,
    env,
  });
  // The window may close between the two calls.
  if (props.code !== 0) return { kind: 'none' };
  const { title, pid } = parseWindowProperties(props.stdout);
  if (title === null) return { kind: 'none' };
  return { kind: 'window', window: { title, process: processName(pid) } };
}
