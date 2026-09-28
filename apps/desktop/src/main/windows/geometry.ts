/**
 * Window geometry (docs/DESKTOP.md §8.3–8.5, PROMPT §10 «Ventana principal»). Pure: no
 * Electron import, every value in DIP, every result rounded to whole DIP.
 *
 * - The main window sits `SCREEN_INSET` (10) from the work area of the tray display, on the
 *   right: bottom-right on Windows (whatever the taskbar edge, like G-Helper), top-right on
 *   macOS, and on Linux the right corner of the panel side.
 * - Its height follows the renderer, clamped to `maxContentHeight`, and grows or shrinks from
 *   the **anchored edge** (bottom on Windows, top on macOS), never downwards off screen.
 * - The detail window (600 wide) is glued to the left of the main window with a 6 DIP gap,
 *   to the right when there is no room, and pinned to the work area's left edge otherwise.
 * - At fractional scale factors every window's left edge and anchored edge sit on the
 *   display's device-pixel grid (`PixelGrid`), moved 0–3 DIP inward to get there: an origin
 *   between two pixels makes the platform round the rect outwards (Linux/X11 converts it with
 *   an enclosing-pixel rounding), so a 440 DIP window became 441–442 DIP wide at 125/150 %.
 */
import { layout } from '@centrate/shared/design/tokens';
import type { FrameInsets, Rect } from '../../shared/fixtures';
import type { Platform, WindowAnchor, WindowLayout } from '../../shared/ui-state';

export type { FrameInsets, Rect };

export interface Point {
  x: number;
  y: number;
}

/** What `screen` reports for one display (DIP). */
export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
}

export const SCREEN_INSET = layout.screenInset;
export const MAIN_CONTENT_WIDTH = layout.mainWidth;
export const DETAIL_CONTENT_WIDTH = layout.detailWidth;
export const DETAIL_MIN_CONTENT_HEIGHT = layout.detailMinHeight;
export const DETAIL_GAP = layout.detailGap;
/** Height the main window uses before the renderer ever measured itself. */
export const MAIN_DEFAULT_CONTENT_HEIGHT = layout.restMaxHeight;
/** Never ask for a window smaller than this, whatever a fake work area says. */
const MIN_CONTENT_HEIGHT = 120;

export const ZERO_FRAME: FrameInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

// ---------------------------------------------------------------------------------------
// Rect helpers
// ---------------------------------------------------------------------------------------

export function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function isZeroRect(r: Rect | null | undefined): boolean {
  return !r || (r.x === 0 && r.y === 0 && r.width === 0 && r.height === 0);
}

export function isZeroFrame(f: FrameInsets): boolean {
  return f.top === 0 && f.right === 0 && f.bottom === 0 && f.left === 0;
}

/** Native frame insets from a window's outer and content bounds (`getBounds` − `getContentBounds`). */
export function frameInsets(outer: Rect, content: Rect): FrameInsets {
  return {
    top: Math.max(0, content.y - outer.y),
    left: Math.max(0, content.x - outer.x),
    right: Math.max(0, rectRight(outer) - rectRight(content)),
    bottom: Math.max(0, rectBottom(outer) - rectBottom(content)),
  };
}

export function outerFromContent(content: Rect, frame: FrameInsets): Rect {
  return {
    x: content.x - frame.left,
    y: content.y - frame.top,
    width: content.width + frame.left + frame.right,
    height: content.height + frame.top + frame.bottom,
  };
}

export function contentFromOuter(outer: Rect, frame: FrameInsets): Rect {
  return {
    x: outer.x + frame.left,
    y: outer.y + frame.top,
    width: outer.width - frame.left - frame.right,
    height: outer.height - frame.top - frame.bottom,
  };
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  const h = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (rectRight(r) - 1));
  const dy = Math.max(r.y - p.y, 0, p.y - (rectBottom(r) - 1));
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------------------
// Device-pixel grid
// ---------------------------------------------------------------------------------------

/** Physical pixel edges of a display: `origin + n / scaleFactor` DIP on each axis. */
export interface PixelGrid {
  origin: Point;
  scaleFactor: number;
}

/** The grid of `display` (pixels counted from its top-left corner, like Windows does). */
export function pixelGrid(display: Pick<DisplayInfo, 'bounds' | 'scaleFactor'>): PixelGrid {
  return {
    origin: { x: display.bounds.x, y: display.bounds.y },
    scaleFactor: display.scaleFactor,
  };
}

/** Most whole DIP an edge moves to reach the grid (4 DIP = 5 px at 125 %: 0–3 moves). */
export const PIXEL_SNAP_MAX = 3;

const GRID_EPSILON = 1e-6;

/** Whether `value` (DIP) is a physical pixel edge of the axis starting at `origin`. */
export function isOnPixelGrid(value: number, origin: number, scaleFactor: number): boolean {
  const px = (value - origin) * scaleFactor;
  return Math.abs(px - Math.round(px)) < GRID_EPSILON;
}

/**
 * How far (DIP) an inset may exceed its nominal value once snapped at `scaleFactor`: 0 at
 * 100 or 200 %, 3 at 125 % (a pixel edge every 4 DIP), 1 at 150 % (every 2 DIP). 0 as well
 * when the grid is coarser than 4 DIP (110 %): the edge then stays where it was.
 */
export function pixelSnapSlack(scaleFactor: number): number {
  if (!(scaleFactor > 0)) return 0;
  for (let step = 1; step <= PIXEL_SNAP_MAX + 1; step += 1) {
    if (isOnPixelGrid(step, 0, scaleFactor)) return step - 1;
  }
  return 0;
}

export interface SnapLimits {
  min?: number;
  max?: number;
}

/**
 * `value` rounded to whole DIP, then moved 0–3 DIP towards `preferred` (−1: smaller, +1:
 * larger) to the nearest device-pixel edge; failing that (a limit in the way), 1–3 DIP the
 * other way. Candidates outside `limits` are skipped. Without a grid (`null`), an integer
 * scale factor, or no edge within reach, the rounded value clamped to `limits`.
 */
export function snapToPixelGrid(
  value: number,
  axisOrigin: number,
  grid: PixelGrid | null | undefined,
  preferred: 1 | -1,
  limits: SnapLimits = {},
): number {
  const min = limits.min ?? Number.NEGATIVE_INFINITY;
  const max = limits.max ?? Number.POSITIVE_INFINITY;
  const start = Math.min(Math.max(Math.round(value), min), Math.max(min, max));
  if (!grid || !(grid.scaleFactor > 0) || Number.isInteger(grid.scaleFactor)) return start;
  for (const direction of [preferred, -preferred]) {
    for (let k = direction === preferred ? 0 : 1; k <= PIXEL_SNAP_MAX; k += 1) {
      const candidate = start + direction * k;
      if (candidate < min || candidate > max) continue;
      if (isOnPixelGrid(candidate, axisOrigin, grid.scaleFactor)) return candidate;
    }
  }
  return start;
}

function snapX(
  value: number,
  grid: PixelGrid | null | undefined,
  preferred: 1 | -1,
  limits?: SnapLimits,
): number {
  return snapToPixelGrid(value, grid?.origin.x ?? 0, grid, preferred, limits);
}

function snapY(
  value: number,
  grid: PixelGrid | null | undefined,
  preferred: 1 | -1,
  limits?: SnapLimits,
): number {
  return snapToPixelGrid(value, grid?.origin.y ?? 0, grid, preferred, limits);
}

/**
 * Whether a window set to `requested` came out at another width although `requested` is whole
 * pixels (left edge on the grid, width a whole number of pixels): the platform kept an older,
 * rounded-up pixel size. Electron on Linux does that when the DIP size did not change, e.g.
 * after an earlier off-grid placement: the size must be set again, via a different one.
 */
export function needsSizeReapply(
  requested: Rect,
  actual: Rect,
  grid: PixelGrid | null | undefined,
): boolean {
  if (!grid || !(grid.scaleFactor > 0) || Number.isInteger(grid.scaleFactor)) return false;
  const exact =
    isOnPixelGrid(requested.x, grid.origin.x, grid.scaleFactor) &&
    isOnPixelGrid(requested.width, 0, grid.scaleFactor);
  return exact && actual.width !== requested.width;
}

// ---------------------------------------------------------------------------------------
// User moves
// ---------------------------------------------------------------------------------------

/** Readback rounding between where a window was put and where it reports being (DIP). */
export const MOVE_TOLERANCE = 1;

/** Whether `actual`'s origin is more than `tolerance` DIP away from `expected`'s. */
export function movedAway(actual: Rect, expected: Rect, tolerance = MOVE_TOLERANCE): boolean {
  return Math.abs(actual.x - expected.x) > tolerance || Math.abs(actual.y - expected.y) > tolerance;
}

// ---------------------------------------------------------------------------------------
// Which display
// ---------------------------------------------------------------------------------------

/** The display containing `point`, else the nearest one (like `screen.getDisplayNearestPoint`). */
export function displayNearestPoint(displays: readonly DisplayInfo[], point: Point): DisplayInfo {
  const first = displays[0];
  if (!first) throw new Error('no displays');
  let best = first;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const d of displays) {
    const distance = distanceToRect(point, d.bounds);
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

/** The display a rectangle overlaps most, else the one nearest its centre (`getDisplayMatching`). */
export function displayMatching(displays: readonly DisplayInfo[], rect: Rect): DisplayInfo {
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = intersectionArea(d.bounds, rect);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return (
    best ??
    displayNearestPoint(displays, {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    })
  );
}

/**
 * The display the main window opens on: the tray's (Windows, macOS), falling back to the
 * cursor's when the tray reports empty bounds; on Linux `tray.getBounds()` is always zeros,
 * so the cursor's display.
 */
export function chooseDisplay(
  platform: Platform,
  displays: readonly DisplayInfo[],
  trayBounds: Rect | null,
  cursor: Point,
): DisplayInfo {
  if (platform !== 'linux' && trayBounds && !isZeroRect(trayBounds)) {
    return displayMatching(displays, trayBounds);
  }
  return displayNearestPoint(displays, cursor);
}

// ---------------------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------------------

/**
 * Which edge stays fixed. Windows: bottom (G-Helper's corner, even with the taskbar on top).
 * macOS: top (menu bar). Linux: the panel side; a panel on top, or none at all (Ubuntu
 * reports both insets as 0 under some compositors), anchors to the top.
 */
export function anchorFor(platform: Platform, display: DisplayInfo): WindowAnchor {
  if (platform === 'win32') return 'bottom';
  if (platform === 'darwin') return 'top';
  const topInset = display.workArea.y - display.bounds.y;
  const bottomInset = rectBottom(display.bounds) - rectBottom(display.workArea);
  return topInset >= bottomInset ? 'top' : 'bottom';
}

/** `workArea.height − 2 × 10 − frame.top − frame.bottom` (same formula as `layoutForDisplay`). */
export function maxContentHeight(workArea: Rect, frame: FrameInsets): number {
  return Math.max(
    MIN_CONTENT_HEIGHT,
    Math.floor(workArea.height - 2 * SCREEN_INSET - frame.top - frame.bottom),
  );
}

export function windowLayout(
  platform: Platform,
  display: DisplayInfo,
  frame: FrameInsets,
): WindowLayout {
  return {
    maxContentHeight: maxContentHeight(display.workArea, frame),
    anchor: anchorFor(platform, display),
  };
}

/** A renderer-reported height clamped to the budget, in whole DIP. */
export function clampContentHeight(height: number, max: number): number {
  if (!Number.isFinite(height)) return Math.max(1, Math.round(max));
  return Math.max(1, Math.min(Math.round(max), Math.ceil(height)));
}

export interface MainPlacementInput {
  workArea: Rect;
  frame: FrameInsets;
  anchor: WindowAnchor;
  /** Content height (clamped by the caller or here to the work area). */
  height: number;
  width?: number;
  /** The display's pixel grid (`pixelGrid(display)`); omitted: whole DIP only. */
  grid?: PixelGrid | null;
}

/**
 * Content rect of the main window at its corner: outer edges 10 DIP from the work area's
 * right edge and from the anchored edge, plus 0–3 DIP at fractional scales so the left and
 * anchored edges are pixel edges (never closer than 10 DIP).
 */
export function mainContentRect(input: MainPlacementInput): Rect {
  const { workArea: wa, frame, anchor, grid } = input;
  const width = Math.round(input.width ?? MAIN_CONTENT_WIDTH);
  const height = clampContentHeight(input.height, maxContentHeight(wa, frame));
  const x0 = Math.round(rectRight(wa) - SCREEN_INSET - frame.right - width);
  const x = snapX(x0, grid, -1, { max: x0 });
  let y: number;
  if (anchor === 'bottom') {
    const bottom0 = Math.round(rectBottom(wa) - SCREEN_INSET - frame.bottom);
    y = snapY(bottom0, grid, -1, { max: bottom0 }) - height;
  } else {
    const y0 = Math.round(wa.y + SCREEN_INSET + frame.top);
    y = snapY(y0, grid, 1, { min: y0 });
  }
  return { x, y, width, height };
}

/**
 * New content rect when the height changes while the window is shown: the anchored edge of
 * `current` stays where it is (bottom: `y = bottom − height`; top: `y` unchanged), then the
 * window is kept inside the work area. With a grid, the left and anchored edges go to the
 * nearest pixel edge (a no-op for a rect this module placed).
 */
export function resizeAnchored(
  current: Rect,
  height: number,
  anchor: WindowAnchor,
  workArea: Rect,
  frame: FrameInsets,
  grid?: PixelGrid | null,
): Rect {
  const h = clampContentHeight(height, maxContentHeight(workArea, frame));
  const minY = Math.round(workArea.y + frame.top);
  const maxY = Math.max(minY, Math.round(rectBottom(workArea) - frame.bottom - h));
  let y: number;
  if (anchor === 'bottom') {
    y = snapY(rectBottom(current), grid, -1, { min: minY + h, max: maxY + h }) - h;
  } else {
    y = snapY(current.y, grid, 1, { min: minY, max: maxY });
  }
  const x = snapX(current.x, grid, -1);
  return { x, y, width: Math.round(current.width), height: h };
}

// ---------------------------------------------------------------------------------------
// Detail window
// ---------------------------------------------------------------------------------------

export type DetailSide = 'left' | 'right' | 'pinned';

export interface DetailPlacementInput {
  /** Outer bounds of the main window (real, or content + fake frame under xvfb). */
  mainOuter: Rect;
  workArea: Rect;
  anchor: WindowAnchor;
  /** The detail window's own frame insets. */
  frame: FrameInsets;
  width?: number;
  minHeight?: number;
  /** The pixel grid of the display it goes on (`pixelGrid(display)`). */
  grid?: PixelGrid | null;
}

export interface DetailPlacement {
  outer: Rect;
  content: Rect;
  side: DetailSide;
}

/**
 * Detail window rect: outer height = the main window's outer height (at least 480 of content),
 * clamped to the work area; aligned on the main window's anchored edge; left of it with a
 * 6 DIP gap, else right of it, else pinned to the work area's left edge. With a grid, its
 * content's left and anchored edges are pixel edges (the gap then grows by 0–3 DIP).
 */
export function detailPlacement(input: DetailPlacementInput): DetailPlacement {
  const { mainOuter, workArea: wa, anchor, frame, grid } = input;
  const width = input.width ?? DETAIL_CONTENT_WIDTH;
  const minContent = input.minHeight ?? DETAIL_MIN_CONTENT_HEIGHT;
  const outerWidth = width + frame.left + frame.right;
  const maxOuterHeight = Math.max(1, wa.height - 2 * SCREEN_INSET);
  const outerHeight = Math.min(
    maxOuterHeight,
    Math.max(mainOuter.height, minContent + frame.top + frame.bottom),
  );

  let y = anchor === 'bottom' ? rectBottom(mainOuter) - outerHeight : mainOuter.y;
  y = Math.min(Math.max(y, wa.y), Math.max(wa.y, rectBottom(wa) - outerHeight));

  const left = mainOuter.x - DETAIL_GAP - outerWidth;
  const right = rectRight(mainOuter) + DETAIL_GAP;
  let x: number;
  let side: DetailSide;
  if (left >= wa.x) {
    x = left;
    side = 'left';
  } else if (right + outerWidth <= rectRight(wa)) {
    x = right;
    side = 'right';
  } else {
    x = wa.x;
    side = 'pinned';
  }
  const rounded = roundRect(
    contentFromOuter({ x, y, width: outerWidth, height: outerHeight }, frame),
  );
  if (!grid) return { outer: outerFromContent(rounded, frame), content: rounded, side };

  const minX = Math.round(wa.x + frame.left);
  const maxX = Math.round(rectRight(wa) - frame.right - rounded.width);
  const contentX =
    side === 'left'
      ? snapX(rounded.x, grid, -1, {
          min: minX,
          max: Math.round(mainOuter.x - DETAIL_GAP - frame.right - rounded.width),
        })
      : side === 'right'
        ? snapX(rounded.x, grid, 1, {
            min: Math.round(rectRight(mainOuter) + DETAIL_GAP + frame.left),
            max: maxX,
          })
        : snapX(rounded.x, grid, 1, { min: minX, max: maxX });
  const minY = Math.round(wa.y + frame.top);
  const maxY = Math.max(minY, Math.round(rectBottom(wa) - frame.bottom - rounded.height));
  const contentY =
    anchor === 'bottom'
      ? snapY(rectBottom(rounded), grid, -1, {
          min: minY + rounded.height,
          max: maxY + rounded.height,
        }) - rounded.height
      : snapY(rounded.y, grid, 1, { min: minY, max: maxY });
  const content = { ...rounded, x: contentX, y: contentY };
  return { outer: outerFromContent(content, frame), content, side };
}
