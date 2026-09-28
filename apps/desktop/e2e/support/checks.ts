/**
 * In-page checks shared by the specs and the capture: layout settling, the no-scroll and
 * no-clipped-text probe (PROMPT §10 «Criterios de aceptación»), and axe-core.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';
import type { Result as AxeResult, run as axeRun } from 'axe-core';
import {
  initialMainLocal,
  type MainLocalState,
  type WindowAnchor,
  type WindowKind,
} from '../../src/shared/ui-state';
import type { HarnessFixture } from '../../src/shared/fixtures';
import type { LaunchedApp } from './app';

/** PROMPT §10 «Alto automático»: content budget on 1920×1080 at 100 %. */
export const HEIGHT_AT_REST = 540;
export const HEIGHT_ANY_STATE = 600;
/** The preset those budgets are measured on. */
export const BUDGET_PRESET = '1920x1080@100';

/** The anchored corner the geometry picks on this OS for the fake display (taskbar below). */
export const EXPECTED_ANCHOR: WindowAnchor = process.platform === 'darwin' ? 'top' : 'bottom';

function sameMainLocal(a: MainLocalState, b: MainLocalState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * «En reposo»: the main window shows nothing transient — no text typed, no card, no
 * «Bloqueando…», no undo line and no protection warning. The ≤ 540 budget applies to these;
 * every other state gets ≤ 600.
 */
export function isRestState(fixture: HarnessFixture): boolean {
  const { ops } = fixture.snapshot;
  return (
    sameMainLocal(fixture.main, initialMainLocal()) &&
    ops.create === null &&
    ops.extendQueue.length === 0 &&
    fixture.expect.warning === null
  );
}

/**
 * Waits until a window stopped resizing after a load: main applied the renderer's last
 * `window:layout` (the detail window follows the main one) and the renderer resized to it.
 * Settled = two equal readings in a row with the page viewport within 2 DIP of the content
 * bounds (fractional scale factors round the physical size; the width and scroll checks catch
 * a real mismatch). Never throws: the caller records `settled: false` as a failure and still
 * checks the rest.
 */
export async function settleWindow(
  app: LaunchedApp,
  kind: WindowKind,
  timeoutMs = 5_000,
): Promise<{ settled: boolean; detail: string }> {
  const page = await app.page(kind);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    const [bounds, inner] = await Promise.all([
      app.harness.bounds(),
      page.evaluate(() => [window.innerWidth, window.innerHeight] as const),
    ]);
    const content = bounds[kind]?.content;
    const detail = `content ${content?.width}×${content?.height}, viewport ${inner[0]}×${inner[1]}`;
    const close =
      content !== undefined &&
      Math.abs(content.width - inner[0]) <= 2 &&
      Math.abs(content.height - inner[1]) <= 2;
    if (close && detail === last) {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      return { settled: true, detail };
    }
    if (Date.now() > deadline) return { settled: false, detail };
    last = detail;
    await page.waitForTimeout(50);
  }
}

/** `settleWindow(app, 'main')`. */
export function settleMain(
  app: LaunchedApp,
  timeoutMs = 5_000,
): Promise<{ settled: boolean; detail: string }> {
  return settleWindow(app, 'main', timeoutMs);
}

export interface ClippedElement {
  element: string;
  text: string;
  axis: 'x' | 'y';
  scroll: number;
  client: number;
}

export interface LayoutProbe {
  width: number;
  height: number;
  density: string | null;
  /** `html[data-scroll]`: the section column scrolls (only below the test matrix). */
  scrollMode: boolean;
  document: {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  };
  /** The main window's section column (`[data-scroll-root]`); `null` in a detail window. */
  column: { scrollHeight: number; clientHeight: number } | null;
  clipped: ClippedElement[];
}

/**
 * Measures a window: document and section-column overflow, and clipped text:
 * - every `[data-fit]` element (the kit marks single-line text that must fit) whose content is
 *   wider than its box;
 * - every element that clips its own overflow (`overflow` other than `visible`, i.e. hidden,
 *   clip or ellipsis) and holds text, whose content is wider or taller than its box.
 * Scroll containers of a detail window are allowed to scroll vertically.
 */
export async function probeLayout(page: Page): Promise<LayoutProbe> {
  return page.evaluate(() => {
    const html = document.documentElement;
    const scroller = document.scrollingElement ?? html;
    const column = document.querySelector<HTMLElement>('[data-scroll-root]');
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    const hasText = (el: Element): boolean =>
      [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) ||
      (el.textContent?.trim().length ?? 0) > 0;
    const visible = (el: HTMLElement): boolean => {
      const style = getComputedStyle(el);
      return (
        style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
      );
    };
    // Screen-reader-only text (`.sr-only`: 1×1 px, clipped) is meant to be clipped.
    const visuallyHidden = (el: HTMLElement): boolean => {
      for (
        let node: HTMLElement | null = el;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.clipPath !== 'none') return true;
        if (style.position === 'absolute' && style.clip !== 'auto') return true;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 1 && rect.height <= 1) return true;
      }
      return false;
    };

    const clipped: {
      element: string;
      text: string;
      axis: 'x' | 'y';
      scroll: number;
      client: number;
    }[] = [];
    const seen = new Set<Element>();
    const report = (el: HTMLElement, axis: 'x' | 'y', scroll: number, client: number): void => {
      if (seen.has(el)) return;
      seen.add(el);
      clipped.push({
        element: describe(el),
        text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
        axis,
        scroll,
        client,
      });
    };

    for (const el of document.querySelectorAll<HTMLElement>('[data-fit]')) {
      if (!visible(el) || el.clientWidth === 0 || visuallyHidden(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) report(el, 'x', el.scrollWidth, el.clientWidth);
    }
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (el === column || !visible(el) || !hasText(el) || visuallyHidden(el)) continue;
      const style = getComputedStyle(el);
      const clipsX = style.overflowX !== 'visible' || style.textOverflow === 'ellipsis';
      const clipsY = style.overflowY !== 'visible';
      const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (clipsX && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        report(el, 'x', el.scrollWidth, el.clientWidth);
      }
      if (clipsY && !scrollsY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) {
        report(el, 'y', el.scrollHeight, el.clientHeight);
      }
    }

    return {
      width: window.innerWidth,
      height: window.innerHeight,
      density: html.dataset['density'] ?? null,
      scrollMode: 'scroll' in html.dataset,
      document: {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      },
      column: column
        ? { scrollHeight: column.scrollHeight, clientHeight: column.clientHeight }
        : null,
      clipped,
    };
  });
}

// ---------------------------------------------------------------------------------------
// axe-core
// ---------------------------------------------------------------------------------------

const localRequire = createRequire(__filename);
let axeSource: string | null = null;

/** `node_modules/axe-core/axe.min.js` (hoisted from @axe-core/playwright). */
export function axeScriptPath(): string {
  return localRequire.resolve('axe-core/axe.min.js');
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string; summary: string }[];
}

/**
 * Injects axe-core with `page.evaluate` (Runtime.evaluate is not subject to the page CSP) and
 * runs `axe.run()` on the whole document. `@axe-core/playwright` cannot be used: its normal
 * mode opens a new page, which Electron does not allow.
 */
export async function axeViolations(page: Page): Promise<AxeViolation[]> {
  axeSource ??= readFileSync(axeScriptPath(), 'utf8');
  const loaded = await page.evaluate(() => 'axe' in window);
  if (!loaded) await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: typeof axeRun } }).axe;
    const results = await axe.run(document, { resultTypes: ['violations'] });
    return results.violations;
  });
  return violations.map((v: AxeResult) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.map((n) => ({
      target: n.target.map(String).join(' '),
      summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').trim(),
    })),
  }));
}

export function formatViolations(violations: readonly AxeViolation[]): string {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target}: ${n.summary}`).join('\n'),
    )
    .join('\n');
}
