/**
 * Acceptance checks of the brief (§ 11) on the built site, served by `astro preview`:
 * - axe-core: 0 violations on every page at 375 and 1280 px, with and without reduced motion.
 * - Layout: no horizontal scroll at 320, 375 and 768 px.
 * - SEO: canonical and og:url match the sitemap, the Open Graph image is a 1200 × 630 PNG, and
 *   robots.txt and the sitemap point to the same origin.
 * - Weight (the budgets of § 11; Render's free plan has little egress): the first view of every
 *   page, loaded at 375 and 1440 px without scrolling, transfers ≤ 1.5 MB, and every image and
 *   video in dist/ fits its own budget: images ≤ 120 KB (AVIF, and WebP, the posters' format),
 *   the hero video ≤ 0.4 MB in AV1 and ≤ 1.2 MB in any other codec, every other video (the
 *   section loops) ≤ 0.5 MB. A video is the hero video when its file name contains «hero».
 *   MB and KB are decimal (10⁶ and 10³ bytes), the stricter reading. lighthouserc*.json assert
 *   the same first view budget (plus media ≤ 1.2 MB and images ≤ 360 KB) on every page.
 * - Screenshots (not compared, saved for review): every page full length, and the home page at
 *   several scroll positions, at 375, 768, 1280, 1440 and 1920 px, with and without reduced
 *   motion. Saved to test-results/screenshots (or WEB_SHOTS_DIR).
 *
 * - Release (the UI that only appears when GitHub answers: version, date, file sizes, the
 *   SHA-256 table, the newer-release notice): axe at 375 and 1280 px, full-page screenshots, and
 *   44 px targets for the file links of the SHA-256 table on a phone.
 *
 * The GitHub API is blocked in every other test, so the pages show their fallback version and
 * the screenshots do not change with each release. The release tests answer it with a fixed,
 * mocked release (MOCK_RELEASE).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Motion = 'reduce' | 'no-preference';

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'descargar', path: '/descargar' },
  { name: 'novedades', path: '/novedades' },
  { name: 'privacidad', path: '/privacidad' },
  { name: '404', path: '/esta-pagina-no-existe' },
] as const;
const MOTIONS: readonly Motion[] = ['reduce', 'no-preference'];
/** Width → a typical viewport height for it. */
const VIEWPORTS: Record<number, number> = { 375: 812, 768: 1024, 1280: 800, 1440: 900, 1920: 1080 };
const SHOT_WIDTHS = [375, 768, 1280, 1440, 1920];
const AXE_WIDTHS = [375, 1280];
const OVERFLOW_WIDTHS = [320, 375, 768];
/** Home page screenshots at these fractions of its scroll range. */
const SCROLL_STOPS = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
const SHOTS_DIR = resolve(process.env.WEB_SHOTS_DIR ?? 'test-results/screenshots');
const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
/** Budgets of § 11, in bytes (decimal MB and KB). */
const BUDGET = {
  firstView: 1_500_000,
  image: 120_000,
  heroAv1: 400_000,
  heroOther: 1_200_000,
  loop: 500_000,
} as const;
const WEIGHT_WIDTHS = [375, 1440];
const IMAGE_EXTENSIONS = new Set(['.avif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.webm', '.mp4']);

/** The release files, as the site links them, with plausible sizes in bytes. */
const RELEASE_FILES = [
  ['Centrate-Setup.exe', 88_304_640],
  ['Centrate.dmg', 121_176_064],
  ['Centrate.AppImage', 130_965_504],
  ['Centrate.deb', 84_017_152],
  ['Centrate-extension.zip', 320_512],
] as const;
const RELEASE_TAG = 'v1.2.0';
const RELEASE_BASE = 'https://github.com/Imdlodoem23/App-to-not-Procastinate/releases';
/** GET /repos/{owner}/{repo}/releases/latest, with the fields the site reads. */
const MOCK_RELEASE = {
  tag_name: RELEASE_TAG,
  name: `Céntrate ${RELEASE_TAG.slice(1)}`,
  draft: false,
  prerelease: false,
  html_url: `${RELEASE_BASE}/tag/${RELEASE_TAG}`,
  published_at: '2026-09-01T10:00:00Z',
  body: '',
  assets: RELEASE_FILES.map(([name, size]) => ({
    name,
    size,
    browser_download_url: `${RELEASE_BASE}/download/${RELEASE_TAG}/${name}`,
    digest: `sha256:${createHash('sha256').update(name).digest('hex')}`,
  })),
};

/** 'blocked': every GitHub API request fails. 'release': the latest release is MOCK_RELEASE. */
type Api = 'blocked' | 'release';

async function open(
  page: Page,
  path: string,
  width: number,
  motion: Motion,
  api: Api = 'blocked',
): Promise<void> {
  await page.route('https://api.github.com/**', (route) =>
    api === 'release' && new URL(route.request().url()).pathname.endsWith('/releases/latest')
      ? route.fulfill({ json: MOCK_RELEASE, headers: { 'access-control-allow-origin': '*' } })
      : route.abort(),
  );
  await page.emulateMedia({ reducedMotion: motion });
  await page.setViewportSize({ width, height: VIEWPORTS[width] ?? 900 });
  await page.goto(path, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** Scrolls to the end and back, so every reveal has run, like a visitor reading the page. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const step = Math.max(200, Math.round(window.innerHeight * 0.6));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await pause(60);
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    await pause(100);
  });
  await page
    .waitForFunction(
      () => document.querySelectorAll('[data-reveal]:not([data-revealed="done"])').length === 0,
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(150);
}

for (const { name, path } of PAGES) {
  for (const width of AXE_WIDTHS) {
    for (const motion of MOTIONS) {
      test(`axe: ${name} at ${width} px, motion ${motion}`, async ({ page }) => {
        await open(page, path, width, motion);
        await settle(page);
        const { violations } = await new AxeBuilder({ page }).analyze();
        const summary = violations.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        );
        expect(summary).toEqual([]);
      });
    }
  }

  for (const width of OVERFLOW_WIDTHS) {
    test(`layout: ${name} has no horizontal scroll at ${width} px`, async ({ page }) => {
      await open(page, path, width, 'reduce');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}

for (const { name, path } of PAGES) {
  for (const width of WEIGHT_WIDTHS) {
    test(`weight: ${name} first view at ${width} px is within budget`, async ({ page }) => {
      // Bytes on the wire per request, from the DevTools protocol: it also sees a video that is
      // still downloading (or that Chromium paused), which the Performance API only lists once
      // it has finished. Unfinished requests count their received bytes so far.
      const cdp = await page.context().newCDPSession(page);
      const received = new Map<string, number>();
      const finished = new Map<string, number>();
      const urls = new Map<string, string>();
      cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
      cdp.on('Network.dataReceived', (e) =>
        received.set(e.requestId, (received.get(e.requestId) ?? 0) + e.dataLength),
      );
      cdp.on('Network.loadingFinished', (e) => finished.set(e.requestId, e.encodedDataLength));
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

      await open(page, path, width, 'no-preference');
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

      const sizes = [...urls].map(([id, url]) => ({
        url,
        bytes: finished.get(id) ?? received.get(id) ?? 0,
      }));
      const total = sizes.reduce((sum, { bytes }) => sum + bytes, 0);
      const heaviest = sizes
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map(({ url, bytes }) => `${Math.round(bytes / 1000)} KB ${url}`);
      expect(total, `first view bytes; heaviest: ${heaviest.join(', ')}`).toBeLessThanOrEqual(
        BUDGET.firstView,
      );
    });
  }
}

test('weight: every image and video in dist fits its budget', async () => {
  const files = await readdir(DIST_DIR, { recursive: true, withFileTypes: true });
  const over: string[] = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    const ext = extname(file.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) continue;
    const bytes = await readFile(resolve(file.parentPath, file.name));
    let budget: number = BUDGET.image;
    if (VIDEO_EXTENSIONS.has(ext)) {
      // AV1: «V_AV1» is the codec ID in WebM; MP4 has the «av01» sample entry and its «av1C» box.
      const av1 = bytes.includes('V_AV1') || (bytes.includes('av01') && bytes.includes('av1C'));
      const hero = /hero/i.test(file.name);
      budget = !hero ? BUDGET.loop : av1 ? BUDGET.heroAv1 : BUDGET.heroOther;
    }
    if (bytes.length > budget) {
      const path = relative(DIST_DIR, resolve(file.parentPath, file.name));
      over.push(`${path}: ${Math.round(bytes.length / 1000)} KB > ${budget / 1000} KB`);
    }
  }
  expect(over).toEqual([]);
});

/**
 * Pages with release-dependent UI, and what shows once the mocked release is in (null: nothing
 * to wait for, since /novedades shows its notice only if the release is newer than its build).
 */
const RELEASE_PAGES = [
  { name: 'home', path: '/', ready: '[data-version-loaded]' },
  { name: 'descargar', path: '/descargar', ready: '[data-sums]:not([hidden])' },
  { name: 'novedades', path: '/novedades', ready: null },
] as const;

async function openWithRelease(
  page: Page,
  path: string,
  ready: string | null,
  width: number,
  motion: Motion,
): Promise<void> {
  await open(page, path, width, motion, 'release');
  await settle(page);
  if (ready) await expect(page.locator(ready).first()).toBeAttached();
  await page.waitForLoadState('networkidle');
}

for (const { name, path, ready } of RELEASE_PAGES) {
  for (const width of AXE_WIDTHS) {
    for (const motion of MOTIONS) {
      test(`release: axe on ${name} at ${width} px, motion ${motion}`, async ({ page }) => {
        await openWithRelease(page, path, ready, width, motion);
        const { violations } = await new AxeBuilder({ page }).analyze();
        const summary = violations.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        );
        expect(summary).toEqual([]);
      });
    }

    test(`release: screenshot of ${name}, full page, ${width}-reduced`, async ({ page }) => {
      await openWithRelease(page, path, ready, width, 'reduce');
      await mkdir(SHOTS_DIR, { recursive: true });
      await page.screenshot({
        path: `${SHOTS_DIR}/${name}-release-full-${width}-reduced.png`,
        fullPage: true,
      });
    });
  }
}

test('release: the file links of the SHA-256 table are 44 px targets on a phone', async ({
  page,
}) => {
  await openWithRelease(page, '/descargar', '[data-sums]:not([hidden])', 375, 'reduce');
  await expect(page.locator('[data-sums] tbody tr')).toHaveCount(RELEASE_FILES.length);
  await expect(page.locator('[data-sums] .sums-hash').first()).toHaveText(
    MOCK_RELEASE.assets[0]?.digest.replace('sha256:', '') ?? '',
  );

  // Hit area: the span of points at the link's horizontal centre that land on it. It must not
  // reach the size line under the name either.
  const targets = await page.locator('[data-sums] tbody th a').evaluateAll((links) =>
    links.map((link) => {
      link.scrollIntoView({ block: 'center', behavior: 'instant' });
      const box = link.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const hits: number[] = [];
      for (let y = box.top - 30; y <= box.bottom + 30; y += 0.5) {
        const el = document.elementFromPoint(x, y);
        if (el && link.contains(el)) hits.push(y);
      }
      const size = link.closest('tr')?.querySelector('td')?.getBoundingClientRect();
      const onSize = size && document.elementFromPoint(size.left + 8, size.top + size.height / 2);
      return {
        name: link.textContent,
        height: hits.length > 0 ? (hits.at(-1) ?? 0) - (hits[0] ?? 0) + 0.5 : 0,
        coversSize: Boolean(onSize && link.contains(onSize)),
      };
    }),
  );
  expect(targets).toHaveLength(RELEASE_FILES.length);
  for (const target of targets) {
    expect(target.height, `target height of ${target.name}`).toBeGreaterThanOrEqual(44);
    expect(target.coversSize, `${target.name} covers its size`).toBe(false);
  }
});

test('seo: canonical URLs, sitemap, robots.txt and the Open Graph image agree', async ({
  page,
  request,
}) => {
  const sitemap = await (await request.get('/sitemap-0.xml')).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const origin = new URL(locs[0] ?? 'invalid:').origin;

  const canonicals: string[] = [];
  for (const { path } of PAGES.filter((p) => p.name !== '404')) {
    await page.goto(path);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogUrl, `og:url of ${path}`).toBe(canonical);
    expect(new URL(ogImage ?? '').origin, `og:image of ${path}`).toBe(origin);
    expect(new URL(ogImage ?? '').pathname).toBe('/og.png');
    canonicals.push(canonical ?? '');
  }
  expect(canonicals.sort()).toEqual([...locs].sort());

  // 1200 × 630 PNG: width and height are the big-endian integers at bytes 16 and 20.
  const png = await (await request.get('/og.png')).body();
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain(`Sitemap: ${origin}/sitemap-index.xml`);

  await page.goto('/esta-pagina-no-existe');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});

for (const width of SHOT_WIDTHS) {
  for (const motion of MOTIONS) {
    const tag = `${width}-${motion === 'reduce' ? 'reduced' : 'motion'}`;

    for (const { name, path } of PAGES) {
      test(`screenshot: ${name}, full page, ${tag}`, async ({ page }) => {
        await open(page, path, width, motion);
        await settle(page);
        await mkdir(SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: `${SHOTS_DIR}/${name}-full-${tag}.png`, fullPage: true });
      });
    }

    test(`screenshot: home, scroll positions, ${tag}`, async ({ page }) => {
      await open(page, '/', width, motion);
      await mkdir(SHOTS_DIR, { recursive: true });
      const range = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      for (const [i, stop] of SCROLL_STOPS.entries()) {
        await page.evaluate(
          async (y) => {
            // Walk there in steps, so the reveals and the sticky scene see every position.
            const from = window.scrollY;
            for (let k = 1; k <= 10; k += 1) {
              window.scrollTo({ top: from + ((y - from) * k) / 10, behavior: 'instant' });
              await new Promise((done) => setTimeout(done, 40));
            }
          },
          Math.round(range * stop),
        );
        // Longer than the slowest reveal (0.9 s plus its stagger).
        await page.waitForTimeout(motion === 'reduce' ? 150 : 1400);
        await page.screenshot({ path: `${SHOTS_DIR}/home-scroll-${i}-${tag}.png` });
      }
    });
  }
}
