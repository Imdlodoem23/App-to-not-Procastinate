/**
 * A small W3C WebDriver client for geckodriver, over `fetch` (no dependency): enough to
 * install the extension as a temporary add-on, drive tabs, run scripts in extension pages
 * and, in the chrome (privileged) context, reopen closed tabs and read the add-on's
 * background state.
 *
 * geckodriver: `GECKODRIVER_PATH`, else `$GECKOWEBDRIVER/geckodriver` (GitHub's Ubuntu
 * images), else `geckodriver` on the PATH. Firefox: `FIREFOX_BIN`, else the one geckodriver
 * finds (`firefox` on the PATH).
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';

/** An error answer (`{ value: { error, message } }`). */
export class WebDriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebDriverError';
  }
}

/** The key W3C WebDriver uses for element references. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export interface ElementRef {
  [ELEMENT_KEY]: string;
}

/** A file on the PATH (`name` or `name.exe`). */
function onPath(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const file of [name, `${name}.exe`]) {
      const full = join(dir, file);
      if (dir !== '' && existsSync(full)) return full;
    }
  }
  return null;
}

/** The geckodriver executable, or `null` when there is none. */
export function findGeckodriver(): string | null {
  const explicit = process.env['GECKODRIVER_PATH'];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const runnerDir = process.env['GECKOWEBDRIVER'];
  if (runnerDir) {
    for (const file of ['geckodriver', 'geckodriver.exe']) {
      if (existsSync(join(runnerDir, file))) return join(runnerDir, file);
    }
  }
  return onPath('geckodriver');
}

/** `FIREFOX_BIN`, or `firefox` on the PATH; `undefined` lets geckodriver look. */
export function findFirefox(): { binary: string | undefined; found: boolean } {
  const explicit = process.env['FIREFOX_BIN'];
  if (explicit) return { binary: explicit, found: existsSync(explicit) };
  const firefox = onPath('firefox');
  // geckodriver also knows the default install locations on Windows and macOS.
  return { binary: undefined, found: firefox !== null || process.platform !== 'linux' };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function request<T>(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  let json: { value?: unknown };
  try {
    json = JSON.parse(text) as { value?: unknown };
  } catch {
    throw new WebDriverError('unknown error', `${method} ${path}: HTTP ${res.status} ${text}`);
  }
  if (!res.ok) {
    const value = (json.value ?? {}) as { error?: string; message?: string };
    throw new WebDriverError(
      value.error ?? 'unknown error',
      `${method} ${path}: ${value.error ?? res.status}: ${value.message ?? text}`,
    );
  }
  return json.value as T;
}

export interface GeckoDriverOptions {
  executable: string;
  /** Receives geckodriver's and Firefox's output, line by line. */
  log?: (line: string) => void;
}

/** A geckodriver process on a free port of 127.0.0.1. */
export class GeckoDriver {
  private constructor(
    private readonly child: ChildProcess,
    readonly baseUrl: string,
  ) {}

  static async start(options: GeckoDriverOptions): Promise<GeckoDriver> {
    const port = await freePort();
    const child = spawn(options.executable, ['--host', '127.0.0.1', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = options.log ?? (() => undefined);
    let pending = '';
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') log(line);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let exited: string | null = null;
    child.once('exit', (code, signal) => {
      exited = `geckodriver exited (${signal ?? code})`;
    });
    child.once('error', (error) => {
      exited = `geckodriver did not start: ${error.message}`;
    });

    const driver = new GeckoDriver(child, `http://127.0.0.1:${port}`);
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (exited !== null) throw new Error(exited);
      try {
        const status = await request<{ ready?: boolean }>(driver.baseUrl, 'GET', '/status');
        if (status.ready !== false) return driver;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('geckodriver did not answer within 15 s');
      }
      await sleep(100);
    }
  }

  async newSession(capabilities: Record<string, unknown>): Promise<FirefoxSession> {
    const created = await request<{ sessionId: string; capabilities: Record<string, unknown> }>(
      this.baseUrl,
      'POST',
      '/session',
      { capabilities: { alwaysMatch: capabilities } },
    );
    return new FirefoxSession(this.baseUrl, created.sessionId, created.capabilities);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill();
    await Promise.race([exited, sleep(5_000)]);
  }
}

/** One WebDriver session: a Firefox with its own temporary profile. */
export class FirefoxSession {
  constructor(
    private readonly base: string,
    readonly id: string,
    readonly capabilities: Record<string, unknown>,
  ) {}

  get browserVersion(): string {
    return String(this.capabilities['browserVersion'] ?? '');
  }

  command<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    return request<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  /** Installs a zip/xpi (bytes) as a temporary add-on; returns its id. */
  installAddon(zip: Uint8Array): Promise<string> {
    return this.command<string>('POST', '/moz/addon/install', {
      addon: Buffer.from(zip).toString('base64'),
      temporary: true,
    });
  }

  setTimeouts(timeouts: { script?: number; pageLoad?: number; implicit?: number }) {
    return this.command('POST', '/timeouts', timeouts);
  }

  /** `chrome`: the browser's own (privileged) scripts; `content`: the current tab. */
  setContext(context: 'chrome' | 'content') {
    return this.command('POST', '/moz/context', { context });
  }

  /** Waits for the load like a user navigation (page load strategy `normal`). */
  navigate(url: string) {
    return this.command('POST', '/url', { url });
  }

  currentUrl(): Promise<string> {
    return this.command<string>('GET', '/url');
  }

  title(): Promise<string> {
    return this.command<string>('GET', '/title');
  }

  refresh() {
    return this.command('POST', '/refresh');
  }

  windowHandle(): Promise<string> {
    return this.command<string>('GET', '/window');
  }

  windowHandles(): Promise<string[]> {
    return this.command<string[]>('GET', '/window/handles');
  }

  async newTab(): Promise<string> {
    const created = await this.command<{ handle: string }>('POST', '/window/new', {
      type: 'tab',
    });
    return created.handle;
  }

  switchTo(handle: string) {
    return this.command('POST', '/window', { handle });
  }

  /** Closes the current tab; returns the handles left. */
  closeTab(): Promise<string[]> {
    return this.command<string[]>('DELETE', '/window');
  }

  /** Runs `script` (a function body; `arguments[i]`); a returned promise is awaited. */
  execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.command<T>('POST', '/execute/sync', { script, args });
  }

  async findByXPath(xpath: string): Promise<ElementRef> {
    return this.command<ElementRef>('POST', '/element', { using: 'xpath', value: xpath });
  }

  click(element: ElementRef) {
    return this.command('POST', `/element/${element[ELEMENT_KEY]}/click`);
  }

  type(element: ElementRef, text: string) {
    return this.command('POST', `/element/${element[ELEMENT_KEY]}/value`, { text });
  }

  async delete(): Promise<void> {
    await this.command('DELETE', '');
  }
}
