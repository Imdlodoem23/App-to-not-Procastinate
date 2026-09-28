/**
 * Synthetic frames made when the loop asks for them (RUNTIME acceptance fixture). The face,
 * luma and context follow a `synthesize` script, but the object detector runs only on the
 * frames the session asks it to (`VisionFrameOptions.objects`), through PERCEPTION's real
 * `PhoneTracker`. So the detector rate is the one the governor plans, as in the real app:
 * a slow laptop at L4 sees the phone every 4 s, not every second as `synthesize` assumes.
 */
import { PhoneTracker } from '../../src/perception/objects';
import type {
  AnalysisFrame,
  Box,
  FrameFeatures,
  ObjectDetection,
  ObjectFeatures,
  VisionFrameOptions,
} from '../../src/types';
import { clamp, clamp01 } from '../../src/util/math';
import { gaussian, mulberry32, type Rng } from '../../src/util/rng';
import { plainFeatures, shiftFrame } from '../runtime/fakes';
import { FRAME_HEIGHT, FRAME_WIDTH, synthesize, type Persona, type SynthTick } from '../synth';
import type { Script } from '../synth';

/** Detector values are held this long between runs (as PERCEPTION's `ObjectHold`). */
const HOLD_MS = 4_000;
/** The face box stays usable for `nearFace` this long after the face was last seen. */
const FACE_MEMORY_MS = 10_000;

/** A phone held in front of the chest, as the synth's `phoneInHand` places it. */
function handPhone(rng: Rng, face: Box): Box {
  const box = {
    cx: clamp01(face.cx + gaussian(rng, 0, 0.05)),
    cy: clamp01(face.cy + face.h * 0.9),
    w: 0.12,
    h: 0.18,
  };
  // One pixel of detector jitter on each edge.
  const edge = (v: number, size: number): number =>
    clamp(v * size + gaussian(rng, 0, 1), 0, size) / size;
  const x0 = edge(box.cx - box.w / 2, FRAME_WIDTH);
  const x1 = edge(box.cx + box.w / 2, FRAME_WIDTH);
  const y0 = edge(box.cy - box.h / 2, FRAME_HEIGHT);
  const y1 = edge(box.cy + box.h / 2, FRAME_HEIGHT);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

export class LiveFrames {
  private readonly ticks: SynthTick[];
  private readonly rng: Rng;
  private readonly tracker = new PhoneTracker();
  private held: ObjectFeatures | null = null;
  private faceBox: Box | null = null;
  private faceAt = Number.NEGATIVE_INFINITY;

  constructor(
    script: Script,
    persona: Persona,
    seed: number,
    private readonly t0: number,
  ) {
    // Face, luma and context only: the detector values of the script are not used.
    this.ticks = synthesize(script, { persona, seed, fps: 4 });
    this.rng = mulberry32((seed * 7_919) >>> 0);
  }

  get durationMs(): number {
    return this.ticks[this.ticks.length - 1]?.now ?? 0;
  }

  /** The script tick current at session-relative time `rel`. */
  at(rel: number): SynthTick {
    let lo = 0;
    let hi = this.ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.ticks[mid] as SynthTick).now <= rel) lo = mid;
      else hi = mid - 1;
    }
    return this.ticks[lo] as SynthTick;
  }

  /** The features of `frame`; the detector runs only when `options.objects`. */
  features(frame: AnalysisFrame, options: VisionFrameOptions): FrameFeatures {
    const t = frame.t;
    const tick = this.at(t - this.t0);
    const base: FrameFeatures = tick.frame
      ? shiftFrame(tick.frame, t)
      : { ...plainFeatures(t), face: null };
    if (base.face) {
      this.faceBox = base.face.box;
      this.faceAt = t;
    }
    const faceBox = t - this.faceAt <= FACE_MEMORY_MS ? this.faceBox : null;
    if (options.objects) {
      const seen: ObjectDetection[] = [];
      if (tick.activity === 'phoneInHand' && faceBox && this.rng() < 0.7) {
        seen.push({ score: 0.5 + 0.4 * this.rng(), box: handPhone(this.rng, faceBox) });
      }
      const phone = this.tracker.update(seen, t, faceBox, FRAME_WIDTH, FRAME_HEIGHT);
      const present = tick.activity !== 'absent' && tick.activity !== 'covered';
      const person =
        present && faceBox
          ? {
              score: clamp01(0.9 + gaussian(this.rng, 0, 0.03)),
              box: { cx: faceBox.cx, cy: clamp01(faceBox.cy + 0.2), w: 0.6, h: 0.8 },
            }
          : null;
      this.held = { ranAt: t, ageMs: 0, fresh: true, phone, book: null, person };
      return { ...base, objects: this.held };
    }
    const held = this.held;
    const objects =
      held && t - held.ranAt <= HOLD_MS ? { ...held, ageMs: t - held.ranAt, fresh: false } : null;
    return { ...base, objects };
  }
}
