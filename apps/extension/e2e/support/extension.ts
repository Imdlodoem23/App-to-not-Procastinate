/**
 * Fixtures for the extension e2e suite.
 *
 * - `guardian`: a fresh mock guardian per test on a random port of 127.0.0.1
 *   (test/mock-guardian.ts), closed afterwards.
 * - `extension`: a persistent Chromium context per test with the built extension from
 *   `dist/` (`--load-extension`), its background service worker and helpers to talk to it
 *   through the same typed messages the popup uses (background/state.ts). The extension id
 *   is the one pinned by the manifest `key` (`CHROMIUM_EXTENSION_ID`).
 *
 * The extension pairs with an explicit port (`{ type: 'centrate/pair', code, port }`, what
 * the app's «Puerto: N» is for), so no debug storage override of the guardian address is
 * needed; the UI pairing test uses the default port 47600 instead.
 *
 * Fake web: every http(s) request of a page that is not loopback is fulfilled with a tiny
 * page titled with its host, so no test touches the network. Blocked hosts never reach it:
 * declarativeNetRequest redirects them to blocked.html before any request is made.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
  type Route,
  type Worker,
} from '@playwright/test';
import { CHROMIUM_EXTENSION_ID } from '@centrate/shared/guardian-api';
import type { BlockedTabInfo } from '../../src/background/rules';
import { BLOCKED_TAB_KEY_PREFIX, blockedPagePath } from '../../src/background/rules';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ExtensionStateSnapshot,
  GuideSection,
} from '../../src/background/state';
import { MESSAGE_TYPES } from '../../src/background/state';
import type { MockBlock, MockBlockInput, MockGuardian } from '../../test/mock-guardian';
import { startMockGuardian } from '../../test/mock-guardian';

/** The unpacked extension (`CENTRATE_E2E_DIST` overrides it, e.g. for a packaged build). */
export const EXTENSION_DIR =
  process.env['CENTRATE_E2E_DIST'] || fileURLToPath(new URL('../../dist/', import.meta.url));
export const EXTENSION_ID = CHROMIUM_EXTENSION_ID;
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** Pages the suite needs in `dist/` (built by `npm run build -w apps/extension`). */
const REQUIRED_FILES = ['manifest.json', 'background.js', 'blocked.html', 'popup.html'];

const HEADLESS = process.env['CENTRATE_E2E_HEADLESS'] === '1';

/** Any http(s) URL that is not the guardian or another loopback server. */
const FAKE_WEB = /^https?:\/\/(?!(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$))/;

/** `chrome-extension://<id>/<path>`. */
export function extensionUrl(path: string): string {
  return `${EXTENSION_ORIGIN}/${path.replace(/^\/+/, '')}`;
}

/** The URL declarativeNetRequest (or the open-tab sweep, `enforced`) sends a tab to. */
export function blockedUrl(params: {
  cause: 'domain' | 'whitelist';
  serviceId?: string | null;
  enforced?: boolean;
}): string {
  return extensionUrl(
    blockedPagePath({
      cause: params.cause,
      serviceId: params.serviceId ?? null,
      enforced: params.enforced ?? false,
    }),
  );
}

/** The title of a fake page (the host it was served for). */
export function fakeTitle(url: string): string {
  return `Página de prueba · ${new URL(url).host}`;
}

async function fulfillFakePage(route: Route): Promise<void> {
  const url = route.request().url();
  if (route.request().resourceType() !== 'document') {
    await route.fulfill({ status: 204, body: '' });
    return;
  }
  const title = fakeTitle(url);
  await route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1></html>`,
  });
}

export interface ExtensionHarness {
  readonly context: BrowserContext;
  /** The background service worker. */
  readonly worker: Worker;
  /** Lines the service worker logged (attached to failed tests). */
  readonly workerLog: string[];
  /** Sends a typed request to the background from an extension page. */
  send<R extends BackgroundRequest>(request: R): Promise<BackgroundResponse<R['type']>>;
  /** The background's page-facing snapshot (`centrate/get-state`). */
  state(): Promise<ExtensionStateSnapshot>;
  /**
   * Pairs with `guardian` through the background (a fresh code, its port) and waits until
   * the first signed rules are applied.
   */
  pair(guardian: MockGuardian): Promise<ExtensionStateSnapshot>;
  /** What the background told blocked.html, per tab (`chrome.storage.session`). */
  blockedTabs(): Promise<BlockedTabInfo[]>;
  /** The popup, opened as a tab (the same page the toolbar button shows). */
  openPopup(): Promise<Page>;
  /** The guide (options page) at `#section`. */
  openGuide(section?: GuideSection): Promise<Page>;
  /** A new tab navigated to `url` (resolves once the navigation committed). */
  open(url: string): Promise<Page>;
}

/** Adds a block and waits until the extension has applied the new rules. */
export async function addBlockAndWait(
  guardian: MockGuardian,
  input: MockBlockInput,
): Promise<MockBlock> {
  const block = guardian.addBlock(input);
  await guardian.waitForApplied();
  return block;
}

async function launch(profileDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    executablePath: process.env['PW_CHROMIUM_PATH'] || undefined,
    headless: HEADLESS,
    locale: 'es-ES',
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
    ],
  });
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  const ours = (w: Worker): boolean => w.url().startsWith(`${EXTENSION_ORIGIN}/`);
  const existing = context.serviceWorkers().find(ours);
  if (existing !== undefined) return existing;
  return context.waitForEvent('serviceworker', { predicate: ours, timeout: 15_000 });
}

function createHarness(context: BrowserContext, worker: Worker, workerLog: string[]) {
  let control: Page | null = null;

  /** A blank extension page kept open to message the background from. */
  async function controlPage(): Promise<Page> {
    if (control !== null && !control.isClosed()) return control;
    control = await context.newPage();
    // blocked.html is web-accessible and needs no state; any extension page would do, but
    // popup.html may run its own startup requests. manifest.json is the quietest page.
    await control.goto(extensionUrl('manifest.json'));
    return control;
  }

  const harness: ExtensionHarness = {
    context,
    worker,
    workerLog,
    async send(request) {
      const page = await controlPage();
      return page.evaluate((message) => chrome.runtime.sendMessage(message), request);
    },
    async state() {
      const reply = await harness.send({ type: MESSAGE_TYPES.getState });
      if (!reply.ok) throw new Error(`get-state failed: ${reply.error}`);
      return reply.state;
    },
    async pair(guardian) {
      const code = guardian.newPairingCode();
      const reply = await harness.send({ type: MESSAGE_TYPES.pair, code, port: guardian.port });
      if (!reply.ok) throw new Error(`pairing failed: ${reply.error}`);
      await guardian.waitForApplied();
      return reply.state;
    },
    async blockedTabs() {
      const items = await worker.evaluate(() => chrome.storage.session.get(null));
      return Object.entries(items)
        .filter(([key]) => key.startsWith(BLOCKED_TAB_KEY_PREFIX))
        .map(([, value]) => value as BlockedTabInfo);
    },
    async openPopup() {
      const page = await context.newPage();
      await page.setViewportSize({ width: 440, height: 640 });
      await page.goto(extensionUrl('popup.html'));
      return page;
    },
    async openGuide(section) {
      const page = await context.newPage();
      await page.goto(
        extensionUrl(section === undefined ? 'options.html' : `options.html#${section}`),
      );
      return page;
    },
    async open(url) {
      const page = await context.newPage();
      await page.goto(url);
      return page;
    },
  };
  return harness;
}

interface Fixtures {
  guardian: MockGuardian;
  extension: ExtensionHarness;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  guardian: async ({}, use) => {
    const guardian = await startMockGuardian();
    await use(guardian);
    await guardian.close();
  },

  // eslint-disable-next-line no-empty-pattern
  extension: async ({}, use, testInfo) => {
    const missing = REQUIRED_FILES.filter((f) => !existsSync(join(EXTENSION_DIR, f)));
    if (missing.length > 0) {
      throw new Error(
        `dist/ lacks ${missing.join(', ')}: run \`npm run build -w apps/extension\` first`,
      );
    }
    const profileDir = mkdtempSync(join(tmpdir(), 'centrate-ext-e2e-'));
    const context = await launch(profileDir);
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.route(FAKE_WEB, fulfillFakePage);
      const worker = await extensionWorker(context);
      const workerLog: string[] = [];
      worker.on('console', (message) => workerLog.push(`[${message.type()}] ${message.text()}`));
      await use(createHarness(context, worker, workerLog));

      const failed = testInfo.status !== testInfo.expectedStatus;
      await context.tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined);
      if (failed && workerLog.length > 0) {
        await testInfo.attach('service-worker.log', {
          body: workerLog.join('\n'),
          contentType: 'text/plain',
        });
      }
    } finally {
      await context.close();
      rmSync(profileDir, { recursive: true, force: true });
    }
  },
});

export { expect };
