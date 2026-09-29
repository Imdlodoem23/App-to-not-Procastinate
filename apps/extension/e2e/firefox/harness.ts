/**
 * Fixtures for the Firefox smoke suite (playwright.firefox.config.ts). Playwright is only
 * the test runner here: its Firefox build cannot load extensions, so each test starts a
 * real Firefox through geckodriver (webdriver.ts) with a fresh profile, installs the
 * extension as a temporary add-on and drives it against the mock guardian.
 *
 * - The add-on is `dist/` zipped with the Firefox manifest (manifest.mjs, as
 *   Centrate-extension-firefox.zip and the signed .xpi get it), or the zip/xpi in
 *   `CENTRATE_E2E_FIREFOX_ADDON`.
 * - Its moz-extension UUID is pinned (`extensions.webextensions.uuids`), so the suite
 *   knows the extension origin the guardian binds the pairing to.
 * - Fake web: Firefox uses fake-web.ts as its http and https proxy (loopback excepted);
 *   HTTPS-First, HTTPS-Only and the HSTS preload list are off so `http://www.youtube.com/`
 *   stays http.
 * - Headless unless `CENTRATE_E2E_HEADED=1`. Without geckodriver or Firefox the tests are
 *   skipped locally and fail on CI.
 * - The chrome (privileged) context reopens closed tabs (SessionStore) and reads the event
 *   page's state; Firefox 138+ needs `-remote-allow-system-access` for it, which geckodriver
 *   0.36+ passes itself (`--allow-system-access`) and refuses in the capabilities.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { zipSync } from 'fflate';
import type { BlockedTabInfo } from '../../src/background/rules';
import { BLOCKED_TAB_KEY_PREFIX, blockedPagePath } from '../../src/background/rules';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ExtensionStateSnapshot,
} from '../../src/background/state';
import { MESSAGE_TYPES } from '../../src/background/state';
import type { MockGuardian } from '../../test/mock-guardian';
import { startMockGuardian } from '../../test/mock-guardian';
import { EXTENSION_DIR } from '../support/extension';
import type { FakeWeb } from './fake-web';
import { startFakeWeb } from './fake-web';
import type { FirefoxSession } from './webdriver';
import {
  GeckoDriver,
  WebDriverError,
  findFirefox,
  findGeckodriver,
  geckodriverAllowsSystemAccess,
} from './webdriver';

/** The moz-extension UUID the suite pins (lowercase, as Firefox generates them). */
export const FIREFOX_UUID = '6a1f3b0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b';
export const FIREFOX_ORIGIN = `moz-extension://${FIREFOX_UUID}`;

const APP_DIR = new URL('../../', import.meta.url);
const HEADED = process.env['CENTRATE_E2E_HEADED'] === '1';
const CI = Boolean(process.env['CI']);

export function firefoxExtensionUrl(path: string): string {
  return `${FIREFOX_ORIGIN}/${path.replace(/^\/+/, '')}`;
}

/** Where DNR (or the extension, `enforced`) sends a blocked tab. */
export function firefoxBlockedUrl(params: {
  cause: 'domain' | 'whitelist';
  serviceId?: string | null;
  enforced?: boolean;
}): string {
  return firefoxExtensionUrl(
    blockedPagePath({
      cause: params.cause,
      serviceId: params.serviceId ?? null,
      enforced: params.enforced ?? false,
    }),
  );
}

type Manifest = Record<string, unknown> & {
  browser_specific_settings?: { gecko?: { id?: string } };
};

/** dist/ as Firefox gets it: the files of the build with the Firefox manifest. */
async function addonBytes(): Promise<{ zip: Uint8Array; geckoId: string }> {
  const explicit = process.env['CENTRATE_E2E_FIREFOX_ADDON'];
  const manifest = JSON.parse(
    readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'),
  ) as Manifest;
  const geckoId = manifest.browser_specific_settings?.gecko?.id;
  if (geckoId === undefined)
    throw new Error('manifest.json lacks browser_specific_settings.gecko.id');
  if (explicit) return { zip: new Uint8Array(readFileSync(explicit)), geckoId };

  // manifest.mjs is plain JS (no types): imported by URL, typed here.
  const { manifestFor } = (await import(new URL('manifest.mjs', APP_DIR).href)) as {
    manifestFor(manifest: Record<string, unknown>, engine: 'firefox'): Record<string, unknown>;
  };
  const files: Record<string, Uint8Array> = {};
  const collect = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full);
      else files[relative(EXTENSION_DIR, full).split('\\').join('/')] = readFileSync(full);
    }
  };
  collect(EXTENSION_DIR);
  files['manifest.json'] = new TextEncoder().encode(
    `${JSON.stringify(manifestFor(manifest, 'firefox'), null, 2)}\n`,
  );
  return { zip: zipSync(files), geckoId };
}

function firefoxPrefs(
  web: FakeWeb,
  geckoId: string,
  idleTimeoutMs: number,
): Record<string, unknown> {
  return {
    'extensions.webextensions.uuids': JSON.stringify({ [geckoId]: FIREFOX_UUID }),
    // Every http(s) request goes to the fake web; the guardian (loopback) is reached directly.
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': web.port,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': web.port,
    'network.proxy.share_proxy_settings': false,
    'network.proxy.no_proxies_on': 'localhost, 127.0.0.1, [::1]',
    'network.proxy.allow_hijacking_localhost': false,
    // Keep http://www.youtube.com/ on http (the fake web has no TLS).
    'network.stricttransportsecurity.preloadlist': false,
    'dom.security.https_first': false,
    'dom.security.https_first_pbm': false,
    'dom.security.https_first_schemeless': false,
    'dom.security.https_only_mode': false,
    'intl.locale.requested': 'es-ES',
    'intl.accept_languages': 'es-ES, es',
    'browser.tabs.warnOnClose': false,
    ...(idleTimeoutMs > 0 ? { 'extensions.background.idle.timeout': idleTimeoutMs } : {}),
  };
}

export interface FirefoxTab {
  readonly handle: string;
  url(): Promise<string>;
  title(): Promise<string>;
  /** `document.body.innerText` (empty while there is no body). */
  text(): Promise<string>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  /** Clicks the element `xpath` selects. */
  click(xpath: string): Promise<void>;
  /** Types into the element `xpath` selects. */
  type(xpath: string, text: string): Promise<void>;
}

export interface FirefoxHarness {
  readonly session: FirefoxSession;
  /** `browserVersion` of the session (e.g. «128.0»). */
  readonly version: string;
  /** geckodriver and Firefox output (attached to failed tests). */
  readonly log: string[];
  send<R extends BackgroundRequest>(request: R): Promise<BackgroundResponse<R['type']>>;
  state(): Promise<ExtensionStateSnapshot>;
  /** Pairs with `guardian` (a fresh code, its port) and waits for the first rules. */
  pair(guardian: MockGuardian): Promise<ExtensionStateSnapshot>;
  /** What the background told blocked.html, per tab (`storage.session`). */
  blockedTabs(): Promise<BlockedTabInfo[]>;
  /** A new tab navigated to `url` (resolves once it loaded). */
  open(url: string): Promise<FirefoxTab>;
  /** The popup page in a tab (the toolbar button shows the same page). */
  openPopup(): Promise<FirefoxTab>;
  /** «Reopen closed tab» (SessionStore): the tab it restores. */
  reopenClosedTab(): Promise<FirefoxTab>;
  /** The event page: `running`, `suspending`, `stopped`… (Firefox's own state names). */
  backgroundState(): Promise<string>;
  /** Runs `script` (a function body, `browser.*` available) in an extension page. */
  inExtensionPage<T>(script: string, ...args: unknown[]): Promise<T>;
  /** Clicks «Allow» on the add-on permission prompt (`permissions.request`) once it shows. */
  acceptPermissionPrompt(): Promise<void>;
}

function createHarness(session: FirefoxSession, control: string, geckoId: string, log: string[]) {
  let current = control;

  async function focus(handle: string): Promise<void> {
    if (current === handle) return;
    await session.switchTo(handle);
    current = handle;
  }

  async function inControl<T>(script: string, ...args: unknown[]): Promise<T> {
    await focus(control);
    return session.execute<T>(script, ...args);
  }

  async function inChrome<T>(script: string, ...args: unknown[]): Promise<T> {
    await session.setContext('chrome');
    try {
      return await session.execute<T>(script, ...args);
    } finally {
      await session.setContext('content');
    }
  }

  function tab(handle: string): FirefoxTab {
    return {
      handle,
      url: async () => {
        await focus(handle);
        return session.currentUrl();
      },
      title: async () => {
        await focus(handle);
        return session.title();
      },
      text: async () => {
        await focus(handle);
        return session.execute<string>('return document.body ? document.body.innerText : "";');
      },
      goto: async (url) => {
        await focus(handle);
        await session.navigate(url);
      },
      reload: async () => {
        await focus(handle);
        await session.refresh();
      },
      close: async () => {
        await focus(handle);
        await session.closeTab();
        await session.switchTo(control);
        current = control;
      },
      click: async (xpath) => {
        await focus(handle);
        await session.click(await session.findByXPath(xpath));
      },
      type: async (xpath, text) => {
        await focus(handle);
        await session.type(await session.findByXPath(xpath), text);
      },
    };
  }

  async function newTab(url: string): Promise<FirefoxTab> {
    const handle = await session.newTab();
    await focus(handle);
    await session.navigate(url);
    return tab(handle);
  }

  const harness: FirefoxHarness = {
    session,
    version: session.browserVersion,
    log,
    send(request) {
      return inControl('return browser.runtime.sendMessage(arguments[0]);', request);
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
      const items = await inControl<Record<string, unknown>>(
        'return browser.storage.session.get(null);',
      );
      return Object.entries(items)
        .filter(([key]) => key.startsWith(BLOCKED_TAB_KEY_PREFIX))
        .map(([, value]) => value as BlockedTabInfo);
    },
    open: newTab,
    openPopup: () => newTab(firefoxExtensionUrl('popup.html')),
    async reopenClosedTab() {
      const before = new Set(await session.windowHandles());
      // SessionStore records a closed tab asynchronously: retry until one is restored.
      await expect
        .poll(
          () =>
            inChrome<boolean>(
              // The browser window's own SessionStore (a lazy module getter of browser.js):
              // recent Firefox refuses to load browser modules from the WebDriver sandbox.
              `const store = window.SessionStore ?? ChromeUtils.importESModule(
                 'resource:///modules/sessionstore/SessionStore.sys.mjs').SessionStore;
               return Boolean(store.undoCloseTab(window, 0));`,
            ),
          { message: 'SessionStore restored no tab' },
        )
        .toBe(true);
      let restored: string | undefined;
      await expect
        .poll(async () => {
          restored = (await session.windowHandles()).find((h) => !before.has(h));
          return restored !== undefined;
        })
        .toBe(true);
      current = '';
      return tab(restored as string);
    },
    inExtensionPage: inControl,
    async acceptPermissionPrompt() {
      await expect
        .poll(
          () =>
            inChrome<boolean>(
              `const prompt = document.getElementById('addon-webext-permissions-notification');
               if (!prompt || !prompt.button || PopupNotifications.panel.state !== 'open') {
                 return false;
               }
               prompt.button.click();
               return true;`,
            ),
          { message: 'no add-on permission prompt' },
        )
        .toBe(true);
    },
    backgroundState() {
      return inChrome<string>(
        `const policy = WebExtensionPolicy.getByID(arguments[0]);
         return String(policy && policy.extension ? policy.extension.backgroundState : 'none');`,
        geckoId,
      );
    },
  };
  return harness;
}

interface Fixtures {
  guardian: MockGuardian;
  firefox: FirefoxHarness;
}

interface Options {
  /** `extensions.background.idle.timeout` (ms); 0 keeps Firefox's (30 s). */
  idleTimeoutMs: number;
}

export const test = base.extend<Fixtures & Options>({
  idleTimeoutMs: [0, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  guardian: async ({}, use) => {
    const guardian = await startMockGuardian();
    await use(guardian);
    await guardian.close();
  },

  firefox: async ({ idleTimeoutMs }, use, testInfo) => {
    const geckodriver = findGeckodriver();
    const firefox = findFirefox();
    if (geckodriver === null || !firefox.found) {
      const missing = geckodriver === null ? 'geckodriver' : 'Firefox';
      if (CI) throw new Error(`${missing} not found (GECKODRIVER_PATH / FIREFOX_BIN)`);
      testInfo.skip(true, `${missing} not found: set GECKODRIVER_PATH and FIREFOX_BIN`);
      return;
    }
    const { zip, geckoId } = await addonBytes();
    const log: string[] = [];
    const web = await startFakeWeb();
    let driver: GeckoDriver | null = null;
    let session: FirefoxSession | null = null;
    try {
      // Firefox 138+ opens the chrome context only with -remote-allow-system-access: from
      // geckodriver itself when it knows the flag, else as a Firefox argument.
      const allowSystemAccess = geckodriverAllowsSystemAccess(geckodriver);
      driver = await GeckoDriver.start({
        executable: geckodriver,
        allowSystemAccess,
        log: (l) => log.push(l),
      });
      session = await driver.newSession({
        browserName: 'firefox',
        pageLoadStrategy: 'normal',
        'moz:firefoxOptions': {
          ...(firefox.binary !== undefined ? { binary: firefox.binary } : {}),
          args: [
            ...(HEADED ? [] : ['-headless']),
            ...(allowSystemAccess ? [] : ['-remote-allow-system-access']),
          ],
          prefs: firefoxPrefs(web, geckoId, idleTimeoutMs),
        },
      });
      await session.setTimeouts({ script: 30_000, pageLoad: 30_000, implicit: 5_000 });
      testInfo.annotations.push({ type: 'firefox', description: session.browserVersion });
      try {
        await session.installAddon(zip);
      } catch (error) {
        // Firefox says why an add-on was refused only in its own output.
        const tail = log.filter((l) => /addon|extension|manifest|error/i.test(l)).slice(-20);
        if (error instanceof Error) error.message += `\n${tail.join('\n')}`;
        throw error;
      }

      // The control tab: an extension page to message the background from.
      const control = await session.windowHandle();
      await session.navigate(firefoxExtensionUrl('options.html'));
      const harness = createHarness(session, control, geckoId, log);
      // The event page may still be starting: wait until it answers.
      await expect
        .poll(
          async () => {
            try {
              return (await harness.state()).v;
            } catch (error) {
              if (error instanceof WebDriverError) return error.message;
              throw error;
            }
          },
          { message: 'the background did not answer', timeout: 15_000 },
        )
        .toBe(1);

      await use(harness);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && log.length > 0) {
        await testInfo.attach('firefox.log', { body: log.join('\n'), contentType: 'text/plain' });
      }
      await session?.delete().catch(() => undefined);
      await driver?.stop();
      await web.close();
    }
  },
});

export { expect };
