/**
 * Where the OSD goes (PROMPT §10 «Aviso grande», like G-Helper's `ToastForm`): centred
 * horizontally on the display the user is on, its bottom edge 300 DIP above the work area's
 * bottom edge. The window is transparent and wide enough for the longest notice (80 characters
 * at 28 px); the renderer centres the pill inside it. Pure, whole DIP.
 */
import { OSD_LAYOUT } from '../../shared/platform';
import type { DisplayInfo, Point, Rect } from './geometry';
import { displayNearestPoint } from './geometry';

/** The OSD window's size: the pill (28 px text, 16 px padding) with room to be centred. */
export const OSD_WINDOW_SIZE = Object.freeze({ width: 960, height: 88 });
/** Never closer than this to the work area's sides. */
const SIDE_MARGIN = 16;

export function osdBounds(
  workArea: Rect,
  size: { width: number; height: number } = OSD_WINDOW_SIZE,
): Rect {
  const width = Math.max(1, Math.min(size.width, Math.round(workArea.width - 2 * SIDE_MARGIN)));
  const height = Math.max(1, Math.round(size.height));
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const bottom = workArea.y + workArea.height - OSD_LAYOUT.bottomOffset;
  // A very short work area: keep it inside, as low as it fits.
  const y = Math.round(
    Math.max(workArea.y, Math.min(bottom - height, workArea.y + workArea.height - height)),
  );
  return { x, y, width, height };
}

/** The OSD shows on the display under the pointer (where the user is looking). */
export function osdDisplay(displays: readonly DisplayInfo[], cursor: Point): DisplayInfo {
  return displayNearestPoint(displays, cursor);
}
