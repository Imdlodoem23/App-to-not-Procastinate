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
}

/**
 * Content rect of the main window at its corner: outer edges 10 DIP from the work area's
 * right edge and from the anchored edge.
 */
export function mainContentRect(input: MainPlacementInput): Rect {
  const { workArea: wa, frame, anchor } = input;
  const width = input.width ?? MAIN_CONTENT_WIDTH;
  const height = clampContentHeight(input.height, maxContentHeight(wa, frame));
  const outerWidth = width + frame.left + frame.right;
  const outerHeight = height + frame.top + frame.bottom;
  const outerX = rectRight(wa) - SCREEN_INSET - outerWidth;
  const outerY =
    anchor === 'bottom' ? rectBottom(wa) - SCREEN_INSET - outerHeight : wa.y + SCREEN_INSET;
  return roundRect({ x: outerX + frame.left, y: outerY + frame.top, width, height });
}

/**
 * New content rect when the height changes while the window is shown: the anchored edge of
 * `current` stays where it is (bottom: `y = bottom − height`; top: `y` unchanged), then the
 * window is kept inside the work area.
 */
export function resizeAnchored(
  current: Rect,
  height: number,
  anchor: WindowAnchor,
  workArea: Rect,
  frame: FrameInsets,
): Rect {
  const h = clampContentHeight(height, maxContentHeight(workArea, frame));
  let y = anchor === 'bottom' ? rectBottom(current) - h : current.y;
  const minY = workArea.y + frame.top;
  const maxY = rectBottom(workArea) - frame.bottom - h;
  y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  return roundRect({ x: current.x, y, width: current.width, height: h });
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
}

export interface DetailPlacement {
  outer: Rect;
  content: Rect;
  side: DetailSide;
}

/**
 * Detail window rect: outer height = the main window's outer height (at least 480 of content),
 * clamped to the work area; aligned on the main window's anchored edge; left of it with a
 * 6 DIP gap, else right of it, else pinned to the work area's left edge.
 */
export function detailPlacement(input: DetailPlacementInput): DetailPlacement {
  const { mainOuter, workArea: wa, anchor, frame } = input;
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
  const outer = roundRect({ x, y, width: outerWidth, height: outerHeight });
  return { outer, content: roundRect(contentFromOuter(outer, frame)), side };
}
