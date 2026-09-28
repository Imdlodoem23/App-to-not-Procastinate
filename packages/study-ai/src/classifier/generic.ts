/**
 * Rule-based scorer for an uncalibrated user, an unknown camera or a stale profile
 * (owner: LEARNING). DESIGN.md §6.9.
 *
 * Study directions (one per screen), learned for the whole session:
 *
 * - **Opening baseline**: medians of the first 20 s of calm face frames (eyes not looking
 *   down, head not pitched below −20°) without a distraction or a phone; failing 3 s of
 *   those, of the first 20 s of such frames with the eyes up; failing that, of the first
 *   20 s of face frames. Until 3 s of face frames exist, `ready` is false and `predict`
 *   gives a neutral, study-leaning answer. Writing in a notebook right after the click on
 *   «Empezar» is never taken for the screen, and a screen watched without touching the
 *   keyboard (a lecture) still becomes the baseline.
 * - **Input directions**: calm face frames with fresh keyboard/mouse input (idle < 2 s), no
 *   distraction and no phone. A pose seen like that for 3 s (gaps < 5 s) becomes a
 *   direction, whose centre is a rolling median of its last 80 samples, so it keeps
 *   following the user. Up to 3 directions in all: the least recently looked-at one makes
 *   room for a new one, and directions that drift within 12° of each other merge. A second
 *   monitor the user types or scrolls on is therefore a screen, not «looking away».
 *
 * Rules (face frames), against the direction that fits best: pStudy =
 * exp(−(max(0,|dyaw|−10)/30)⁴ − (max(0,dpitch−15)/15)⁴), so looking down (writing,
 * reading) is study; below −70° the pose is implausible and pStudy decays again. pStudy is
 * split between screen and paper by how far down the head is. A visible phone in hand takes
 * 0.9 of the mass; the rest of the non-study mass is `away`. No face but a person: study
 * share 0.2, so DECISION's last-pose rule decides.
 *
 * Eyes: until 20 blink values of fresh-input calm frames exist (failing those, of the
 * opening baseline's calm frames), the generic eye model. Then the profile's glare rule:
 * unreliable when their median is > 0.5 or their sd > 0.15 (glasses glare), and the fit's
 * intercept follows the median (0.15–0.5).
 */
import type {
  AttentionClassifier,
  ClassProbabilities,
  ClassifierObserveHint,
  EyeModel,
  FaceFeatures,
  FrameFeatures,
  RelativePose,
  ScreenBaseline,
} from '../types';
import { clamp, clamp01, iqr, median } from '../util/math';
import {
  DEFAULT_THRESHOLDS,
  EYES_UNRELIABLE_MEDIAN,
  EYES_UNRELIABLE_SD,
  GENERIC_BASELINE_MS,
  GENERIC_CALM_MAX_LOOK_DOWN,
  GENERIC_CALM_MIN_PITCH,
  GENERIC_CANDIDATE_GAP_MS,
  GENERIC_DIRECTION_CONFIRM_MS,
  GENERIC_DIRECTION_RADIUS,
  GENERIC_DIRECTION_SAMPLES,
  GENERIC_DOWN_LIMIT,
  GENERIC_DOWN_SCALE,
  GENERIC_EYE_MIN_SAMPLES,
  GENERIC_EYE_SAMPLES,
  GENERIC_EYES,
  GENERIC_EYES_UNKNOWN,
  GENERIC_FRESH_INPUT_MS,
  GENERIC_MAX_CANDIDATES,
  GENERIC_MAX_DIRECTIONS,
  GENERIC_MAX_SAMPLES,
  GENERIC_NEUTRAL_SCREEN,
  GENERIC_PAPER_FROM,
  GENERIC_PAPER_TO,
  GENERIC_PHONE_P,
  GENERIC_READY_MS,
  GENERIC_UP_FREE,
  GENERIC_UP_SCALE,
  GENERIC_YAW_FREE,
  GENERIC_YAW_SCALE,
  HIDDEN_STUDY_CAP,
  IQR_PER_SD,
  OBSERVE_MAX_DT_MS,
  PHONE_STILL_MS,
} from './constants';
import { relativeFromFace, wrapDeg } from './features';
import { frameHasSomeone, toProbabilities } from './personal';

export interface GenericClassifierOptions {
  /** Face time of each opening-baseline buffer (20 000). */
  baselineMs?: number;
}

/** A face sample: pose and box (the baseline fields) plus the blink value. */
interface PoseSample extends ScreenBaseline {
  blink: number;
}

/** First `baselineMs` of face time of one kind of frame (the opening baseline). */
interface BaselineBuffer {
  ms: number;
  samples: PoseSample[];
}

/** A study direction learned from fresh input (or the opening baseline). */
interface Direction {
  /** Ring of the latest samples; the centre is their median. */
  samples: PoseSample[];
  next: number;
  /** Fresh-input face time fed to it (candidates need `GENERIC_DIRECTION_CONFIRM_MS`). */
  ms: number;
  /** Last time a sample fed it, and last time a face frame looked its way (for eviction). */
  lastFed: number;
  lastSeen: number;
  center: ScreenBaseline | null;
}

/** Exponent of the generic rule: pStudy = exp(−cost). */
function genericCost(dyaw: number, dpitch: number): number {
  const yawTerm = Math.max(0, Math.abs(dyaw) - GENERIC_YAW_FREE) / GENERIC_YAW_SCALE;
  const upTerm = Math.max(0, dpitch - GENERIC_UP_FREE) / GENERIC_UP_SCALE;
  const downTerm = Math.max(0, GENERIC_DOWN_LIMIT - dpitch) / GENERIC_DOWN_SCALE;
  return yawTerm ** 4 + upTerm ** 4 + downTerm ** 4;
}

/** Study probability of a relative pose under the generic rules. */
export function genericStudyProbability(dyaw: number, dpitch: number): number {
  const p = Math.exp(-genericCost(dyaw, dpitch));
  return Number.isFinite(p) ? clamp01(p) : 0;
}

/** Share of pStudy that is `paper`: 0 at dpitch ≥ −6°, 1 at ≤ −18°. */
export function genericPaperShare(dpitch: number): number {
  return clamp01((GENERIC_PAPER_FROM - dpitch) / (GENERIC_PAPER_FROM - GENERIC_PAPER_TO));
}

/** Phone in hand on this frame: over the threshold, near the face or moving, not lying still. */
export function phoneInHand(frame: FrameFeatures, threshold: number): boolean {
  const phone = frame.objects?.phone;
  if (!phone || !(phone.score >= threshold)) return false;
  return (phone.nearFace || phone.moving) && phone.stillMs < PHONE_STILL_MS;
}

/** Eyes not looking down and head not pitched down: the user faces a screen. */
export function isCalmFace(face: FaceFeatures): boolean {
  return face.lookDown < GENERIC_CALM_MAX_LOOK_DOWN && face.pose.pitch > GENERIC_CALM_MIN_PITCH;
}

/**
 * Fresh keyboard/mouse input on this tick: idle < 2 s. Callers that do not pass `idleMs`
 * fall back to `inputActive`; a `null` (unknown) idle time is not fresh.
 */
export function isFreshInput(hint: ClassifierObserveHint): boolean {
  const idle = hint.idleMs;
  if (idle === undefined) return hint.inputActive;
  return typeof idle === 'number' && Number.isFinite(idle) && idle >= 0
    ? idle < GENERIC_FRESH_INPUT_MS
    : false;
}

function baselineOf(samples: readonly ScreenBaseline[]): ScreenBaseline {
  const m = (key: keyof ScreenBaseline): number =>
    median(Float64Array.from(samples, (s) => s[key]));
  return {
    yaw: m('yaw'),
    pitch: m('pitch'),
    roll: m('roll'),
    cx: m('cx'),
    cy: m('cy'),
    w: Math.max(m('w'), 1e-3),
    h: Math.max(m('h'), 1e-3),
  };
}

function sampleOf(face: FaceFeatures): PoseSample | null {
  const s = {
    yaw: face.pose.yaw,
    pitch: face.pose.pitch,
    roll: face.pose.roll,
    cx: face.box.cx,
    cy: face.box.cy,
    w: face.box.w,
    h: face.box.h,
    blink: face.blink,
  };
  return Object.values(s).every(Number.isFinite) ? s : null;
}

/** Angular distance (yaw/pitch, degrees) between a pose and a direction's centre. */
function angularDistance(yaw: number, pitch: number, center: ScreenBaseline): number {
  return Math.hypot(wrapDeg(yaw - center.yaw), pitch - center.pitch);
}

/**
 * The profile's glare rule applied to a session's calm blink values: unreliable when their
 * median is > 0.5 or their spread is > 0.15. The spread is the robust sd (IQR / 1.349), so a
 * few real blinks, or eyes closed just after the last keystroke, do not switch the eyes off.
 * Fewer than 20 values: not judged yet, so unreliable (no drowsiness from unknown eyes).
 */
export function genericEyesFrom(blinks: ArrayLike<number>): Readonly<EyeModel> {
  if (blinks.length < GENERIC_EYE_MIN_SAMPLES) return GENERIC_EYES_UNKNOWN;
  const med = median(blinks);
  const spread = iqr(blinks) / IQR_PER_SD;
  const reliable = spread <= EYES_UNRELIABLE_SD && med <= EYES_UNRELIABLE_MEDIAN;
  const a = clamp(med, GENERIC_EYES.blinkFit[0], EYES_UNRELIABLE_MEDIAN);
  return Object.freeze({
    reliable,
    blinkFit: Object.freeze([a, GENERIC_EYES.blinkFit[1]] as const),
    closedDelta: GENERIC_EYES.closedDelta,
  });
}

export function createGenericClassifier(
  options: GenericClassifierOptions = {},
): AttentionClassifier {
  const baselineMs = Math.max(GENERIC_READY_MS, options.baselineMs ?? GENERIC_BASELINE_MS);
  const thresholds = Object.freeze({ ...DEFAULT_THRESHOLDS });
  const trust = Object.freeze({ phone: 0, away: 0 });

  // Opening baseline, by preference: calm frames, eyes-up frames, any face frames.
  const calm: BaselineBuffer = { ms: 0, samples: [] };
  const eyesUp: BaselineBuffer = { ms: 0, samples: [] };
  const any: BaselineBuffer = { ms: 0, samples: [] };
  let opening: ScreenBaseline | null = null;
  let openingDirty = false;
  /** `lastSeen` of the opening baseline; it can be evicted like any other direction. */
  let openingSeen = -Infinity;
  let openingDropped = false;

  const directions: Direction[] = [];
  const candidates: Direction[] = [];

  // Online eye model.
  const blinks = new Float64Array(GENERIC_EYE_SAMPLES);
  let blinkCount = 0;
  let blinkNext = 0;
  let eyes: Readonly<EyeModel> = GENERIC_EYES_UNKNOWN;
  let eyesDirty = false;

  let lastT: number | null = null;

  const openingBaseline = (): ScreenBaseline | null => {
    if (openingDirty) {
      openingDirty = false;
      const buffer = [calm, eyesUp, any].find((b) => b.ms >= GENERIC_READY_MS);
      opening = buffer ? baselineOf(buffer.samples) : null;
    }
    return opening;
  };

  const centerOf = (dir: Direction): ScreenBaseline => {
    if (!dir.center) dir.center = baselineOf(dir.samples);
    return dir.center;
  };

  /** Confirmed input directions plus the opening baseline when no direction covers it. */
  const references = (): ScreenBaseline[] => {
    const out = directions.map(centerOf);
    const base = openingDropped ? null : openingBaseline();
    if (
      base &&
      !out.some((c) => angularDistance(base.yaw, base.pitch, c) <= GENERIC_DIRECTION_RADIUS)
    ) {
      out.push(base);
    }
    return out;
  };

  /** Pose relative to the direction that fits best: lowest rule cost, then the nearest. */
  const relativePose = (face: FaceFeatures): RelativePose | null => {
    let best: RelativePose | null = null;
    let bestCost = Infinity;
    let bestDist = Infinity;
    for (const ref of references()) {
      const rel = relativeFromFace(face, ref);
      const cost = genericCost(rel.dyaw, rel.dpitch);
      const dist = Math.hypot(rel.dyaw, rel.dpitch);
      const c = Number.isFinite(cost) ? cost : Number.MAX_VALUE;
      const d = Number.isFinite(dist) ? dist : Number.MAX_VALUE;
      if (best === null || c < bestCost || (c === bestCost && d < bestDist)) {
        best = rel;
        bestCost = c;
        bestDist = d;
      }
    }
    return best;
  };

  const predict = (frame: FrameFeatures): ClassProbabilities | null => {
    if (!frameHasSomeone(frame, thresholds.person)) return null;
    const pPhone = phoneInHand(frame, thresholds.phone) ? GENERIC_PHONE_P : 0;
    const rest = 1 - pPhone;
    const face = frame.face;
    let pStudy: number;
    let paper: number;
    const rel = face ? relativePose(face) : null;
    if (face && !rel) {
      // Not ready yet: neutral and study-leaning.
      const other = (1 - GENERIC_NEUTRAL_SCREEN) / 2;
      return toProbabilities([
        GENERIC_NEUTRAL_SCREEN * rest,
        other * rest,
        pPhone,
        other * rest,
        0,
      ]);
    }
    if (rel) {
      pStudy = genericStudyProbability(rel.dyaw, rel.dpitch);
      paper = genericPaperShare(rel.dpitch);
    } else {
      // No face but a person: leave it to the observer's last-pose rule.
      pStudy = HIDDEN_STUDY_CAP;
      paper = 1;
    }
    return toProbabilities([
      pStudy * (1 - paper) * rest,
      pStudy * paper * rest,
      pPhone,
      (1 - pStudy) * rest,
      0,
    ]);
  };

  const pushOpening = (buffer: BaselineBuffer, sample: PoseSample, dt: number): void => {
    if (buffer.ms >= baselineMs) return;
    buffer.ms += dt;
    if (buffer.samples.length < GENERIC_MAX_SAMPLES) buffer.samples.push(sample);
    openingDirty = true;
    if (buffer === calm) eyesDirty = true;
  };

  const feed = (dir: Direction, sample: PoseSample, dt: number, t: number): void => {
    if (dir.samples.length < GENERIC_DIRECTION_SAMPLES) dir.samples.push(sample);
    else dir.samples[dir.next] = sample;
    dir.next = (dir.next + 1) % GENERIC_DIRECTION_SAMPLES;
    dir.ms += dt;
    dir.lastFed = t;
    dir.lastSeen = t;
    dir.center = null;
  };

  /** True while the opening baseline is a direction of its own (no direction covers it). */
  const openingCounts = (): boolean => {
    const base = openingDropped ? null : openingBaseline();
    return (
      base !== null &&
      !directions.some(
        (d) => angularDistance(base.yaw, base.pitch, centerOf(d)) <= GENERIC_DIRECTION_RADIUS,
      )
    );
  };

  /** Makes room for a new direction: drops the least recently looked-at one. */
  const evictOne = (keep: Direction): void => {
    let victim: Direction | null = null;
    for (const d of directions) {
      if (d !== keep && (victim === null || d.lastSeen < victim.lastSeen)) victim = d;
    }
    if (openingCounts() && (victim === null || openingSeen < victim.lastSeen)) {
      openingDropped = true;
      return;
    }
    if (victim) directions.splice(directions.indexOf(victim), 1);
  };

  /** Merges confirmed directions whose centres drifted within the radius of `dir`. */
  const mergeInto = (dir: Direction): void => {
    for (let i = directions.length - 1; i >= 0; i -= 1) {
      const other = directions[i] as Direction;
      if (other === dir) continue;
      const a = centerOf(dir);
      if (angularDistance(a.yaw, a.pitch, centerOf(other)) > GENERIC_DIRECTION_RADIUS) continue;
      // Keep the newest samples of both, the most recent last.
      const merged = [...other.samples, ...dir.samples].slice(-GENERIC_DIRECTION_SAMPLES);
      dir.samples = merged;
      dir.next = merged.length % GENERIC_DIRECTION_SAMPLES;
      dir.ms += other.ms;
      dir.lastSeen = Math.max(dir.lastSeen, other.lastSeen);
      dir.center = null;
      directions.splice(i, 1);
    }
  };

  const learnDirection = (sample: PoseSample, dt: number, t: number): void => {
    // Nearest confirmed direction first, then the nearest candidate.
    let target: Direction | null = null;
    let best = GENERIC_DIRECTION_RADIUS;
    for (const d of directions) {
      const dist = angularDistance(sample.yaw, sample.pitch, centerOf(d));
      if (dist <= best) {
        best = dist;
        target = d;
      }
    }
    if (target) {
      feed(target, sample, dt, t);
      mergeInto(target);
      return;
    }
    best = GENERIC_DIRECTION_RADIUS;
    for (const d of candidates) {
      const dist = angularDistance(sample.yaw, sample.pitch, centerOf(d));
      if (dist <= best) {
        best = dist;
        target = d;
      }
    }
    if (target && t - target.lastFed > GENERIC_CANDIDATE_GAP_MS) {
      // Too long since it was last seen with fresh input: start over.
      target.samples = [];
      target.next = 0;
      target.ms = 0;
    }
    if (!target) {
      if (candidates.length >= GENERIC_MAX_CANDIDATES) {
        let oldest = 0;
        candidates.forEach((d, i) => {
          if (d.lastFed < (candidates[oldest] as Direction).lastFed) oldest = i;
        });
        candidates.splice(oldest, 1);
      }
      target = {
        samples: [],
        next: 0,
        ms: 0,
        lastFed: t,
        lastSeen: t,
        center: null,
      };
      candidates.push(target);
    }
    feed(target, sample, dt, t);
    if (target.ms < GENERIC_DIRECTION_CONFIRM_MS) return;
    candidates.splice(candidates.indexOf(target), 1);
    directions.push(target);
    mergeInto(target);
    while (directions.length + (openingCounts() ? 1 : 0) > GENERIC_MAX_DIRECTIONS) {
      evictOne(target);
    }
  };

  /** Marks every direction the face looks at (within the radius) as recently seen. */
  const markSeen = (face: FaceFeatures, t: number): void => {
    const { yaw, pitch } = face.pose;
    for (const d of directions) {
      if (angularDistance(yaw, pitch, centerOf(d)) <= GENERIC_DIRECTION_RADIUS) d.lastSeen = t;
    }
    const base = openingDropped ? null : openingBaseline();
    if (base && angularDistance(yaw, pitch, base) <= GENERIC_DIRECTION_RADIUS) openingSeen = t;
  };

  const pushBlink = (blink: number): void => {
    blinks[blinkNext] = blink;
    blinkNext = (blinkNext + 1) % GENERIC_EYE_SAMPLES;
    blinkCount = Math.min(blinkCount + 1, GENERIC_EYE_SAMPLES);
    eyesDirty = true;
  };

  const eyeModel = (): Readonly<EyeModel> => {
    if (eyesDirty) {
      eyesDirty = false;
      eyes =
        blinkCount >= GENERIC_EYE_MIN_SAMPLES
          ? genericEyesFrom(blinks.subarray(0, blinkCount))
          : genericEyesFrom(Float64Array.from(calm.samples, (s) => s.blink));
    }
    return eyes;
  };

  const observe = (frame: FrameFeatures, hint: ClassifierObserveHint): void => {
    const t = frame.t;
    const dt = lastT === null || !Number.isFinite(t) ? 0 : clamp(t - lastT, 0, OBSERVE_MAX_DT_MS);
    if (Number.isFinite(t)) lastT = t;
    const face = frame.face;
    if (!face) return;
    const sample = sampleOf(face);
    if (!sample) return;
    const now = Number.isFinite(t) ? t : (lastT ?? 0);
    markSeen(face, now);
    const phone = hint.phone || phoneInHand(frame, thresholds.phone);
    const clean = !hint.distraction && !phone;
    const calmFace = isCalmFace(face);
    // The opening baseline. The very first face frame still counts (dt 0).
    if (!phone) pushOpening(any, sample, dt);
    if (clean && face.lookDown < GENERIC_CALM_MAX_LOOK_DOWN) pushOpening(eyesUp, sample, dt);
    if (clean && calmFace) pushOpening(calm, sample, dt);
    // Directions and eyes: calm frames with fresh input (the user is awake, at a screen).
    if (clean && calmFace && isFreshInput(hint)) {
      learnDirection(sample, dt, now);
      pushBlink(sample.blink);
    }
  };

  return {
    kind: 'generic',
    get ready(): boolean {
      return directions.length > 0 || openingBaseline() !== null;
    },
    thresholds,
    trust,
    get eyes(): Readonly<EyeModel> {
      return eyeModel();
    },
    predict,
    relativePose,
    observe,
  };
}
