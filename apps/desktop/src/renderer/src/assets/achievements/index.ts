/**
 * Achievement badges (PROMPT §10 «Logros», docs/brand.md «Logros»): one SVG per id of
 * `ACHIEVEMENTS`, on the 24 grid with a 1.75 px stroke at any size (non-scaling, like the
 * app's lucide icons). Best at 24–48 px; at 20 px the tally of `sessions-25` closes up.
 *
 * Each badge is the brand's ring around one symbol, and each file holds both states as SVG
 * views, so the shape changes with the state and not only the color:
 * - `#earned` (the default): closed ring, painted `green`;
 * - `#pending`: the ring with the brand's 80° gap at 3 o'clock, painted `fgMuted`.
 *
 * Symbols: «1» first session, padlock first block (Bloqueo's icon), flame 7-day streak,
 * open book 10 h (Study Mode's icon), sparkle clean week, tally 25 sessions, bonfire 30-day
 * streak, books 50 h. Names and progress go in the tile's text, never in the badge.
 *
 * Like the mascot, the SVGs hold no colors and are painted through a CSS mask (`glyphMask`,
 * see `../mascot`), so they follow the theme; do not put them in an `<img>`.
 */
import type { CSSProperties } from 'react';
import type { AchievementId } from '@centrate/shared/points';
import { glyphMask, type GlyphTone } from '../mascot';
import cleanWeek from './clean-week.svg?url&inline';
import firstBlock from './first-block.svg?url&inline';
import firstSession from './first-session.svg?url&inline';
import sessions25 from './sessions-25.svg?url&inline';
import streak30 from './streak-30.svg?url&inline';
import streak7 from './streak-7.svg?url&inline';
import study10h from './study-10h.svg?url&inline';
import study50h from './study-50h.svg?url&inline';

/** Which view of a badge to show. */
export type BadgeState = 'earned' | 'pending';

/** Every badge SVG as a `data:` URL (its default view is `earned`), by achievement id. */
export const ACHIEVEMENT_BADGES: Readonly<Record<AchievementId, string>> = Object.freeze({
  'first-session': firstSession,
  'first-block': firstBlock,
  'streak-7': streak7,
  'study-10h': study10h,
  'clean-week': cleanWeek,
  'sessions-25': sessions25,
  'streak-30': streak30,
  'study-50h': study50h,
});

/** URL of the badge of `id` in the state that matches `achieved`. */
export function achievementBadgeFor(id: AchievementId, achieved: boolean): string {
  const state: BadgeState = achieved ? 'earned' : 'pending';
  return `${ACHIEVEMENT_BADGES[id]}#${state}`;
}

/** Badge color: `green` when earned, `fgMuted` while pending (docs/brand.md). */
export function badgeTone(achieved: boolean): GlyphTone {
  return achieved ? 'green' : 'fgMuted';
}

/**
 * Inline style that paints the badge of `id`: give the element a size and
 * `aria-hidden="true"` (the tile's label names the achievement).
 */
export function achievementBadgeStyle(id: AchievementId, achieved: boolean): CSSProperties {
  return glyphMask(achievementBadgeFor(id, achieved), badgeTone(achieved));
}
