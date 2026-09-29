/**
 * The mini timer's place (PROMPT §10: 180×44, always on top, draggable, remembers its
 * position). Pure, whole DIP.
 *
 * - Default: the top-right corner of the primary display's work area, 20 DIP from the right and
 *   24 from the top (clear of the main window's 10 DIP corner on Windows).
 * - A remembered position is kept while at least a third of the timer is on a display; after a
 *   display was removed (or the resolution shrank) it comes back inside the nearest work area.
 */
import { MINI_TIMER_SIZE } from '../../shared/prefs';
import type { DisplayInfo, Point, Rect } from './geometry';
import { displayNearestPoint } from './geometry';

export const MINI_TIMER_DEFAULT_INSET = Object.freeze({ right: 20, top: 24 });

export function defaultMiniTimerPosition(workArea: Rect): Point {
  return {
    x: Math.round(
      workArea.x + workArea.width - MINI_TIMER_SIZE.width - MINI_TIMER_DEFAULT_INSET.right,
    ),
    y: Math.round(workArea.y + MINI_TIMER_DEFAULT_INSET.top),
  };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the mini timer goes: the remembered `position` if it is still visible enough, else that
 * position moved inside the nearest display's work area; the default corner of `primary` when
 * nothing is remembered.
 */
export function miniTimerBounds(
  position: Point | null,
  displays: readonly DisplayInfo[],
  primary: DisplayInfo,
): Rect {
  const { width, height } = MINI_TIMER_SIZE;
  if (position === null) return { ...defaultMiniTimerPosition(primary.workArea), width, height };
  const rect = { x: Math.round(position.x), y: Math.round(position.y), width, height };
  const visible = displays.reduce((sum, d) => sum + overlap(d.workArea, rect), 0);
  if (visible * 3 >= width * height) return rect;
  const wa = displayNearestPoint(displays, {
    x: rect.x + width / 2,
    y: rect.y + height / 2,
  }).workArea;
  return {
    x: Math.round(Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - height)),
    width,
    height,
  };
}
