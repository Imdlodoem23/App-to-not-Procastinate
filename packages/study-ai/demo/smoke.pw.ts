/**
 * 20 s of the real pipeline in Chromium with a fake camera (DESIGN.md §8.8): the loop keeps
 * ≥ 2 frames/s with its timers on time (never `throttled`), every feature is a finite number,
 * and nothing reaches a host other than this loopback server. On a machine too slow for 2 fps
 * within the 15 % duty cap (software WebGL; the fake camera shows no face, so the detector
 * runs at 1 Hz) the cap sets the pace instead: the report says `overBudget`, and ≥ 1 frame/s
 * with timers on time is required. MediaPipe's usage logger tries `odml.pa.googleapis.com` when its tasks close;
 * the page's CSP must refuse it (and the route below would abort it anyway).
 *
 * Then a GPU reset: `WEBGL_lose_context` on MediaPipe's WebGL contexts in the middle of a
 * session. MediaPipe itself keeps «processing» empty pixels; the pipeline must notice, the
 * session must rebuild it and go on analysing frames, still in camera mode.
 *
 * Last, the analysis window itself (demo/analysis.html): the host driven through IPC-shaped
 * messages under the exact CSP of HANDOFF §1.1 (`default-src 'none'`, no `worker-src`, no
 * `img-src`, `connect-src` = the asset server only).
 */
import type { AnalysisOutbound, ContextInput } from '../src/types';
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
  overBudget: boolean;
  throttled: boolean;
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
        loop: {
          fps: number;
          level: number;
          duty: number;
          overBudget: boolean;
          throttled: boolean;
        } | null;
      } | null;
      frameTimes: number[];
      lastCost: { faceMs: number; objectMs: number; lumaMs: number; totalMs: number } | null;
      events: string[];
      visionBuilds: number;
      blocked: string[];
      error: string | null;
      start(mode: 'camera' | 'no-camera'): Promise<void>;
      stop(): Promise<void>;
    };
    /** Every WebGL context the page created (recorded by an init script). */
    __glContexts: (WebGLRenderingContext | WebGL2RenderingContext)[];
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
        overBudget: r?.loop?.overBudget ?? false,
        throttled: r?.loop?.throttled ?? false,
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
    description: `${ticksPerSecond.toFixed(2)} ticks/s over ${seconds.toFixed(1)} s, level L${after.level}, duty ${after.duty}, fps ${after.fps}, over budget ${after.overBudget}, median frame gap ${after.medianGapMs.toFixed(0)} ms, last frame ${after.cost}`,
  });
  expect(after.running).toBe(true);
  expect(after.camera).toBe('ok');
  expect(seconds).toBeGreaterThan(15);
  // The timers fire on time: a throttled window (1 s wake-ups) would say so.
  expect(after.throttled).toBe(false);
  if (after.overBudget) {
    // Too slow for 2 fps within the 15 % duty cap: the cap sets the pace, never a busy loop.
    expect(ticksPerSecond).toBeGreaterThanOrEqual(1);
    expect(after.frames - before.frames).toBeGreaterThanOrEqual(1 * seconds);
  } else {
    // The scheduler keeps ≥ 2 fps: the typical frame gap is ≤ 500 ms (+ timer slack)…
    expect(after.medianGapMs).toBeLessThanOrEqual(520);
    // …and the average holds even on a loaded CI runner (a throttled window falls to 1/s).
    expect(ticksPerSecond).toBeGreaterThanOrEqual(1.6);
    expect(after.frames - before.frames).toBeGreaterThanOrEqual(1.6 * seconds);
  }
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

test('a lost WebGL context is rebuilt, never read as «nobody there»', async ({ page, context }) => {
  await context.route(
    (url) => !isLocal(url),
    (route) => route.abort('blockedbyclient'),
  );
  // Record the WebGL contexts MediaPipe creates on its task canvases.
  await page.addInitScript(() => {
    const contexts: (WebGLRenderingContext | WebGL2RenderingContext)[] = [];
    window.__glContexts = contexts;
    for (const proto of [OffscreenCanvas.prototype, HTMLCanvasElement.prototype]) {
      const original = proto.getContext as (this: unknown, ...args: unknown[]) => unknown;
      Object.defineProperty(proto, 'getContext', {
        configurable: true,
        writable: true,
        value(this: unknown, ...args: unknown[]): unknown {
          const ctx = original.apply(this, args);
          const type = args[0];
          if (ctx && (type === 'webgl2' || type === 'webgl')) {
            const gl = ctx as WebGL2RenderingContext;
            if (!contexts.includes(gl)) contexts.push(gl);
          }
          return ctx;
        },
      });
    }
  });

  await page.goto('/');
  await page.evaluate(() => window.__studyAiDemo.start('camera'));
  expect(await page.evaluate(() => window.__studyAiDemo.error)).toBeNull();
  await page.waitForFunction(() => window.__studyAiDemo.frames > 10, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__studyAiDemo.visionBuilds)).toBe(1);

  // The GPU process resets: every context MediaPipe runs through is lost.
  const lost = await page.evaluate(() => {
    let n = 0;
    for (const gl of window.__glContexts) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext && !gl.isContextLost()) {
        ext.loseContext();
        n += 1;
      }
    }
    return n;
  });
  expect(lost).toBeGreaterThanOrEqual(2); // one per task
  const framesAtLoss = await page.evaluate(() => window.__studyAiDemo.frames);

  // Rebuilt in a few seconds (well under the 10 s after which frames count as absent)…
  const t0 = Date.now();
  await page.waitForFunction(() => window.__studyAiDemo.visionBuilds >= 2, null, {
    timeout: 30_000,
  });
  test.info().annotations.push({ type: 'rebuild', description: `${Date.now() - t0} ms` });
  // …and analysing frames again on fresh contexts.
  await page.waitForFunction((n) => window.__studyAiDemo.frames > n + 10, framesAtLoss, {
    timeout: 30_000,
  });
  const after = await page.evaluate(() => {
    const d = window.__studyAiDemo;
    return {
      mode: d.lastReport ? (d.lastReport as unknown as { mode: string }).mode : null,
      modeEvents: d.events.filter((e) => e === 'mode').length,
      errors:
        (d.lastReport as unknown as { loop: { errors: number } | null } | null)?.loop?.errors ??
        null,
      live: window.__glContexts.filter((gl) => !gl.isContextLost()).length,
      nonFinite: d.nonFinite,
    };
  });
  expect(after.mode).toBe('camera');
  expect(after.modeEvents).toBe(0); // never fell back to no-camera
  expect(after.errors).toBe(0); // a context loss is handled, not a failing frame
  expect(after.live).toBeGreaterThanOrEqual(2);
  expect(after.nonFinite).toBe(0);
  await page.evaluate(() => window.__studyAiDemo.stop());
});

test('the analysis window under the HANDOFF CSP: camera mode ≥ 2 fps, logger refused', async ({
  page,
  context,
}) => {
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
    if (!isLocal(new URL(response.url()))) answered.push(response.url());
  });

  await page.goto('/analysis.html');
  await page.waitForFunction(() => '__analysis' in window);
  const work: ContextInput = { phase: 'work', foreground: 'study', idleMs: 1_000 };
  await page.evaluate((ctx) => {
    const probe = (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis;
    probe.send({
      type: 'session_start',
      mode: 'camera',
      settings: {},
      profileJson: null,
      cameraLabel: null,
      context: ctx,
    });
    probe.keepContext(ctx);
  }, work);

  const reportsOf = (messages: AnalysisOutbound[]) =>
    messages.flatMap((m) => (m.type === 'report' ? [m.report] : []));
  const read = () =>
    page.evaluate(() => {
      const probe = (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis;
      return { messages: [...probe.messages], invalid: probe.invalid, blocked: [...probe.blocked] };
    });

  await page.waitForFunction(
    () => {
      const probe = (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis;
      return probe.messages.some(
        (m) => m.type === 'report' && m.report.loop !== null && m.report.loop.ticks > 5,
      );
    },
    null,
    { timeout: 90_000 },
  );
  const before = reportsOf((await read()).messages).at(-1);
  await page.waitForTimeout(20_000);
  const during = await read();
  const after = reportsOf(during.messages).at(-1);
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  if (!before || !after || !after.loop || !before.loop) return;

  const seconds = (after.at - before.at) / 1_000;
  const ticksPerSecond = (after.loop.ticks - before.loop.ticks) / seconds;
  test.info().annotations.push({
    type: 'analysis window',
    description: `${ticksPerSecond.toFixed(2)} ticks/s over ${seconds.toFixed(1)} s, L${after.loop.level}, duty ${after.loop.duty}, fps ${after.loop.fps}, over budget ${after.loop.overBudget}`,
  });
  // The real pipeline runs under the strict CSP: no fallback, no error, no violation.
  expect(during.messages.filter((m) => m.type === 'error')).toEqual([]);
  expect(during.messages.filter((m) => m.type === 'event' && m.event.type === 'mode')).toEqual([]);
  expect(during.invalid).toBe(0);
  expect(during.blocked).toEqual([]);
  expect(after.mode).toBe('camera');
  expect(after.camera).toBe('ok');
  expect(after.cameraOn).toBe(true);
  expect(after.loop.errors).toBe(0);
  expect(after.loop.throttled).toBe(false);
  // ≥ 2 fps, or the pace of the 15 % duty cap on a machine too slow for it (see the header).
  expect(ticksPerSecond).toBeGreaterThanOrEqual(after.loop.overBudget ? 1 : 1.6);

  // Stop: the last report, then the summary; MediaPipe's logger POST is refused by the CSP.
  await page.evaluate(() => {
    const probe = (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis;
    probe.keepContext(null);
    probe.send({ type: 'session_stop' });
  });
  await page.waitForFunction(
    () => {
      const probe = (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis;
      return probe.messages.some((m) => m.type === 'session_stopped');
    },
    null,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(2_000);
  const end = await read();
  test.info().annotations.push({
    type: 'blocked',
    description: [...end.blocked, ...outside].join(', ') || 'no attempt seen',
  });
  expect(answered).toEqual([]);
  for (const entry of end.blocked) {
    expect(entry).toMatch(/^connect-src https:\/\/odml\.pa\.googleapis\.com\//);
  }
  for (const url of outside) expect(new URL(url).hostname).toBe('odml.pa.googleapis.com');
  await page.evaluate(() =>
    (window as unknown as { __analysis: AnalysisWindowProbe }).__analysis.dispose(),
  );
});

interface AnalysisWindowProbe {
  messages: AnalysisOutbound[];
  invalid: number;
  blocked: string[];
  send(message: unknown): void;
  keepContext(context: ContextInput | null): void;
  dispose(): Promise<void>;
}
