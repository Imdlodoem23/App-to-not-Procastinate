/**
 * Camera ticks → observations (owner: DECISION): presence, evidence persistence, fusion of
 * the classifier with the rules, drowsiness candidates and the stale-profile check.
 * DESIGN.md §7.1–7.4.
 *
 * Deterministic: time only comes from `TickInput.now`. Nothing here keeps an image; the
 * observation carries the frame's numbers for the 90 s «¡Estaba estudiando!» ring only.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import type {
  AttentionClassifier,
  ClassProbabilities,
  FaceFeatures,
  FrameFeatures,
  HeadPose,
  HintCode,
  MonoMs,
  Observation,
  ObservationEvidence,
  Observer,
  Presence,
  RelativePose,
  StudyAiSettings,
  StudyMode,
  TickInput,
} from '../types';
import { clamp } from '../util/math';
import {
  CANT_SEE_HIDDEN_MS,
  CANT_SEE_TRUNCATED,
  EYES_MAX_LOOK_DOWN,
  EYES_MIN_QUALITY,
  FACE_RECENT_MS,
  HIDDEN_LOOKBACK_MS,
  HIDDEN_TURNED_YAW,
  LOOK_DOWN_ABS_PITCH,
  LOOK_DOWN_BLEND,
  LOOK_DOWN_DPITCH,
  LOOK_DOWN_MAX_YAW,
  MOTION_NEAR_FACE,
  OBSERVE_MAX_STEP_MS,
  STALE_AWAY_SHARE,
  STALE_MIN_FRAMES,
  STALE_WINDOW_MS,
  YAWN_JAW,
} from './constants';
import { DetectorEvidence } from './evidence';
import { fuse, hiddenValue, type HiddenPose } from './fusion';

export interface CameraObserverOptions {
  classifier: AttentionClassifier;
  /** Used when the profile looks stale (generic classifier); `null` disables the check. */
  fallback: AttentionClassifier | null;
}

interface LastVisible {
  at: MonoMs;
  rel: RelativePose | null;
  pose: HeadPose;
  lookingDown: boolean;
}

interface HiddenStretch {
  since: MonoMs;
  pose: HiddenPose;
}

/** Rule-side inputs of a hidden observation, kept for `rescore` (never serialised). */
interface HiddenMemo {
  value: number;
  turned: boolean;
}

const NO_EYES = Object.freeze({ closed: false, yawn: false });

/** True when the frame has a usable relative pose for the looking-down test. */
function isLookingDown(face: FaceFeatures, rel: RelativePose | null): boolean {
  const eyesDown = face.lookDown >= LOOK_DOWN_BLEND;
  if (rel) {
    return (rel.dpitch <= LOOK_DOWN_DPITCH || eyesDown) && Math.abs(rel.dyaw) <= LOOK_DOWN_MAX_YAW;
  }
  return (
    (face.pose.pitch <= LOOK_DOWN_ABS_PITCH || eyesDown) &&
    Math.abs(face.pose.yaw) <= LOOK_DOWN_MAX_YAW
  );
}

function argmax(p: ClassProbabilities): keyof ClassProbabilities {
  let best: keyof ClassProbabilities = 'screen';
  for (const key of ['paper', 'phone', 'away', 'absent'] as const) {
    if (p[key] > p[best]) best = key;
  }
  return best;
}

export class CameraObserver implements Observer {
  readonly mode: StudyMode = 'camera';

  private current: AttentionClassifier;
  private readonly fallback: AttentionClassifier | null;
  private readonly evidence = new DetectorEvidence();
  private readonly hiddenMemo = new WeakMap<Observation, HiddenMemo>();

  private lastT: MonoMs | null = null;
  private presence: Presence = 'camera_lost';
  private distractionSince: MonoMs | null = null;
  private lastFaceAt: MonoMs | null = null;
  private lastVisible: LastVisible | null = null;
  private hidden: HiddenStretch | null = null;
  private yawnSince: MonoMs | null = null;

  // Stale-profile check (sticky: survives reset())
  private staleObservedMs = 0;
  private staleFrames = 0;
  private staleAway = 0;
  private staleDone: boolean;
  private stale = false;

  constructor(options: CameraObserverOptions) {
    this.current = options.classifier;
    this.fallback = options.fallback;
    this.staleDone = options.fallback === null || options.classifier.kind !== 'personal';
  }

  get classifier(): AttentionClassifier {
    return this.current;
  }

  /** True once the stale-profile check switched to the fallback (sticky `recalibrate`). */
  get staleProfile(): boolean {
    return this.stale;
  }

  /** Swaps the classifier (feedback retrain, recalibration); keeps evidence state. */
  setClassifier(classifier: AttentionClassifier): void {
    this.current = classifier;
  }

  observe(input: TickInput, settings: Readonly<StudyAiSettings>): Observation {
    const c = STUDY_AI_CONSTANTS;
    const now = input.now;
    const dt =
      this.lastT === null || !Number.isFinite(now)
        ? 0
        : clamp(now - this.lastT, 0, OBSERVE_MAX_STEP_MS);
    if (Number.isFinite(now)) this.lastT = now;
    const work = input.phase === 'work';
    const threshold = settings.focusScoreThreshold;
    const classifier = this.current;
    const thresholds = classifier.thresholds;

    // Context evidence
    if (input.context.foreground === 'distraction') {
      if (this.distractionSince === null || now < this.distractionSince)
        this.distractionSince = now;
    } else {
      this.distractionSince = null;
    }
    const distractionApp =
      this.distractionSince !== null && now - this.distractionSince >= c.distractionConfirmMs;
    const idle = input.context.idleMs;
    const inputActive =
      typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 && idle < c.inputActiveMs;

    // Detector evidence. The pose comes first: a phone only counts as in use when it moves,
    // the user looks down at it or holds it at the face, or the face is out of view.
    const cameraOk = input.camera === 'ok';
    const frame = cameraOk ? input.frame : null;
    const seenFace = frame && !frame.luma?.covered ? frame.face : null;
    const rel = seenFace ? classifier.relativePose(seenFace) : null;
    const lookingDown = seenFace ? isLookingDown(seenFace, rel) : false;
    this.evidence.record(frame, thresholds, lookingDown);
    this.evidence.update(now);

    // Presence
    let presence: Presence;
    if (!cameraOk) presence = 'camera_lost';
    else if (!frame) presence = this.presence;
    else if (frame.luma?.covered) presence = 'covered';
    else if (frame.face) presence = 'visible';
    else if (this.someoneWithoutFace(frame, now, thresholds.person)) presence = 'hidden';
    else presence = 'absent';
    this.presence = presence;

    // `visible` means a frame with a face that is not covered: exactly `seenFace`.
    const face = presence === 'visible' ? seenFace : null;
    const phone = this.evidence.phone;
    const evidence: ObservationEvidence = {
      phone,
      book: this.evidence.book(now),
      lookingDown,
      distractionApp,
      inputActive,
    };

    // A null frame with the camera ok keeps the previous presence and pushes nothing.
    if (!frame) {
      if (presence !== 'hidden') this.hidden = null;
      this.yawnSince = null;
      return {
        at: now,
        presence,
        study: null,
        weight: 0,
        cause: null,
        evidence,
        eyes: NO_EYES,
        hints: this.hints(presence, null, now),
        frame: null,
        rel: null,
      };
    }

    // Classifier learning (baseline, drift) only while working.
    if (work) {
      const hint = { inputActive, distraction: distractionApp, phone, idleMs: idle ?? null };
      classifier.observe(frame, hint);
      if (this.fallback && this.fallback !== classifier) this.fallback.observe(frame, hint);
    }

    const p = presence === 'visible' || presence === 'hidden' ? classifier.predict(frame) : null;

    // Face bookkeeping and the hidden last-pose rule.
    let hidden: HiddenMemo | null = null;
    if (face) {
      this.lastFaceAt = now;
      this.lastVisible = { at: now, rel, pose: face.pose, lookingDown };
      this.hidden = null;
    } else if (presence === 'hidden') {
      if (!this.hidden) this.hidden = { since: now, pose: this.lastPose(now) };
      hidden = {
        value: hiddenValue(this.hidden.pose, now - this.hidden.since, threshold),
        turned: this.hidden.pose === 'turned',
      };
    } else {
      this.hidden = null;
    }

    // Eyes
    let closed = false;
    let yawn = false;
    if (face) {
      const eyes = classifier.eyes;
      if (
        eyes.reliable &&
        frame.quality >= EYES_MIN_QUALITY &&
        face.lookDown < EYES_MAX_LOOK_DOWN
      ) {
        const dpitch = rel ? rel.dpitch : 0;
        const expected = eyes.blinkFit[0] + eyes.blinkFit[1] * dpitch;
        closed = face.blink - expected > eyes.closedDelta;
      }
      if (face.jawOpen > YAWN_JAW) {
        if (this.yawnSince === null) this.yawnSince = now;
        yawn = now - this.yawnSince >= c.yawnMinMs;
      } else {
        this.yawnSince = null;
      }
    } else {
      this.yawnSince = null;
    }

    const fused = fuse({
      presence,
      p,
      trust: classifier.trust,
      evidence,
      hidden,
      threshold,
      eyesClosed: closed,
    });

    if (work && cameraOk) this.checkStale(dt, face !== null, p, inputActive, distractionApp);

    const observation: Observation = {
      at: now,
      presence,
      study: fused.study,
      weight: fused.study === null ? 0 : clamp(frame.quality, 0, 1),
      cause: fused.cause,
      evidence,
      eyes: closed || yawn ? { closed, yawn } : NO_EYES,
      hints: this.hints(presence, frame, now),
      frame,
      rel,
    };
    if (hidden) this.hiddenMemo.set(observation, hidden);
    return observation;
  }

  rescore(observation: Observation, settings: Readonly<StudyAiSettings>): number | null {
    const frame = observation.frame;
    if (observation.study === null || !frame) return observation.study;
    const presence = observation.presence;
    if (presence !== 'visible' && presence !== 'hidden') return null;
    const classifier = this.current;
    const p = classifier.predict(frame);
    return fuse({
      presence,
      p,
      trust: classifier.trust,
      evidence: observation.evidence,
      hidden: this.hiddenMemo.get(observation) ?? null,
      threshold: settings.focusScoreThreshold,
      eyesClosed: false,
    }).study;
  }

  reset(): void {
    this.evidence.reset();
    this.lastT = null;
    this.presence = 'camera_lost';
    this.distractionSince = null;
    this.lastFaceAt = null;
    this.lastVisible = null;
    this.hidden = null;
    this.yawnSince = null;
  }

  /** No face, but a person in the recent detector runs or motion where the face just was. */
  private someoneWithoutFace(frame: FrameFeatures, now: MonoMs, personThreshold: number): boolean {
    if (this.evidence.personSeen(personThreshold)) return true;
    const motion = frame.luma?.motionNearFace ?? 0;
    return (
      motion >= MOTION_NEAR_FACE &&
      this.lastFaceAt !== null &&
      now - this.lastFaceAt <= FACE_RECENT_MS
    );
  }

  /** Where the head was within 2 s before the face was lost. */
  private lastPose(now: MonoMs): HiddenPose {
    const last = this.lastVisible;
    if (!last || now - last.at > HIDDEN_LOOKBACK_MS) return 'unknown';
    const yaw = last.rel ? last.rel.dyaw : last.pose.yaw;
    if (Math.abs(yaw) >= HIDDEN_TURNED_YAW) return 'turned';
    const down = last.rel
      ? last.rel.dpitch <= LOOK_DOWN_DPITCH
      : last.pose.pitch <= LOOK_DOWN_ABS_PITCH;
    return down || last.lookingDown ? 'down' : 'unknown';
  }

  private checkStale(
    dt: number,
    hasFace: boolean,
    p: ClassProbabilities | null,
    inputActive: boolean,
    distraction: boolean,
  ): void {
    if (this.staleDone || this.current.kind !== 'personal' || !this.fallback) return;
    this.staleObservedMs += dt;
    if (hasFace && p && inputActive && !distraction) {
      this.staleFrames += 1;
      if (argmax(p) === 'away') this.staleAway += 1;
    }
    if (
      this.staleFrames >= STALE_MIN_FRAMES &&
      this.staleAway / this.staleFrames >= STALE_AWAY_SHARE
    ) {
      this.current = this.fallback;
      this.stale = true;
      this.staleDone = true;
      return;
    }
    if (this.staleObservedMs >= STALE_WINDOW_MS) this.staleDone = true;
  }

  private hints(presence: Presence, frame: FrameFeatures | null, now: MonoMs): HintCode[] {
    const out: HintCode[] = [];
    if (frame?.luma?.lowLight) out.push('low_light');
    if (presence === 'covered') out.push('camera_covered');
    const hiddenLong =
      presence === 'hidden' && this.hidden !== null && now - this.hidden.since > CANT_SEE_HIDDEN_MS;
    const truncated = presence === 'visible' && (frame?.face?.truncated ?? 0) > CANT_SEE_TRUNCATED;
    if (hiddenLong || truncated) out.push('camera_cant_see_you');
    if (this.stale) out.push('recalibrate');
    return out;
  }
}
