/** Normalised box helpers shared by the face, object and luma parts (pure). */
import type { Box } from '../types';
import { clamp01 } from '../util/math';

export function boxArea(box: Box): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

/** Intersection over union of two centre/size boxes; 0 when either is empty. */
export function boxIou(a: Box, b: Box): number {
  const ix = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
  const iy = Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2);
  if (!(ix > 0) || !(iy > 0)) return 0;
  const inter = ix * iy;
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return Math.abs(a.cx - b.cx) * 2 < a.w + b.w && Math.abs(a.cy - b.cy) * 2 < a.h + b.h;
}

/** The same centre, `factor` times the size. */
export function scaleBox(box: Box, factor: number): Box {
  return { cx: box.cx, cy: box.cy, w: box.w * factor, h: box.h * factor };
}

/**
 * Pixel box (the Object Detector's `originX/originY/width/height`) → normalised centre/size,
 * clipped to the frame. `null` when a value is not finite or the clipped box is empty.
 */
export function boxFromPixels(
  originX: number,
  originY: number,
  width: number,
  height: number,
  frameWidth: number,
  frameHeight: number,
): Box | null {
  if (![originX, originY, width, height].every(Number.isFinite)) return null;
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
  const x0 = clamp01(originX / frameWidth);
  const x1 = clamp01((originX + width) / frameWidth);
  const y0 = clamp01(originY / frameHeight);
  const y1 = clamp01((originY + height) / frameHeight);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0) || !(h > 0)) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w, h };
}
