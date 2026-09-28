/**
 * [browser] The two small canvases of the vision pipeline (DESIGN.md §5.5). Both are
 * OffscreenCanvas (no DOM, fine in a hidden window) and never exported anywhere:
 * - a 32×24 luma canvas: the frame is drawn, read back, turned into grey values in a reused
 *   buffer and cleared;
 * - a reused frame-size canvas that brightens detector inputs in low light, cleared after
 *   inference.
 */
import type { GrayThumbnail } from '../../types';
import { LOW_LIGHT_CONTRAST, LUMA_THUMB_HEIGHT, LUMA_THUMB_WIDTH } from '../constants';

export interface FrameCanvas {
  /** Grey 32×24 thumbnail of `source` (a reused buffer, valid until the next call). */
  luma(source: CanvasImageSource): GrayThumbnail | null;
  /** `source` drawn with `brightness(gain) contrast(1.1)`, or `null` when unavailable. */
  boost(
    source: CanvasImageSource,
    width: number,
    height: number,
    gain: number,
  ): TexImageSource | null;
  /** Wipes the boosted pixels once inference is done. */
  clearBoost(): void;
  release(): void;
}

type Ctx2d = OffscreenCanvasRenderingContext2D;

/** `null` when OffscreenCanvas is not available (then luma and the boost are skipped). */
export function createFrameCanvas(): FrameCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null;

  const lumaCanvas = new OffscreenCanvas(LUMA_THUMB_WIDTH, LUMA_THUMB_HEIGHT);
  const lumaCtx = lumaCanvas.getContext('2d', {
    willReadFrequently: true,
    alpha: false,
  }) as Ctx2d | null;
  const gray = new Uint8Array(LUMA_THUMB_WIDTH * LUMA_THUMB_HEIGHT);
  const thumbnail: GrayThumbnail = {
    width: LUMA_THUMB_WIDTH,
    height: LUMA_THUMB_HEIGHT,
    data: gray,
  };

  let boostCanvas: OffscreenCanvas | null = null;
  let boostCtx: Ctx2d | null = null;

  return {
    luma(source) {
      if (lumaCtx === null) return null;
      lumaCtx.imageSmoothingEnabled = true;
      // High quality averages many pixels per value, so sensor noise barely shows in the diffs.
      lumaCtx.imageSmoothingQuality = 'high';
      lumaCtx.drawImage(source, 0, 0, LUMA_THUMB_WIDTH, LUMA_THUMB_HEIGHT);
      const rgba = lumaCtx.getImageData(0, 0, LUMA_THUMB_WIDTH, LUMA_THUMB_HEIGHT).data;
      for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
        // Rec. 601 luma in integer maths: (77 R + 150 G + 29 B) / 256.
        gray[i] =
          ((rgba[p] as number) * 77 +
            (rgba[p + 1] as number) * 150 +
            (rgba[p + 2] as number) * 29) >>
          8;
      }
      lumaCtx.clearRect(0, 0, LUMA_THUMB_WIDTH, LUMA_THUMB_HEIGHT);
      return thumbnail;
    },

    boost(source, width, height, gain) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (boostCanvas === null || boostCanvas.width !== w || boostCanvas.height !== h) {
        boostCanvas = new OffscreenCanvas(w, h);
        boostCtx = boostCanvas.getContext('2d', { alpha: false }) as Ctx2d | null;
      }
      if (boostCtx === null) return null;
      boostCtx.filter = `brightness(${gain.toFixed(2)}) contrast(${LOW_LIGHT_CONTRAST})`;
      boostCtx.drawImage(source, 0, 0, w, h);
      boostCtx.filter = 'none';
      return boostCanvas;
    },

    clearBoost() {
      if (boostCanvas !== null && boostCtx !== null) {
        boostCtx.clearRect(0, 0, boostCanvas.width, boostCanvas.height);
      }
    },

    release() {
      gray.fill(0);
      boostCanvas = null;
      boostCtx = null;
      lumaCanvas.width = 1;
      lumaCanvas.height = 1;
    },
  };
}
