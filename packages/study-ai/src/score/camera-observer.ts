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
  CANT_SEE_UNKNOWN_MS,
  DESK_SPOT_FORGET_MS,
  DESK_SPOT_MAX,
  EYES_MAX_LOOK_DOWN,
  EYES_MIN_QUALITY,
  FACE_RECENT_MS,
  HIDDEN_LOOKBACK_MS,
  HIDDEN_LOW_VALUE,
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
import {
  atSpot,
  withoutDeskPhone,
  type DeskPhoneLearner,
  type DeskPhoneSpot,
  type DeskPhoneVouch,
} from './desk-phone';
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
  /** How much the face was cut by the frame edge. */
  truncated: number;
}

interface HiddenStretch {
  since: MonoMs;
  pose: HiddenPose;
  /** The face was cut by the frame edge just before it was lost (it slid out of view). */
  slidOut: boolean;
}

/** Rule-side inputs of a hidden observation, kept for `rescore` (never serialised). */
interface HiddenMemo {
  value: number;
  pose: HiddenPose;
}

/** A vouched desk phone and when it was last seen there (observed time). */
interface DeskSpotMemo {
  spot: DeskPhoneSpot;
  seenAt: number;
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

/** Yaw of a visible face: relative to the screen baseline, or absolute before one exists. */
function faceYaw(face: FaceFeatures | null, rel: RelativePose | null): number | null {
  if (!face) return null;
  return rel ? rel.dyaw : face.pose.yaw;
}

/**
 * Keyboard or mouse used within `limitMs` (the no-camera idle limit). Unknown idle counts as
 * recent, as in the no-camera mode.
 */
function recentInput(idleMs: number | null, limitMs: number): boolean {
  if (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < 0) return true;
  return idleMs < limitMs;
}

function argmax(p: ClassProbabilities): keyof ClassProbabilities {
  let best: keyof ClassProbabilities = 'screen';
  for (const key of ['paper', 'phone', 'away', 'absent'] as const) {
    if (p[key] > p[best]) best = key;
  }
  return best;
}

export class CameraObserver implements Observer, DeskPhoneLearner {
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
  /** The hidden stretch is past its allowance and reported as `absent` (not observable). */
  private unseen = false;
  private yawnSince: MonoMs | null = null;

  // Vouched desk phones (session memory: survive reset(), forgotten once the phone leaves)
  private observedMs = 0;
  private deskSpots: DeskSpotMemo[] = [];
  private vouchedSpan: { from: MonoMs; to: MonoMs } | null = null;

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

  /**
   * «¡Estaba estudiando!» on a phone lying on the desk: from now on a phone at that spot is
   * not seen (evidence, classifier, feedback rows) while it stays there, the current E_phone
   * is dropped, and `rescore` ignores the phone evidence of the vouched span.
   */
  vouchDeskPhone(vouch: DeskPhoneVouch): void {
    const spot: DeskPhoneSpot = { box: vouch.box, width: vouch.width, height: vouch.height };
    this.deskSpots = this.deskSpots.filter((m) => !atSpot(vouch.box, m.spot));
    this.deskSpots.push({ spot, seenAt: this.observedMs });
    if (this.deskSpots.length > DESK_SPOT_MAX) this.deskSpots.shift();
    if (Number.isFinite(vouch.from) && Number.isFinite(vouch.to) && vouch.to >= vouch.from) {
      this.vouchedSpan = { from: vouch.from, to: vouch.to };
    }
    this.evidence.dropPhone();
  }

  /** The vouched desk-phone spots still remembered (tests, diagnostics). */
  get deskPhoneSpots(): readonly DeskPhoneSpot[] {
    return this.deskSpots.map((m) => m.spot);
  }

  observe(input: TickInput, settings: Readonly<StudyAiSettings>): Observation {
    const c = STUDY_AI_CONSTANTS;
    const now = input.now;
    const dt =
      this.lastT === null || !Number.isFinite(now)
        ? 0
        : clamp(now - this.lastT, 0, OBSERVE_MAX_STEP_MS);
    if (Number.isFinite(now)) this.lastT = now;
    this.observedMs += dt;
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
    const frame = cameraOk ? this.maskDeskPhone(input.frame) : null;
    const seenFace = frame ? frame.face : null;
    const rel = seenFace ? classifier.relativePose(seenFace) : null;
    const lookingDown = seenFace ? isLookingDown(seenFace, rel) : false;
    this.evidence.record(frame, thresholds, lookingDown);
    this.evidence.update(now);

    // Presence. A tracked face beats the luma statistic: a dim, low-contrast room can look
    // «covered» to the 32×24 thumbnail while the landmarker still follows the user.
    // Covering the lens removes the face, so this is no way around `covered`.
    let presence: Presence;
    if (!cameraOk) presence = 'camera_lost';
    else if (!frame) presence = this.presence;
    else if (frame.face) presence = 'visible';
    else if (frame.luma?.covered) presence = 'covered';
    else if (this.someoneWithoutFace(frame, now, thresholds.person)) presence = 'hidden';
    else presence = 'absent';

    // `visible` means a frame with a face: exactly `seenFace`.
    const face = presence === 'visible' ? seenFace : null;
    const phone = this.evidence.phone;
    const evidence: ObservationEvidence = {
      phone,
      book: this.evidence.book(now),
      lookingDown,
      distractionApp,
      inputActive,
    };

    // Face bookkeeping and the hidden last-pose rule. A hidden stretch past its allowance
    // (unknown pose after 20 s, head down after 10 min) is not observable: without a phone
    // or a distraction to go by it is reported `absent`, so the absence path (warning at
    // half, strike at `noFaceStrikeMs`, cause `no_face`) replaces a DUDA that would blame
    // attention for a framing or light problem. Turned away stays observable (0.2).
    let hidden: HiddenMemo | null = null;
    if (frame) {
      if (face) {
        this.lastFaceAt = now;
        this.lastVisible = {
          at: now,
          rel,
          pose: face.pose,
          lookingDown,
          truncated: face.truncated,
        };
        this.hidden = null;
      } else if (presence === 'hidden') {
        if (!this.hidden) {
          this.hidden = { since: now, pose: this.lastPose(now), slidOut: this.slidOut(now) };
        }
        const pose = this.hidden.pose;
        const holdUnknown =
          frame.luma?.lowLight === true && recentInput(idle, settings.noCameraIdleMs);
        const value = hiddenValue(pose, now - this.hidden.since, threshold, holdUnknown);
        if (value !== null) hidden = { value, pose };
        else if (phone || distractionApp) hidden = { value: HIDDEN_LOW_VALUE, pose };
        else presence = 'absent';
      } else {
        this.hidden = null;
      }
    } else if (!cameraOk) {
      this.hidden = null;
    }
    this.unseen = presence === 'absent' && this.hidden !== null;
    this.presence = presence;

    // A null frame with the camera ok keeps the previous presence and pushes nothing.
    if (!frame) {
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
      faceYaw: faceYaw(face, rel),
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
    const stored = observation.frame;
    if (observation.study === null || !stored) return observation.study;
    const presence = observation.presence;
    if (presence !== 'visible' && presence !== 'hidden') return null;
    const classifier = this.current;
    const frame =
      this.deskSpots.length > 0
        ? withoutDeskPhone(
            stored,
            this.deskSpots.map((m) => m.spot),
          )
        : stored;
    // The phone evidence of a vouched desk-phone span came from that phone.
    const span = this.vouchedSpan;
    const vouched =
      observation.evidence.phone &&
      span !== null &&
      observation.at >= span.from &&
      observation.at <= span.to;
    const face = presence === 'visible' ? frame.face : null;
    return fuse({
      presence,
      p: classifier.predict(frame),
      trust: classifier.trust,
      evidence: vouched ? { ...observation.evidence, phone: false } : observation.evidence,
      hidden: this.hiddenMemo.get(observation) ?? null,
      faceYaw: faceYaw(face, observation.rel),
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
    this.unseen = false;
    this.yawnSince = null;
  }

  /** A phone at a vouched desk spot is not seen; spots the phone left are forgotten. */
  private maskDeskPhone(frame: FrameFeatures | null): FrameFeatures | null {
    if (!frame || this.deskSpots.length === 0) return frame;
    const objects = frame.objects;
    const phone = objects?.phone ?? null;
    if (objects?.fresh && phone) {
      for (const memo of this.deskSpots) {
        if (atSpot(phone.box, memo.spot)) memo.seenAt = this.observedMs;
      }
    }
    this.deskSpots = this.deskSpots.filter(
      (memo) => this.observedMs - memo.seenAt <= DESK_SPOT_FORGET_MS,
    );
    if (this.deskSpots.length === 0) return frame;
    return withoutDeskPhone(
      frame,
      this.deskSpots.map((m) => m.spot),
    );
  }

  /** The face was cut by the frame edge within 2 s before it was lost (it slid out). */
  private slidOut(now: MonoMs): boolean {
    const last = this.lastVisible;
    return (
      last !== null && now - last.at <= HIDDEN_LOOKBACK_MS && last.truncated > CANT_SEE_TRUNCATED
    );
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
    // Someone is there but the face is not: say so early, before the absence path warns.
    const stretch = presence === 'hidden' || this.unseen ? this.hidden : null;
    let cantSee = false;
    if (stretch !== null) {
      const ms = now - stretch.since;
      cantSee =
        this.unseen ||
        stretch.slidOut ||
        ms > CANT_SEE_HIDDEN_MS ||
        (stretch.pose === 'unknown' && ms >= CANT_SEE_UNKNOWN_MS);
    }
    const truncated = presence === 'visible' && (frame?.face?.truncated ?? 0) > CANT_SEE_TRUNCATED;
    if (cantSee || truncated) out.push('camera_cant_see_you');
    if (this.stale) out.push('recalibrate');
    return out;
  }
}
