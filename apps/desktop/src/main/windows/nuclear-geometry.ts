/**
 * The Nuclear overlay covers every display completely (PROMPT §10 «Nuclear»: «pantalla completa
 * en cada monitor»), taskbar and menu bar included: one window per display at its full bounds.
 * Pure.
 */
import type { DisplayInfo, Rect } from './geometry';

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
