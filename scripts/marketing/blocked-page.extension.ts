/**
 * Section loop «página de bloqueo» (PROMPT.md §11, sticky scene and highlights): the real
 * blocked.html of the built extension, as a tab that tried YouTube sees it: «YouTube:
 * bloqueado», the time left, the reason, and «−10 puntos» once the guardian counts the
 * attempt. The web draws the generic browser around it.
 *
 * The page runs in Chromium from `apps/extension/dist` (served on a fake origin by
 * `context.route`) with a stubbed extension API: its tab's attempt info (what the background
 * writes to `chrome.storage.session`) goes from «reporting» to «counted», as it does live.
 * Time is Playwright's fake clock at the harness instant (17:00 in Madrid); the humor line
 * is fixed by `Math.random`. Chromium runs headed (build-media.mjs provides Xvfb on Linux) so
 * the page draws in the brief's typeface. Writes `frames/blocked-page/` to MARKETING_OUT.
 */
import { test, expect, chromium, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fontPlan, renderedFonts } from '../../apps/desktop/e2e/support/fonts';
import {
  HARNESS_NOW,
  fixtureInLocale,
  harnessFixture,
} from '../../apps/desktop/src/shared/fixtures';
import { primaryBlock } from '../../apps/desktop/src/shared/ui-state';
import { CONFIG, LANG, REPO_ROOT, freshDir, video, wanted } from './lib/config';
import { FrameRecorder, assertNoRemoteImages } from './lib/recorder';

const SPEC = video('blocked-page');
const DIST = join(REPO_ROOT, 'apps', 'extension', 'dist');
const ORIGIN = 'https://extension.centrate.invalid';
/** CSS pixels of the browser's content area the web frames. */
const VIEWPORT = { width: 800, height: 500 };
const TAB_ID = 7;
/**
 * The block of the desktop's «one-block» fixture (the extend-undo video): same reason, mode
 * and end, so the page says «quedan 43 min» for the window's 42:10.
 */
const BLOCK = primaryBlock(fixtureInLocale(harnessFixture('one-block'), LANG).snapshot.state);
const ANY_FONT = process.env['MARKETING_ANY_FONT'] === '1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

interface StubInput {
  tabId: number;
  lang: string;
  info: Record<string, unknown>;
}

/** Runs in the page before its scripts: the slice of `chrome.*` blocked.html uses. */
function installStub({ tabId, lang, info }: StubInput): void {
  type Listener = (...args: unknown[]) => void;
  const event = (list: Listener[]) => ({
    addListener: (f: Listener) => list.push(f),
    removeListener: (f: Listener) => {
      const i = list.indexOf(f);
      if (i >= 0) list.splice(i, 1);
    },
    hasListener: (f: Listener) => list.includes(f),
  });
  const storageListeners: Listener[] = [];
  const key = `centrate.blockedTab.${tabId}`;
  // Written «just now» for the page: its freshness check compares with its own load.
  let current: Record<string, unknown> = { ...info, at: performance.timeOrigin + 1 };
  Math.random = () => 0.5;
  const stub = {
    runtime: {
      id: 'centrate-marketing',
      sendMessage: async (message: { type?: string } | null) =>
        message?.type === 'centrate/blocked-info' ? current : { ok: false },
      onMessage: event([]),
      getURL: (path: string) => `${location.origin}/${path}`,
    },
    storage: {
      session: { get: async () => ({ [key]: current }), onChanged: event([]) },
      onChanged: event(storageListeners),
    },
    tabs: {
      getCurrent: async () => ({ id: tabId, index: 0, windowId: 1 }),
      create: async () => ({}),
      remove: async () => undefined,
    },
    i18n: { getUILanguage: () => lang, getMessage: () => '' },
  };
  // Chromium's own `window.chrome` cannot be replaced, but its members can be added.
  const w = window as unknown as { chrome?: object };
  if (typeof w.chrome !== 'object' || w.chrome === null) {
    Object.defineProperty(window, 'chrome', { value: {}, configurable: true, writable: true });
  }
  for (const [name, value] of Object.entries(stub)) {
    Object.defineProperty(w.chrome, name, { value, configurable: true, writable: true });
  }
  (window as unknown as Record<string, unknown>)['__marketingInfo'] = (
    patch: Record<string, unknown>,
  ) => {
    const oldValue = current;
    current = { ...current, ...patch };
    for (const f of [...storageListeners]) f({ [key]: { oldValue, newValue: current } }, 'session');
  };
}

async function setInfo(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const set = (window as unknown as Record<string, (p: unknown) => void>)['__marketingInfo'];
    set?.(p);
  }, patch);
}

test('blocked-page', async () => {
  test.skip(!wanted(SPEC.id), 'not in MARKETING_ONLY');
  if (!existsSync(join(DIST, 'blocked.html'))) {
    throw new Error('apps/extension/dist is missing: run `npm run build -w apps/extension`.');
  }
  const dir = freshDir('frames', SPEC.id);
  const fontDir = mkdtempSync(join(tmpdir(), 'centrate-marketing-font-'));
  const fonts = fontPlan(fontDir);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...fonts.env })) {
    if (v !== undefined) env[k] = v;
  }
  // Headed under Xvfb: headless Chromium resolves `system-ui` to its own default (DejaVu
  // Sans) and ignores the fontconfig file that puts the brief's typeface behind it.
  const browser = await chromium.launch({
    executablePath: process.env['PW_CHROMIUM_PATH'] || undefined,
    headless: !process.env['DISPLAY'],
    env,
  });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: CONFIG.scaleFactor,
      colorScheme: SPEC.theme,
      locale: LANG === 'en' ? 'en-US' : 'es-ES',
      timezoneId: 'Europe/Madrid',
      reducedMotion: 'no-preference',
    });
    await context.route(`${ORIGIN}/**`, (route) => {
      const path = normalize(decodeURIComponent(new URL(route.request().url()).pathname));
      const file = join(DIST, path);
      if (!file.startsWith(DIST) || !existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({
        status: 200,
        contentType: TYPES[extname(file)] ?? 'application/octet-stream',
        body: readFileSync(file),
      });
    });
    const page = await context.newPage();
    await page.clock.install({ time: HARNESS_NOW });
    await page.clock.pauseAt(HARNESS_NOW);
    if (!BLOCK) throw new Error('the one-block fixture has no block');
    await page.addInitScript(installStub, {
      tabId: TAB_ID,
      lang: LANG,
      info: {
        v: 1,
        tabId: TAB_ID,
        host: 'www.youtube.com',
        url: 'https://www.youtube.com/',
        serviceId: 'youtube',
        cause: 'domain',
        status: 'reporting',
        pointsDelta: null,
        episodePointsDelta: null,
        nextPenalty: 10,
        penaltiesEnabled: true,
        guardianReason: null,
        block: {
          id: BLOCK.id,
          kind: BLOCK.kind,
          mode: BLOCK.mode,
          endsAt: BLOCK.endsAt,
          reason: BLOCK.reason,
        },
      },
    } satisfies StubInput);
    await page.goto(`${ORIGIN}/blocked.html?service=youtube`);
    await expect(page.getByRole('timer')).toBeVisible();
    // The humor line waits for the first answers (at most 400 ms on the page's clock).
    await page.clock.runFor(500);
    await expect(page.locator('#blocked-humor')).not.toBeEmpty();
    await assertNoRemoteImages(page);

    const rendered = await renderedFonts(context, page);
    if (!rendered.ok && !ANY_FONT) {
      throw new Error(`blocked.html renders in ${rendered.family} (${fonts.source}).`);
    }

    const rec = await FrameRecorder.start(page, dir, { fps: CONFIG.fps });
    await rec.hold(700, 'reporting');
    await setInfo(page, { status: 'counted', pointsDelta: -10, episodePointsDelta: -10 });
    await expect(page.locator('#blocked-points-value')).toHaveText(/−10/);
    await rec.animate();
    await rec.hold(3_300, 'counted');

    rec.finish({
      id: SPEC.id,
      lang: LANG,
      theme: SPEC.theme,
      backdrop: SPEC.backdrop,
      anchor: 'center',
      scaleFactor: CONFIG.scaleFactor,
      font: rendered.family,
    });
    await context.close();
  } finally {
    await browser.close();
    rmSync(fontDir, { recursive: true, force: true });
  }
});
