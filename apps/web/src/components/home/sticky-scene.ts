/**
 * Fallback engine of the sticky scene «Ciérrala. Sigue funcionando.» (StickyScene.astro,
 * design plan § 6.5), for browsers without CSS scroll-driven animations.
 *
 * Where `animation-timeline: view()` exists the scene is pure CSS and this module does
 * nothing. Otherwise an inline script in StickyScene.astro has already marked the track with
 * data-scene="fallback" (before it was laid out, so nothing jumps), and this module writes the
 * track's progress into `--progress` (0 → 1 while the stage is stuck): every layer of the
 * scene reads it and computes its own opacity and transform in CSS, with the same timeline
 * table the CSS engine uses.
 *
 * - One passive scroll listener; at most one requestAnimationFrame per frame.
 * - It only works while the track is near the viewport (IntersectionObserver), and never while
 *   the scene is static (reduced motion, or a viewport under 520 px tall: the scene is then a
 *   vertical sequence of stills and ignores `--progress`).
 * - It reads layout first and writes one custom property after, so it never forces a
 *   synchronous layout.
 */

const TRACK = '[data-scene-track]';
/** When the scene is animated; the same query as the animated block of StickyScene.astro. */
const ANIMATED = '(prefers-reduced-motion: no-preference) and (min-height: 520px)';

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function initStickyScene(): void {
  const track = document.querySelector<HTMLElement>(TRACK);
  if (!track || track.dataset.scene !== 'fallback') return;
  // Tells the inline failsafe that the engine is running (otherwise, after 4 s, it turns the
  // scene into its static version rather than leave it stuck at the first frame).
  track.dataset.sceneReady = '';

  const motion = window.matchMedia(ANIMATED);
  let near = false;
  let frame = 0;

  const update = (): void => {
    frame = 0;
    if (!motion.matches) return;
    const rect = track.getBoundingClientRect();
    // The stage is stuck while the track's top is above the viewport's top and its bottom
    // below the viewport's bottom: the same span as `contain 0%` → `contain 100%`.
    const distance = rect.height - window.innerHeight;
    const progress = distance > 0 ? clamp01(-rect.top / distance) : 0;
    track.style.setProperty('--progress', progress.toFixed(4));
  };

  const schedule = (): void => {
    if (frame === 0) frame = window.requestAnimationFrame(update);
  };

  window.addEventListener(
    'scroll',
    () => {
      if (near) schedule();
    },
    { passive: true },
  );
  window.addEventListener('resize', schedule, { passive: true });
  motion.addEventListener('change', schedule);

  // Near = within one viewport of the track. Leaving also updates once, so a fast fling past
  // the scene still settles it on its first or last frame.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) near = entry.isIntersecting;
      schedule();
    },
    { rootMargin: '100% 0px' },
  );
  observer.observe(track);

  // Layout above the scene can still change after load (fonts, galleries): keep it in sync.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(schedule).observe(document.body);
  }

  schedule();
}
