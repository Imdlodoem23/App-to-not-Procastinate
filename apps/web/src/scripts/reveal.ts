/**
 * Reveal on scroll (design plan § 6.2). Loaded once by src/layouts/Base.astro.
 *
 * Markup API (no script needed in components):
 * - `data-reveal` on an element: it starts 30 px lower and transparent, and rises and fades in
 *   once, when its top edge reaches 85 % of the viewport height.
 * - `data-reveal-group` on an ancestor: every `data-reveal` inside it is revealed together when
 *   the GROUP reaches 85 %, staggered in document order (0.15 s apart). Use it for a section
 *   header: eyebrow, headline, lead. The group element itself may also carry `data-reveal`.
 * - `style="--reveal-index: 2"` on an item overrides its place in the stagger.
 * - After it runs, the element has `data-revealed="animating"` and then `"done"`.
 *
 * Only for headlines, gallery tracks, the number blocks, the hero window and the scene
 * headline. Never on the hero h1 (it is the LCP element).
 *
 * The hidden state lives in src/styles/global.css and only applies under `html.js` with
 * `prefers-reduced-motion: no-preference`, so without JavaScript, with reduced motion or when
 * printing, everything is visible from the start. The reveal moves the `translate` property,
 * not `transform`, so it composes with any transform a component sets on the same element.
 */

const ITEM = '[data-reveal]';
const GROUP = '[data-reveal-group]';

/**
 * The observer's box: from far above the viewport down to 85 % of its height. The upper reach
 * matters for jumps (a nav link to #privacidad, the Descargar pill, a reload halfway down): a
 * target the jump passes over goes from below the viewport to above it, and with a box that
 * starts at the viewport top it would be «not intersecting» before and after, so the observer
 * would never call back and the target would stay hidden until it played its entrance while
 * the visitor scrolled back up. With the box reaching above, passing over it is a change, and
 * onIntersect marks it done without animating. In pixels, not %, so a short window or a zoomed
 * page still covers the whole page (the longest, the home page, is about 17 000 px at 320 px).
 */
const ROOT_MARGIN = '100000px 0px -15% 0px';

declare global {
  interface Window {
    /** Set when this module runs; the <head> failsafe in Base.astro checks it. */
    __centrateReveal?: boolean;
  }
}

const registered = new WeakSet<Element>();
let observer: IntersectionObserver | undefined;
const targets = new Map<Element, HTMLElement[]>();

/** Seconds or milliseconds from a CSS time token («0.9s», «150ms»). */
function toMs(value: string): number {
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith('ms') ? n : n * 1000;
}

function finishDelay(el: HTMLElement): number {
  const root = getComputedStyle(document.documentElement);
  const duration = Math.max(
    toMs(root.getPropertyValue('--reveal-duration-transform')),
    toMs(root.getPropertyValue('--reveal-duration-opacity')),
  );
  const stagger = toMs(root.getPropertyValue('--reveal-stagger'));
  const index = Number.parseFloat(getComputedStyle(el).getPropertyValue('--reveal-index')) || 0;
  return duration + stagger * index + 100;
}

function reveal(items: readonly HTMLElement[], animate: boolean): void {
  for (const el of items) {
    if (el.dataset.revealed) continue;
    if (!animate) {
      el.dataset.revealed = 'done';
      continue;
    }
    el.dataset.revealed = 'animating';
    // Drop the transition afterwards so later style changes of the element are not delayed.
    window.setTimeout(() => {
      el.dataset.revealed = 'done';
    }, finishDelay(el));
  }
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const items = targets.get(entry.target);
    if (!items) continue;
    // Compare with the real viewport top (0), not rootBounds.top, which is far above it.
    if (entry.boundingClientRect.bottom <= 0) {
      // Above the viewport: the visitor jumped or reloaded past it without seeing it. Show it
      // without animating, so scrolling back up does not replay an entrance.
      reveal(items, false);
    } else if (entry.isIntersecting) {
      reveal(items, true);
    } else {
      continue;
    }
    observer?.unobserve(entry.target);
    targets.delete(entry.target);
  }
}

/**
 * Registers every not-yet-registered `[data-reveal]` under `root`. Safe to call again for
 * content added later.
 */
export function initReveal(root: ParentNode = document): void {
  window.__centrateReveal = true;

  const items = Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter(
    (el) => !registered.has(el),
  );
  if (items.length === 0) return;
  for (const el of items) registered.add(el);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof IntersectionObserver !== 'function') {
    reveal(items, false);
    return;
  }

  // Group the items by what the observer watches: their nearest group, or themselves.
  const batches = new Map<Element, HTMLElement[]>();
  for (const el of items) {
    const target = el.closest(GROUP) ?? el;
    const batch = batches.get(target);
    if (batch) batch.push(el);
    else batches.set(target, [el]);
  }

  observer ??= new IntersectionObserver(onIntersect, {
    rootMargin: ROOT_MARGIN,
    threshold: 0,
  });

  for (const [target, batch] of batches) {
    batch.forEach((el, index) => {
      if (el.style.getPropertyValue('--reveal-index') === '') {
        el.style.setProperty('--reveal-index', String(index));
      }
    });
    const existing = targets.get(target);
    if (existing) {
      existing.push(...batch);
    } else {
      targets.set(target, batch);
      observer.observe(target);
    }
  }
}
