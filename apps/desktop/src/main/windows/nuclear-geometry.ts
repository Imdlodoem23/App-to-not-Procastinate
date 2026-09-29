/**
 * The Nuclear overlay covers every display completely (PROMPT §10 «Nuclear»: «pantalla completa
 * en cada monitor»), taskbar and menu bar included: one window per display at its full bounds.
 * Pure.
 */
import { displayNearestPoint, type DisplayInfo, type Point, type Rect } from './geometry';

export interface OverlayPlacement {
  displayId: number;
  bounds: Rect;
}

export function overlayPlacements(displays: readonly DisplayInfo[]): OverlayPlacement[] {
  return displays.map((d) => ({
    displayId: d.id,
    bounds: {
      x: Math.round(d.bounds.x),
      y: Math.round(d.bounds.y),
      width: Math.max(1, Math.round(d.bounds.width)),
      height: Math.max(1, Math.round(d.bounds.height)),
    },
  }));
}

/** The guardian accepts 1–16 displays in a heartbeat. */
export function heartbeatDisplays(count: number): number {
  return Math.min(16, Math.max(1, Math.round(count)));
}

/**
 * The display whose overlay takes the focus when Nuclear starts: the one under the pointer (or
 * nearest to it), so the keyboard starts where the user is looking. `null` without displays.
 */
export function overlayFocusDisplay(
  displays: readonly DisplayInfo[],
  cursor: Point,
): number | null {
  if (displays.length === 0) return null;
  return displayNearestPoint(displays, cursor).id;
}
