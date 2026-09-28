/**
 * Frame-by-frame recording (PROMPT.md §11: «Vídeos fotograma a fotograma, para que sean
 * deterministas y nítidos»). Nothing is recorded in real time: the spec drives the app one
 * step at a time (a key, a click, the harness clock moving one second) and the recorder takes
 * one screenshot per step and says how long it stays on screen. The result is a
 * `timeline.json` of runs («this PNG for 12 frames») over deduplicated PNGs, which
 * `encode.mjs` turns into a lossless master and the web encodings.
 *
 * CSS transitions and animations are played frame by frame too: the page's animation clock
 * is stopped when the recording starts, so whatever the flow sets moving (a hover, a card
 * appearing) waits at its first frame, and `animate` seeks it to each frame's time before its
 * screenshot. It moves identically on every run, whatever the machine's speed. The caret does
 * not blink either (lib/desktop.ts), so two runs give the same PNGs.
 */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Backdrop, Lang } from './config';
import { writeJson } from './config';

export interface FrameRun {
  /** PNG in the timeline's folder. */
  file: string;
  /** How many frames it stays on screen. */
  count: number;
  /** A named moment (`stillAt` in media.json picks the still image by it). */
  label: string | null;
}

export interface Timeline {
  id: string;
  lang: Lang;
  fps: number;
  theme: 'light' | 'dark';
  backdrop: Backdrop;
  /** Where a window smaller than the canvas sits (Windows grows the window upwards). */
  anchor: 'bottom' | 'center';
  /** Device pixels per CSS pixel of the screenshots. */
  scaleFactor: number;
  /** Family Chromium drew the UI with (checked against the brief's stack). */
  font: string | null;
  runs: FrameRun[];
  /** Pixel size of every PNG. */
  sizes: Record<string, { width: number; height: number }>;
}

export interface RecorderOptions {
  fps: number;
  /** Runs before every screenshot (e.g. wait until the window finished resizing). */
  beforeCapture?: () => Promise<void>;
}

export type CaretMode = 'hide' | 'initial';

/** PNG size from its IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Fails when the page shows an image from another origin (a service favicon, a remote
 * avatar): PROMPT.md §11 «Legal» wants neutral icons in marketing shots, and the app and the
 * blocked page draw catalog monograms and inline icons only.
 */
export async function assertNoRemoteImages(page: Page): Promise<void> {
  const remote = await page.evaluate(() => {
    const own = location.origin;
    const urls = [
      ...[...document.images].map((img) => img.currentSrc || img.src),
      ...[...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].map((l) => l.href),
    ];
    return urls.filter((url) => {
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return false;
      try {
        return new URL(url).origin !== own;
      } catch {
        return true;
      }
    });
  });
  if (remote.length > 0) {
    throw new Error(`Remote images in a marketing shot (use neutral icons): ${remote.join(', ')}`);
  }
}

export class FrameRecorder {
  private readonly runs: FrameRun[] = [];
  private readonly sizes: Timeline['sizes'] = {};
  private elapsedMs = 0;
  private frameCount = 0;

  private constructor(
    private readonly page: Page,
    private readonly dir: string,
    private readonly options: RecorderOptions,
  ) {}

  /**
   * A recorder for `page`, whose animation clock is stopped from now on (CDP
   * `Animation.setPlaybackRate(0)`): every transition or animation the flow starts (a hover,
   * a card appearing) waits at its first frame, however long the machine takes to get to the
   * next screenshot, and only `animate` moves it.
   */
  static async start(page: Page, dir: string, options: RecorderOptions): Promise<FrameRecorder> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    return new FrameRecorder(page, dir, options);
  }

  get durationMs(): number {
    return this.elapsedMs;
  }

  /** Takes a screenshot now and keeps it on screen for `ms` (at least one frame). */
  async hold(ms: number, label: string | null = null, caret: CaretMode = 'hide'): Promise<void> {
    await this.options.beforeCapture?.();
    const png = await this.page.screenshot({ scale: 'device', animations: 'disabled', caret });
    this.push(png, ms, label);
  }

  /**
   * Plays the page's running transitions and animations frame by frame (at most `maxMs`),
   * from where the stopped clock holds them, then finishes them. A no-op when nothing runs.
   */
  async animate(maxMs = 1_000, caret: CaretMode = 'hide'): Promise<void> {
    const spanMs = await this.page.evaluate((max) => {
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      const w = window as unknown as { __marketingAnims?: { a: Animation; start: number }[] };
      w.__marketingAnims = running.map((a) => ({ a, start: Number(a.currentTime ?? 0) }));
      let longest = 0;
      for (const { a, start } of w.__marketingAnims) {
        a.pause();
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end === 'number' && Number.isFinite(end)) {
          longest = Math.max(longest, end - start);
        }
      }
      return Math.min(longest, max);
    }, maxMs);
    const frameMs = 1_000 / this.options.fps;
    for (let t = frameMs; t < spanMs; t += frameMs) {
      await this.page.evaluate((at) => {
        const w = window as unknown as { __marketingAnims?: { a: Animation; start: number }[] };
        for (const { a, start } of w.__marketingAnims ?? []) a.currentTime = start + at;
      }, t);
      await this.options.beforeCapture?.();
      const png = await this.page.screenshot({ scale: 'device', animations: 'allow', caret });
      this.push(png, frameMs, null);
    }
    await this.page.evaluate(() => {
      const w = window as unknown as { __marketingAnims?: { a: Animation; start: number }[] };
      for (const { a } of w.__marketingAnims ?? []) {
        try {
          a.finish();
        } catch {
          a.play(); // infinite: let it run again
        }
      }
      delete w.__marketingAnims;
    });
  }

  /** Writes `timeline.json` into the folder and returns it. */
  finish(meta: Omit<Timeline, 'fps' | 'runs' | 'sizes'>): Timeline {
    if (this.runs.length === 0) throw new Error(`${meta.id}: no frames recorded`);
    const timeline: Timeline = {
      ...meta,
      fps: this.options.fps,
      runs: this.runs,
      sizes: this.sizes,
    };
    writeJson(join(this.dir, 'timeline.json'), timeline);
    return timeline;
  }

  private push(png: Buffer, ms: number, label: string | null): void {
    const file = `f-${createHash('sha1').update(png).digest('hex').slice(0, 16)}.png`;
    const path = join(this.dir, file);
    if (!existsSync(path)) writeFileSync(path, png);
    this.sizes[file] = pngSize(png);
    const end = Math.round(((this.elapsedMs + ms) * this.options.fps) / 1_000);
    const count = Math.max(1, end - this.frameCount);
    this.frameCount += count;
    this.elapsedMs += ms;
    const last = this.runs.at(-1);
    if (last && last.file === file && label === null) last.count += count;
    else this.runs.push({ file, count, label });
  }
}
