/**
 * 20 s of the real pipeline in Chromium with a fake camera (DESIGN.md §8.8): the loop keeps
 * ≥ 2 frames/s, every feature is a finite number, and nothing reaches a host other than this
 * loopback server. MediaPipe's usage logger tries `odml.pa.googleapis.com` when its tasks close;
 * the page's CSP must refuse it (and the route below would abort it anyway).
 */
import { expect, test } from '@playwright/test';

interface ProbeView {
  running: boolean;
  frames: number;
  nonFinite: number;
  reports: number;
  ticks: number;
  at: number;
  fps: number | null;
  level: number | null;
  duty: number | null;
  camera: string | null;
  cost: string;
  medianGapMs: number;
  blocked: string[];
  error: string | null;
}

declare global {
  interface Window {
    __studyAiDemo: {
      running: boolean;
      frames: number;
      nonFinite: number;
      reports: number;
      lastReport: {
        at: number;
        camera: string;
        totals: { ticks: number };
        loop: { fps: number; level: number; duty: number } | null;
      } | null;
      frameTimes: number[];
      lastCost: { faceMs: number; objectMs: number; lumaMs: number; totalMs: number } | null;
      blocked: string[];
      error: string | null;
      start(mode: 'camera' | 'no-camera'): Promise<void>;
      stop(): Promise<void>;
    };
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const isLocal = (url: URL): boolean =>
  LOOPBACK.has(url.hostname) || url.protocol === 'data:' || url.protocol === 'blob:';

test('real WASM + models: ≥ 2 fps, finite features, no network', async ({ page, context }) => {
  const outside: string[] = [];
  const answered: string[] = [];
  await context.route(
    (url) => !isLocal(url),
    async (route) => {
      outside.push(route.request().url());
      await route.abort('blockedbyclient');
    },
  );
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!isLocal(url)) answered.push(response.url());
  });

  await page.goto('/');
  await page.evaluate(() => window.__studyAiDemo.start('camera'));
  const started = await page.evaluate(() => window.__studyAiDemo.error);
  expect(started).toBeNull();
  await page.waitForFunction(() => window.__studyAiDemo.frames > 0, null, { timeout: 90_000 });

  const read = (): Promise<ProbeView> =>
    page.evaluate((): ProbeView => {
      const d = window.__studyAiDemo;
      const r = d.lastReport;
      return {
        running: d.running,
        frames: d.frames,
        nonFinite: d.nonFinite,
        reports: d.reports,
        ticks: r?.totals.ticks ?? 0,
        at: r?.at ?? 0,
        fps: r?.loop?.fps ?? null,
        level: r?.loop?.level ?? null,
        duty: r?.loop?.duty ?? null,
        camera: r?.camera ?? null,
        cost: d.lastCost
          ? `face ${d.lastCost.faceMs.toFixed(0)} ms, objects ${d.lastCost.objectMs.toFixed(0)} ms`
          : '—',
        medianGapMs: (() => {
          const t = d.frameTimes;
          const gaps = t.slice(1).map((v, i) => v - (t[i] as number));
          gaps.sort((a, b) => a - b);
          return gaps.length > 0 ? (gaps[Math.floor(gaps.length / 2)] as number) : Infinity;
        })(),
        blocked: d.blocked,
        error: d.error,
      };
    });

  const before = await read();
  await page.waitForTimeout(20_000);
  const after = await read();

  // Rates from the reports' own monotonic timestamps (the page clock, not the test's).
  const seconds = (after.at - before.at) / 1_000;
  const ticksPerSecond = (after.ticks - before.ticks) / seconds;
  test.info().annotations.push({
    type: 'loop',
    description: `${ticksPerSecond.toFixed(2)} ticks/s over ${seconds.toFixed(1)} s, level L${after.level}, duty ${after.duty}, fps ${after.fps}, median frame gap ${after.medianGapMs.toFixed(0)} ms, last frame ${after.cost}`,
  });
  expect(after.running).toBe(true);
  expect(after.camera).toBe('ok');
  expect(seconds).toBeGreaterThan(15);
  // The scheduler keeps ≥ 2 fps: the typical frame gap is ≤ 500 ms (+ timer slack)…
  expect(after.medianGapMs).toBeLessThanOrEqual(520);
  // …and the average holds even on a loaded CI runner (a throttled window would fall to 1/s).
  expect(ticksPerSecond).toBeGreaterThanOrEqual(1.6);
  expect(after.frames - before.frames).toBeGreaterThanOrEqual(1.6 * seconds);
  expect(after.reports - before.reports).toBeGreaterThanOrEqual(18);
  expect(after.nonFinite).toBe(0);

  // Closing the tasks flushes MediaPipe's usage logger: that POST must be refused.
  await page.evaluate(() => window.__studyAiDemo.stop());
  await page.waitForTimeout(2_000);
  const end = await read();
  test.info().annotations.push({
    type: 'blocked',
    description: [...end.blocked, ...outside].join(', ') || 'no attempt seen',
  });
  expect(answered).toEqual([]);
  for (const url of [...end.blocked, ...outside]) {
    expect(new URL(url).hostname).toBe('odml.pa.googleapis.com');
  }
});
