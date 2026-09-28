/**
 * One camera frame through the vision pipeline (owner: RUNTIME), shared by the study session
 * and the calibration session. Pure and DOM-free: the frame source and the pipeline are the
 * structural interfaces of `types.ts`.
 *
 * The frame is closed exactly once, in `finally`, whatever happens: nothing keeps a
 * reference to it and only the numeric `FrameFeatures` come out.
 */
import type {
  AnalysisFrame,
  FrameSource,
  LoopPlan,
  MonoMs,
  StepCost,
  VisionFrameOptions,
  VisionPipeline,
  VisionResult,
} from '../types';

export type FrameOutcome =
  | { kind: 'none' }
  | { kind: 'ok'; result: VisionResult; options: VisionFrameOptions }
  | { kind: 'failed'; error: unknown };

function closeOnce(frame: AnalysisFrame): void {
  try {
    frame.close();
  } catch {
    // A frame that fails to close is released by the browser; nothing else holds it.
  }
}

/**
 * Grabs the newest frame and analyses it. `usable()` is checked after the (async) grab: when
 * the session stopped or swapped its camera meanwhile, the frame is closed unanalysed.
 */
export async function analyseNextFrame(
  source: FrameSource,
  vision: VisionPipeline,
  options: () => VisionFrameOptions,
  usable: () => boolean,
): Promise<FrameOutcome> {
  const frame = await source.next();
  if (frame === null) return { kind: 'none' };
  try {
    if (!usable()) return { kind: 'none' };
    const opts = options();
    return { kind: 'ok', result: vision.process(frame, opts), options: opts };
  } catch (error) {
    return { kind: 'failed', error };
  } finally {
    closeOnce(frame);
  }
}

/**
 * Takes the newest frame and closes it unanalysed (the pipeline is being rebuilt): the camera
 * keeps delivering, so a healthy one never reads as stalled meanwhile.
 */
export async function discardNextFrame(source: FrameSource): Promise<void> {
  const frame = await source.next();
  if (frame !== null) closeOnce(frame);
}

/** Luma is due a little early so timer jitter never halves its rate (333 × 3 = 999 ms). */
const LUMA_SLACK_MS = 50;

/** Decides which frames run the object detector and sample luma. */
export class FrameCadence {
  private framesSinceObjects = Number.POSITIVE_INFINITY;
  private lastLumaAt: MonoMs = Number.NEGATIVE_INFINITY;

  options(now: MonoMs, plan: Pick<LoopPlan, 'objectEvery' | 'lumaEveryMs'>): VisionFrameOptions {
    return {
      objects: this.framesSinceObjects + 1 >= Math.max(1, plan.objectEvery),
      luma: now - this.lastLumaAt >= plan.lumaEveryMs - LUMA_SLACK_MS,
    };
  }

  /** Records a processed frame. */
  done(now: MonoMs, options: VisionFrameOptions): void {
    this.framesSinceObjects = options.objects ? 0 : this.framesSinceObjects + 1;
    if (options.luma) this.lastLumaAt = now;
  }

  /** After a camera restart or a gap: the next frame runs everything. */
  reset(): void {
    this.framesSinceObjects = Number.POSITIVE_INFINITY;
    this.lastLumaAt = Number.NEGATIVE_INFINITY;
  }
}

/** The governor's view of one processed frame. */
export function stepCost(
  at: MonoMs,
  result: VisionResult,
  options: VisionFrameOptions,
  otherMs: number,
): StepCost {
  const { cost } = result;
  const objectMs = options.objects && Number.isFinite(cost.objectMs) ? cost.objectMs : 0;
  const total = Number.isFinite(cost.totalMs) ? cost.totalMs : 0;
  return {
    at,
    visionMs: Math.max(0, total - objectMs),
    objectMs: Math.max(0, objectMs),
    otherMs: Math.max(0, Number.isFinite(otherMs) ? otherMs : 0),
    ranObjects: options.objects,
    faceSeen: result.features.face !== null,
  };
}
