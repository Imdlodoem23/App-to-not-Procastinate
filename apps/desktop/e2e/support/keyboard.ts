/**
 * In-page keyboard and ARIA audit (PROMPT §10 «Teclado y accesibilidad», docs/DESKTOP.md
 * §7.3, §7.4), shared by `keyboard.spec.ts`:
 *
 * - **Targets:** every enabled interactive element offers a 32×32 hit area: its box, its
 *   `::before` / `::after` hit extensions (absolutely positioned insets, as `c-pill`, `c-chip`
 *   and `c-textbutton` use) and, for inputs, their labels; minus what an ancestor clips. The
 *   32×32 square is then hit-tested with `elementFromPoint`, so a neighbour's extension that
 *   covers it counts as a miss.
 * - **Descriptions:** every `aria-describedby` id resolves; tiles in a row (`data-row-tile`) and
 *   the controls of a `SettingsRow` with a description are described.
 * - **Shortcuts:** no two visible elements share an `aria-keyshortcuts` value, and every
 *   visible tile has one (Alt + letter, like G-Helper).
 * - **Live regions:** a `MutationObserver` installed once the window has loaded flags any
 *   element that gains `aria-live` / a live role afterwards and any live region mounted with its
 *   text already in it: screen readers only announce changes inside a region they already
 *   track.
 */
import type { Page } from '@playwright/test';

/** PROMPT §10 «Objetivos de clic: 32×32 px como mínimo». */
export const MIN_TARGET = 32;

export interface SmallTarget {
  element: string;
  /** Hit area in CSS px (after pseudo-element extensions and clipping). */
  width: number;
  height: number;
  /** Points of the 32×32 square that hit the element (0 when the area is too small). */
  hits: number;
  samples: number;
  /** What was hit instead, for the first miss. */
  covered: string | null;
}

export interface KeyboardAudit {
  smallTargets: SmallTarget[];
  brokenDescribedBy: { element: string; missing: string[] }[];
  undescribed: { element: string; where: 'row' | 'settings' }[];
  duplicateShortcuts: { shortcut: string; elements: string[] }[];
  tilesWithoutShortcut: string[];
}

/** Everything `auditKeyboard` found, as an empty-means-pass list of lines. */
export function auditProblems(audit: KeyboardAudit): string[] {
  return [
    ...audit.smallTargets.map(
      (t) =>
        `target ${t.element}: ${t.width}×${t.height}` +
        (t.samples
          ? `, ${t.hits}/${t.samples} points hit${t.covered ? ` (covered by ${t.covered})` : ''}`
          : ''),
    ),
    ...audit.brokenDescribedBy.map(
      (d) => `aria-describedby of ${d.element}: no element with id ${d.missing.join(', ')}`,
    ),
    ...audit.undescribed.map(
      (d) =>
        `${d.element}: no aria-describedby (${d.where === 'row' ? 'tile in a row' : 'SettingsRow'})`,
    ),
    ...audit.duplicateShortcuts.map(
      (d) => `aria-keyshortcuts ${d.shortcut} on ${d.elements.length}: ${d.elements.join(' · ')}`,
    ),
    ...audit.tilesWithoutShortcut.map((t) => `tile without aria-keyshortcuts: ${t}`),
  ];
}

/** Runs the audit in `page` (scrolls a detail window as needed; nothing else changes). */
export async function auditKeyboard(page: Page): Promise<KeyboardAudit> {
  return page.evaluate((min) => {
    const INTERACTIVE = [
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      'a[href]',
      '[role="button"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="link"]',
      '[role="tab"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    const accessibleText = (el: Element): string =>
      (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      const text = accessibleText(el).slice(0, 40);
      return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` «${text}»` : ''}`;
    };
    const rendered = (el: Element): boolean => {
      if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false;
      if (el.closest('[inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(el);
      return (
        style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0
      );
    };
    // Screen-reader-only elements (`.sr-only`: 1×1 px, clipped) take no clicks themselves.
    const visuallyHidden = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        (rect.width <= 1 && rect.height <= 1) || style.clipPath !== 'none' || style.opacity === '0'
      );
    };

    type Box = { left: number; top: number; right: number; bottom: number };
    const union = (a: Box | null, b: Box): Box =>
      a
        ? {
            left: Math.min(a.left, b.left),
            top: Math.min(a.top, b.top),
            right: Math.max(a.right, b.right),
            bottom: Math.max(a.bottom, b.bottom),
          }
        : b;
    const px = (value: string): number | null => (value.endsWith('px') ? parseFloat(value) : null);

    /** The element's border box plus positioned pseudo-element hit extensions. */
    const ownBox = (el: Element): Box | null => {
      let box: Box | null = null;
      if (!visuallyHidden(el)) {
        const r = el.getBoundingClientRect();
        box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
      const own = getComputedStyle(el);
      if (own.position === 'static') return box;
      // Insets are measured from the containing block's padding box (inside the border).
      const b = el.getBoundingClientRect();
      const r = {
        left: b.left + parseFloat(own.borderLeftWidth),
        top: b.top + parseFloat(own.borderTopWidth),
        right: b.right - parseFloat(own.borderRightWidth),
        bottom: b.bottom - parseFloat(own.borderBottomWidth),
      };
      for (const pseudo of ['::before', '::after'] as const) {
        const style = getComputedStyle(el, pseudo);
        if (style.content === 'none' || style.content === 'normal') continue;
        if (style.position !== 'absolute' || style.pointerEvents === 'none') continue;
        const top = px(style.top);
        const left = px(style.left);
        const right = px(style.right);
        const bottom = px(style.bottom);
        if (top === null || left === null || right === null || bottom === null) continue;
        box = union(box, {
          left: r.left + left,
          top: r.top + top,
          right: r.right - right,
          bottom: r.bottom - bottom,
        });
      }
      return box;
    };

    /** What ancestors that clip their overflow leave of `box`. */
    const clipBox = (el: Element, box: Box): Box => {
      let out = { ...box };
      for (
        let node = el.parentElement;
        node && node !== document.documentElement;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        if (style.overflowX !== 'visible') {
          out = { ...out, left: Math.max(out.left, r.left), right: Math.min(out.right, r.right) };
        }
        if (style.overflowY !== 'visible') {
          out = { ...out, top: Math.max(out.top, r.top), bottom: Math.min(out.bottom, r.bottom) };
        }
      }
      return out;
    };

    // `scrollIntoView` below moves scroll containers (detail windows); put them back after.
    const scrolled = [
      document.scrollingElement ?? document.documentElement,
      ...document.querySelectorAll('*'),
    ]
      .filter(
        (el) => el.scrollTop !== 0 || el.scrollLeft !== 0 || el.scrollHeight > el.clientHeight,
      )
      .map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));

    const smallTargets: {
      element: string;
      width: number;
      height: number;
      hits: number;
      samples: number;
      covered: string | null;
    }[] = [];
    const seen = new Set<Element>();
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (seen.has(el) || !rendered(el) || el.matches(':disabled')) continue;
      seen.add(el);
      const parts: Element[] = [el];
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        for (const label of el.labels ?? []) parts.push(label);
      }
      const owns = (hit: Element | null): boolean =>
        hit !== null && parts.some((p) => p === hit || p.contains(hit));

      if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      let box: Box | null = null;
      for (const part of parts) {
        const own = ownBox(part);
        if (own) box = union(box, clipBox(part, own));
      }
      if (!box) continue;
      const width = Math.round((box.right - box.left) * 10) / 10;
      const height = Math.round((box.bottom - box.top) * 10) / 10;
      if (width + 0.5 < min || height + 0.5 < min) {
        smallTargets.push({
          element: describe(el),
          width,
          height,
          hits: 0,
          samples: 0,
          covered: null,
        });
        continue;
      }
      // A min×min square centred in the hit area, sampled on a 4×4 grid 1 px inside its edges
      // (hit testing rounds coordinates, so a point 0.5 px from an edge can land outside).
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      const half = min / 2 - 1;
      let hits = 0;
      let samples = 0;
      let covered: string | null = null;
      for (let i = 0; i < 4; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          const x = cx - half + (i * 2 * half) / 3;
          const y = cy - half + (j * 2 * half) / 3;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          samples += 1;
          const hit = document.elementFromPoint(x, y);
          if (owns(hit)) hits += 1;
          else
            covered ??= `${hit ? describe(hit) : 'nothing'} at ${Math.round(x)},${Math.round(y)} (box ${Math.round(box.left)},${Math.round(box.top)}–${Math.round(box.right)},${Math.round(box.bottom)}, viewport ${innerWidth}×${innerHeight})`;
        }
      }
      if (samples > 0 && hits < samples) {
        smallTargets.push({ element: describe(el), width, height, hits, samples, covered });
      }
    }
    for (const { el, top, left } of scrolled) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }

    const brokenDescribedBy: { element: string; missing: string[] }[] = [];
    for (const el of document.querySelectorAll('[aria-describedby]')) {
      const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      const missing = ids.filter((id) => !document.getElementById(id));
      if (ids.length === 0 || missing.length > 0) {
        brokenDescribedBy.push({
          element: describe(el),
          missing: ids.length ? missing : ['(empty)'],
        });
      }
    }

    /** `aria-describedby` on the element or on its group / radiogroup / control box. */
    const described = (el: Element, stop: Element): boolean => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if ((node.getAttribute('aria-describedby') ?? '').trim()) return true;
        if (node === stop) return false;
      }
      return false;
    };
    const undescribed: { element: string; where: 'row' | 'settings' }[] = [];
    for (const tile of document.querySelectorAll('[data-row-tile]')) {
      if (rendered(tile) && !(tile.getAttribute('aria-describedby') ?? '').trim()) {
        undescribed.push({ element: describe(tile), where: 'row' });
      }
    }
    for (const row of document.querySelectorAll('.c-settings-row')) {
      if (!rendered(row) || !row.querySelector('.c-settings-desc')) continue;
      const control = row.querySelector('.c-settings-control') ?? row;
      for (const el of control.querySelectorAll(INTERACTIVE)) {
        if (!rendered(el) || el.hasAttribute('data-row-tile')) continue;
        if (!described(el, control)) undescribed.push({ element: describe(el), where: 'settings' });
      }
    }

    const byShortcut = new Map<string, string[]>();
    for (const el of document.querySelectorAll('[aria-keyshortcuts]')) {
      if (!rendered(el)) continue;
      for (const raw of (el.getAttribute('aria-keyshortcuts') ?? '').split(/\s+/).filter(Boolean)) {
        const keys = raw.toLowerCase().split('+');
        const key = keys.pop() ?? '';
        const shortcut = [...keys.sort(), key].join('+');
        byShortcut.set(shortcut, [...(byShortcut.get(shortcut) ?? []), describe(el)]);
      }
    }
    const duplicateShortcuts = [...byShortcut.entries()]
      .filter(([, elements]) => elements.length > 1)
      .map(([shortcut, elements]) => ({ shortcut, elements }));
    const tilesWithoutShortcut = [...document.querySelectorAll('.c-tile')]
      .filter((t) => rendered(t) && !(t.getAttribute('aria-keyshortcuts') ?? '').trim())
      .map(describe);

    return {
      smallTargets,
      brokenDescribedBy,
      undescribed,
      duplicateShortcuts,
      tilesWithoutShortcut,
    };
  }, MIN_TARGET);
}

// ---------------------------------------------------------------------------------------
// Live regions
// ---------------------------------------------------------------------------------------

export interface LiveEvent {
  kind: 'gained' | 'mounted';
  element: string;
  text: string;
}

const LIVE_KEY = '__centrateLiveAudit';

/**
 * Starts watching `page` for live regions that appear late: an element that gains `aria-live`
 * (other than `off`) or a live role (`status`, `alert`, `log`, `marquee`) after this call, or a
 * live region inserted with text already in it. Idempotent; `liveEvents` reads what it saw.
 */
export async function watchLiveRegions(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const store = window as unknown as Record<string, { events: unknown[] } | undefined>;
    if (store[key]) return;
    const events: { kind: 'gained' | 'mounted'; element: string; text: string }[] = [];
    store[key] = { events };
    const LIVE =
      '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"]';
    const text = (el: Element): string =>
      (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      const role = el.getAttribute('role');
      const live = el.getAttribute('aria-live');
      return `${el.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ''}${live ? `[aria-live=${live}]` : ''}`;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          const el = record.target as Element;
          if (el.matches(LIVE))
            events.push({ kind: 'gained', element: describe(el), text: text(el) });
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const regions = [...(node.matches(LIVE) ? [node] : []), ...node.querySelectorAll(LIVE)];
          for (const region of regions) {
            if (text(region))
              events.push({ kind: 'mounted', element: describe(region), text: text(region) });
          }
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-live', 'role'],
    });
  }, LIVE_KEY);
}

export async function liveEvents(page: Page): Promise<LiveEvent[]> {
  return page.evaluate(
    (key) =>
      ((window as unknown as Record<string, { events: LiveEvent[] } | undefined>)[key]?.events ??
        []) as LiveEvent[],
    LIVE_KEY,
  );
}

// ---------------------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------------------

export interface FocusInfo {
  /** `body` / `html` when nothing has the focus. */
  tag: string;
  element: string;
  /** Accessible-ish name: aria-label, else the text. */
  name: string;
  classes: string;
  role: string | null;
  section: string | null;
  isSectionRoot: boolean;
}

/** What has the focus in `page` (the document's active element). */
export async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const el = document.activeElement ?? document.body;
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    const cls = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName.toLowerCase(),
      element: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`,
      name: name.slice(0, 60),
      classes: cls,
      role: el.getAttribute('role'),
      section: el.closest('[data-section]')?.getAttribute('data-section') ?? null,
      isSectionRoot: el.hasAttribute('data-section'),
    };
  });
}

/** `true` when the focus is on something real (not `<body>` / `<html>` / nothing). */
export function focusIsSomewhere(info: FocusInfo): boolean {
  return info.tag !== 'body' && info.tag !== 'html';
}
