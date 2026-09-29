/**
 * Camera ticks → observations (owner: DECISION): presence, evidence persistence, fusion of
 * the classifier with the rules, drowsiness candidates and the stale-profile check.
 * DESIGN.md §7.1–7.4. «Eyes down» is judged against the user's own screen gaze, and the eye
 * model is re-judged online (`gaze.ts`).
 *
 * Deterministic: time only comes from `TickInput.now`. Nothing here keeps an image; the
 * observation carries the frame's numbers for the 90 s «¡Estaba estudiando!» ring only.
 */
import { STUDY_AI_CONSTANTS } from '../config';
import { boxArea } from '../perception/geometry';
import type {
  AttentionClassifier,
  Box,
  ClassProbabilities,
  EyeModel,
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
  BOOK_OVER_FACE_SHARE,
  BOOK_SPAN_MS,
  BOOK_UP_HOLD_MS,
  CANT_SEE_HIDDEN_MS,
  CANT_SEE_TRUNCATED,
  CANT_SEE_UNKNOWN_MS,
  DESK_SPOT_FORGET_MS,
  DESK_SPOT_MAX,
  EYES_MAX_LOOK_DOWN,
  EYES_MIN_QUALITY,
  FACE_RECENT_MS,
  FRESH_INPUT_MS,
  GAZE_REF_MAX_DPITCH,
  GAZE_REF_MAX_DYAW,
  GAZE_REF_MIN_QUALITY,
  HIDDEN_ACTIVE_MOTION,
  HIDDEN_ASLEEP_MAX_MS,
  HIDDEN_BOOK_MOTION,
  HIDDEN_LOOKBACK_MS,
  HIDDEN_LOW_VALUE,
  HIDDEN_STILL_MS,
  HIDDEN_TURNED_YAW,
  LOOK_DOWN_ABS_PITCH,
  LOOK_DOWN_DPITCH,
  LOOK_DOWN_MAX_YAW,
  LOOK_DOWN_SIDE_ABS_PITCH,
  LOOK_DOWN_SIDE_DPITCH,
  LOOK_DOWN_SIDE_MAX_YAW,
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
import { OnlineEyes, ScreenGaze } from './gaze';

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
  box: Box;
}

interface HiddenStretch {
  since: MonoMs;
  /** The last-pose rule's pose, fixed when the face was lost. */
  pose: HiddenPose;
  /** The pose judged on the latest tick (`book` while a book is held up in front). */
  current: HiddenPose;
  /** The face was cut by the frame edge just before it was lost (it slid out of view). */
  slidOut: boolean;
  /** Last sign of life: keyboard or mouse, or motion where the face was. */
  activeAt: MonoMs;
  /** Last tick with a book held up where the face was (`null`: never in this stretch). */
  bookAt: MonoMs | null;
}

/** One frame of the stale-profile check (observed work time). */
interface StaleSample {
  at: number;
  away: boolean;
}

/** Rule-side inputs of a hidden observation, kept for `rescore` (never serialised). */
interface HiddenMemo {
  value: number;
  pose: HiddenPose;
}

/**
 * Rule-side inputs of an observation that the stored frame alone cannot give back, kept for
 * `rescore` only when they matter (a hidden face, typing at a distraction).
 */
interface FusionMemo {
  hidden: HiddenMemo | null;
  freshInput: boolean;
}

/** A vouched desk phone and when it was last seen there (observed time). */
interface DeskSpotMemo {
  spot: DeskPhoneSpot;
  seenAt: number;
}

const NO_EYES = Object.freeze({ closed: false, yawn: false });

/**
 * Looking down at the desk: head or eyes down within 35° of the screen direction; or, up to
 * 60° to the side where a notebook or a textbook next to the laptop lies, the head clearly
 * down (relative pitch ≤ −20°), or moderately down (≤ −12°) with the eyes down too. Without
 * a baseline, absolute pitch (−20°, and −25° for «clearly»). Eyes down means `lookDown` ≥
 * `eyesDownAt`: 0.45, or higher for a user whose eyes already look down at the screen.
 */
function isLookingDown(face: FaceFeatures, rel: RelativePose | null, eyesDownAt: number): boolean {
  const eyesDown = face.lookDown >= eyesDownAt;
  const pitch = rel ? rel.dpitch : face.pose.pitch;
  const yaw = Math.abs(rel ? rel.dyaw : face.pose.yaw);
  const downPitch = rel ? LOOK_DOWN_DPITCH : LOOK_DOWN_ABS_PITCH;
  const clearlyDown = pitch <= (rel ? LOOK_DOWN_SIDE_DPITCH : LOOK_DOWN_SIDE_ABS_PITCH);
  if (yaw <= LOOK_DOWN_SIDE_MAX_YAW && (clearlyDown || (pitch <= downPitch && eyesDown))) {
    return true;
  }
  return (pitch <= downPitch || eyesDown) && yaw <= LOOK_DOWN_MAX_YAW;
}

/** The face looks down toward the desk, head or eyes (whatever the yaw). */
function isFacingDown(face: FaceFeatures, rel: RelativePose | null, eyesDownAt: number): boolean {
  if (face.lookDown >= eyesDownAt) return true;
  return rel ? rel.dpitch <= LOOK_DOWN_DPITCH : face.pose.pitch <= LOOK_DOWN_ABS_PITCH;
}

/** Share of `target`'s area that `cover` covers (0–1). */
function coverShare(cover: Box, target: Box): number {
  const ix =
    Math.min(cover.cx + cover.w / 2, target.cx + target.w / 2) -
    Math.max(cover.cx - cover.w / 2, target.cx - target.w / 2);
  const iy =
    Math.min(cover.cy + cover.h / 2, target.cy + target.h / 2) -
    Math.max(cover.cy - cover.h / 2, target.cy - target.h / 2);
  const area = boxArea(target);
  if (!(ix > 0) || !(iy > 0) || !(area > 0)) return 0;
  return Math.min(1, (ix * iy) / area);
}

/** Yaw of a visible face: relative to the screen baseline, or absolute before one exists. */
function faceYaw(face: FaceFeatures | null, rel: RelativePose | null): number | null {
  if (!face) return null;
  return rel ? rel.dyaw : face.pose.yaw;
}

/** Keyboard or mouse used within the last 2 s. Unknown idle is not fresh. */
function freshInputOf(idleMs: number | null): boolean {
  return typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs >= 0
    ? idleMs < FRESH_INPUT_MS
    : false;
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

/** The answer's argmax is a study class (screen or paper). */
function studyFor(p: ClassProbabilities | null): boolean {
  if (!p) return false;
  const best = argmax(p);
  return best === 'screen' || best === 'paper';
}

export class CameraObserver implements Observer, DeskPhoneLearner {
  readonly mode: StudyMode = 'camera';

  private current: AttentionClassifier;
  private readonly fallback: AttentionClassifier | null;
  private readonly evidence = new DetectorEvidence();
  private readonly memo = new WeakMap<Observation, FusionMemo>();
  /** The user's own eyes (session memory: survive reset(), like the stale-profile state). */
  private readonly gaze = new ScreenGaze();
  private readonly onlineEyes = new OnlineEyes();

  private lastT: MonoMs | null = null;
  private presence: Presence = 'camera_lost';
  private distractionSince: MonoMs | null = null;
  private lastFaceAt: MonoMs | null = null;
  private lastVisible: LastVisible | null = null;
  private hidden: HiddenStretch | null = null;
  /** The hidden stretch is past its allowance and reported as `absent` (not observable). */
  private unseen = false;
  private yawnSince: MonoMs | null = null;
  /** `at` of the first luma sample of the current «covered» stretch (`null`: not covered). */
  private coveredSince: MonoMs | null = null;

  // Vouched desk phones (session memory: survive reset(), forgotten once the phone leaves)
  private observedMs = 0;
  private deskSpots: DeskSpotMemo[] = [];
  private vouchedSpan: { from: MonoMs; to: MonoMs } | null = null;

  // Stale-profile check (sticky: survives reset()): the last STALE_MIN_FRAMES qualifying
  // frames, in observed work time.
  private staleObservedMs = 0;
  private staleRing: StaleSample[] = [];
  private staleNext = 0;
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

  /** The user's `lookDown` at the screen, once known (tests, diagnostics). */
  get screenLookDown(): number | null {
    return this.gaze.reference;
  }

  /** The eye model in use: the classifier's, corrected by the session's own frames. */
  get eyeModel(): Readonly<EyeModel> {
    return this.onlineEyes.model(this.current.eyes);
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
    const freshInput = freshInputOf(idle);

    // Detector evidence. The pose comes first: a phone only counts as in use when it moves,
    // the user looks down at it or holds it at the face, or the face is out of view.
    const cameraOk = input.camera === 'ok';
    const frame = cameraOk ? this.maskDeskPhone(input.frame) : null;
    const seenFace = frame ? frame.face : null;
    const rel = seenFace ? classifier.relativePose(seenFace) : null;
    const eyesDownAt = this.gaze.eyesDownAt;
    const lookingDown = seenFace ? isLookingDown(seenFace, rel, eyesDownAt) : false;
    this.evidence.record(frame, thresholds, lookingDown);
    this.evidence.update(now);

    // Presence. A tracked face beats the luma statistic: a dim, low-contrast room can look
    // «covered» to the 32×24 thumbnail while the landmarker still follows the user. So does a
    // person the detector found on an image taken while the luma already said «covered» (a
    // dim room between tracked-face frames). Covering the lens removes the face and the
    // person from the next image on, so this is no way around `covered`.
    if (!cameraOk) this.coveredSince = null;
    else if (frame) this.trackCovered(frame);
    let presence: Presence;
    if (!cameraOk) presence = 'camera_lost';
    else if (!frame) presence = this.presence;
    else if (frame.face) presence = 'visible';
    else if (frame.luma?.covered && !this.personInDimRoom(thresholds.person)) presence = 'covered';
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

    // Face bookkeeping and the hidden last-pose rule. An unknown pose past its 20 s allowance
    // is not observable: without a phone or a distraction to go by it is reported `absent`,
    // so the absence path (warning at half, strike at `noFaceStrikeMs`, cause `no_face`)
    // replaces a DUDA that would blame attention for a framing or light problem. Turned away
    // stays observable (0.2). A head down (or behind a book) keeps the study floor for as
    // long as someone is there with signs of life (writing for an hour out of the camera's
    // view is studying); with no sign of life for 90 s it is asleep on the desk: a drowsy
    // candidate, never a strike, until `HIDDEN_ASLEEP_MAX_MS`. When the person leaves, the
    // presence is `absent` and the absence path runs at once.
    let hidden: HiddenMemo | null = null;
    let asleep = false;
    if (frame) {
      if (face) {
        this.lastFaceAt = now;
        this.lastVisible = {
          at: now,
          rel,
          pose: face.pose,
          lookingDown,
          truncated: face.truncated,
          box: face.box,
        };
        this.hidden = null;
      } else if (presence === 'hidden') {
        const stretch = this.hiddenStretch(now);
        this.noteActivity(stretch, frame, idle, now, evidence.book);
        const bookRule = !phone && !distractionApp;
        if (bookRule && evidence.book && this.bookOverFace(now)) stretch.bookAt = now;
        const bookHeld =
          bookRule && stretch.bookAt !== null && now - stretch.bookAt <= BOOK_UP_HOLD_MS;
        const pose: HiddenPose = bookHeld ? 'book' : stretch.pose;
        stretch.current = pose;
        const still = now - stretch.activeAt >= HIDDEN_STILL_MS;
        if ((pose === 'down' || pose === 'book') && still && !phone) {
          if (now - stretch.since <= HIDDEN_ASLEEP_MAX_MS) asleep = true;
          else presence = 'absent';
        } else {
          // After a book was lowered, the unknown pose gets its allowance from then on.
          const from =
            pose === 'unknown' && stretch.bookAt !== null
              ? Math.max(stretch.since, stretch.bookAt)
              : stretch.since;
          const holdUnknown =
            frame.luma?.lowLight === true && recentInput(idle, settings.noCameraIdleMs);
          const value = hiddenValue(pose, now - from, threshold, holdUnknown);
          if (value !== null) hidden = { value, pose };
          else if (phone || distractionApp) hidden = { value: HIDDEN_LOW_VALUE, pose };
          else presence = 'absent';
        }
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
    if (work && face) this.learnEyes(face, rel, frame.quality, p, freshInput, evidence);

    // Eyes. Someone typing, holding a phone in use or at a distraction app is not asleep: a
    // «closed» reading then is glare or heavy lids, and such frames must stay in the window.
    let closed = false;
    let yawn = false;
    if (face) {
      if (
        !freshInput &&
        !phone &&
        !distractionApp &&
        frame.quality >= EYES_MIN_QUALITY &&
        face.lookDown < EYES_MAX_LOOK_DOWN
      ) {
        const eyes = this.onlineEyes.model(classifier.eyes);
        const dpitch = rel ? rel.dpitch : 0;
        const expected = eyes.blinkFit[0] + eyes.blinkFit[1] * dpitch;
        closed = eyes.reliable && face.blink - expected > eyes.closedDelta;
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

    // Asleep on the desk: out of the window like closed eyes (the engine freezes the timers
    // and suggests a break), whatever the foreground.
    const fused = asleep
      ? { study: null, cause: null }
      : fuse({
          presence,
          p,
          trust: classifier.trust,
          evidence,
          hidden,
          faceYaw: faceYaw(face, rel),
          facingDown: face ? isFacingDown(face, rel, eyesDownAt) : false,
          threshold,
          eyesClosed: closed,
          freshInput,
        });
    if (asleep) closed = true;

    if (work && cameraOk) this.checkStale(dt, frame, p, inputActive, distractionApp);

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
    if (hidden || (freshInput && distractionApp))
      this.memo.set(observation, { hidden, freshInput });
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
    const memo = this.memo.get(observation);
    return fuse({
      presence,
      p: classifier.predict(frame),
      trust: classifier.trust,
      evidence: vouched ? { ...observation.evidence, phone: false } : observation.evidence,
      hidden: memo?.hidden ?? null,
      faceYaw: faceYaw(face, observation.rel),
      facingDown: face ? isFacingDown(face, observation.rel, this.gaze.eyesDownAt) : false,
      threshold: settings.focusScoreThreshold,
      eyesClosed: false,
      freshInput: memo?.freshInput ?? false,
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
    this.coveredSince = null;
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

  /** Follows the luma «covered» stretch: when its first sample was taken. */
  private trackCovered(frame: FrameFeatures): void {
    const luma = frame.luma;
    if (!luma?.covered || !Number.isFinite(luma.at)) this.coveredSince = null;
    else if (this.coveredSince === null || luma.at < this.coveredSince) this.coveredSince = luma.at;
  }

  /**
   * The latest detector run saw a person on an image taken after the luma already said
   * «covered»: the room is dim, the lens is not covered (a covered lens shows no one).
   */
  private personInDimRoom(personThreshold: number): boolean {
    const run = this.evidence.latest;
    return (
      run !== null &&
      this.coveredSince !== null &&
      run.at >= this.coveredSince &&
      run.person >= personThreshold
    );
  }

  /** The current hidden stretch (started on this tick if there was none). */
  private hiddenStretch(now: MonoMs): HiddenStretch {
    if (!this.hidden) {
      const pose = this.lastPose(now);
      this.hidden = {
        since: now,
        pose,
        current: pose,
        slidOut: this.slidOut(now),
        activeAt: now,
        bookAt: null,
      };
    }
    return this.hidden;
  }

  /**
   * Signs of life: keyboard or mouse (the last input time), or motion where the face was
   * (less of it while a book is in view: a still reader).
   */
  private noteActivity(
    stretch: HiddenStretch,
    frame: FrameFeatures,
    idleMs: number | null,
    now: MonoMs,
    book: boolean,
  ): void {
    if (typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs >= 0) {
      stretch.activeAt = Math.max(stretch.activeAt, now - idleMs);
    }
    const luma = frame.luma;
    const motion = book ? HIDDEN_BOOK_MOTION : HIDDEN_ACTIVE_MOTION;
    if (luma && luma.motionNearFace >= motion && Number.isFinite(luma.at)) {
      stretch.activeAt = Math.max(stretch.activeAt, Math.min(luma.at, now));
    }
  }

  /**
   * The user's own eyes, from visible work frames:
   *
   * - screen gaze: the head within 12°/8° of a screen direction, a good frame, no fresh input
   *   (the keys draw the eyes down), no phone and a study answer;
   * - open-eye blink values: calm (not looking down) frames with fresh input, no phone and no
   *   distraction app, as the generic classifier judges its eyes.
   */
  private learnEyes(
    face: FaceFeatures,
    rel: RelativePose | null,
    quality: number,
    p: ClassProbabilities | null,
    freshInput: boolean,
    evidence: ObservationEvidence,
  ): void {
    if (evidence.phone) return;
    if (
      !freshInput &&
      rel !== null &&
      quality >= GAZE_REF_MIN_QUALITY &&
      Math.abs(rel.dyaw) <= GAZE_REF_MAX_DYAW &&
      Math.abs(rel.dpitch) <= GAZE_REF_MAX_DPITCH &&
      studyFor(p)
    ) {
      this.gaze.push(face.lookDown);
    }
    if (
      freshInput &&
      !evidence.distractionApp &&
      !evidence.lookingDown &&
      quality >= EYES_MIN_QUALITY
    ) {
      this.onlineEyes.push(face.blink);
    }
  }

  /** The latest book (≤ 6 s old) covers at least half of where the face last was. */
  private bookOverFace(now: MonoMs): boolean {
    const face = this.lastVisible?.box;
    const book = this.evidence.lastBookBox(now, BOOK_SPAN_MS);
    return !!face && !!book && coverShare(book, face) >= BOOK_OVER_FACE_SHARE;
  }

  /** Where the head was within 2 s before the face was lost. */
  private lastPose(now: MonoMs): HiddenPose {
    const last = this.lastVisible;
    if (!last || now - last.at > HIDDEN_LOOKBACK_MS) return 'unknown';
    // Looking down at a notebook up to 60° to the side is writing, not turned away.
    if (last.lookingDown) return 'down';
    const yaw = last.rel ? last.rel.dyaw : last.pose.yaw;
    if (Math.abs(yaw) >= HIDDEN_TURNED_YAW) return 'turned';
    const down = last.rel
      ? last.rel.dpitch <= LOOK_DOWN_DPITCH
      : last.pose.pitch <= LOOK_DOWN_ABS_PITCH;
    return down ? 'down' : 'unknown';
  }

  /**
   * Rolling stale-profile check: among the last 60 face frames with keyboard or mouse input
   * and no distraction app (all within the last 120 s of observed work time), ≥ 70 % are
   * «away» for the profile while the fallback, fed with the same fresh input, calls them
   * study → switch to the fallback for good and raise `recalibrate`.
   */
  private checkStale(
    dt: number,
    frame: FrameFeatures,
    p: ClassProbabilities | null,
    inputActive: boolean,
    distraction: boolean,
  ): void {
    const fallback = this.fallback;
    if (this.staleDone || this.current.kind !== 'personal' || !fallback) return;
    this.staleObservedMs += dt;
    if (!frame.face || !p || !inputActive || distraction) return;
    const at = this.staleObservedMs;
    const away = argmax(p) === 'away' && studyFor(fallback.predict(frame));
    const ring = this.staleRing;
    if (ring.length < STALE_MIN_FRAMES) {
      ring.push({ at, away });
    } else {
      const old = ring[this.staleNext] as StaleSample;
      if (old.away) this.staleAway -= 1;
      ring[this.staleNext] = { at, away };
      this.staleNext = (this.staleNext + 1) % STALE_MIN_FRAMES;
    }
    if (away) this.staleAway += 1;
    if (ring.length < STALE_MIN_FRAMES) return;
    const oldest = ring[this.staleNext] as StaleSample;
    if (at - oldest.at > STALE_WINDOW_MS) return;
    if (this.staleAway / STALE_MIN_FRAMES >= STALE_AWAY_SHARE) {
      this.current = fallback;
      this.stale = true;
      this.staleDone = true;
      this.staleRing = [];
    }
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
        (stretch.current === 'unknown' && ms >= CANT_SEE_UNKNOWN_MS);
    }
    const truncated = presence === 'visible' && (frame?.face?.truncated ?? 0) > CANT_SEE_TRUNCATED;
    if (cantSee || truncated) out.push('camera_cant_see_you');
    if (this.stale) out.push('recalibrate');
    return out;
  }
}
