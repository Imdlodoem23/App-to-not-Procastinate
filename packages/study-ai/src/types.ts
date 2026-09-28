/**
 * Public types of @centrate/study-ai (see DESIGN.md). This file is the contract between the
 * four builders (PERCEPTION, LEARNING, DECISION, RUNTIME) and the desktop app.
 *
 * Rules for this file:
 * - DOM-free: it must typecheck with `lib: ["ES2023"]` (the Electron main process imports it).
 *   Browser objects (ImageBitmap, VideoFrame…) travel as `unknown` inside `AnalysisFrame`.
 * - Numbers only: nothing here can hold an image, a landmark list or a raw blendshape vector
 *   beyond the frame being analysed.
 * - Every time is a monotonic millisecond count (`MonoMs`) unless the name says `Iso`.
 * - Changes go through the coordinator; builders may only add optional fields.
 */
import type { HeartbeatState, IsoUtc, StrikeCause, StudyPhase } from '@centrate/shared/domain';

export type { HeartbeatState, IsoUtc, StrikeCause, StudyPhase };

// ---------------------------------------------------------------------------------------
// Time and scheduling
// ---------------------------------------------------------------------------------------

/**
 * Monotonic milliseconds (`performance.now()` in the analysis window, a fake clock in tests).
 * Never wall-clock time, never compared across processes.
 */
export type MonoMs = number;

export interface Clock {
  now(): MonoMs;
}

/** setTimeout-style timers (never requestAnimationFrame). Injected so tests use fake time. */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

/** User-tunable values; always pass through `resolveStudyAiSettings` (clamps every field). */
export interface StudyAiSettings {
  /** ENFOCADO → DUDA after the score stays under the threshold this long (10–60 s, 15 s). */
  doubtAfterMs: number;
  /** DUDA → STRIKE after this much more (15–120 s, 30 s). */
  strikeAfterDoubtMs: number;
  /** Absence (no face, no person, covered camera) → strike (30–180 s, 60 s). */
  noFaceStrikeMs: number;
  /** «Sensibilidad»: score threshold θ (30–80, 50). */
  focusScoreThreshold: number;
  /** Smoothing window W of the focus score (10–20 s, 15 s). */
  focusWindowMs: number;
  /** No-camera mode: keyboard/mouse idle time that reads as «not studying» (3–20 min, 8 min). */
  noCameraIdleMs: number;
}

export type StudyMode = 'camera' | 'no-camera';

// ---------------------------------------------------------------------------------------
// Calibration classes
// ---------------------------------------------------------------------------------------

/**
 * The five calibration situations, in recording order: «estudiando mirando la pantalla»,
 * «estudiando con libro o cuaderno», «distraído con el móvil», «mirando a otro lado» and
 * «no estoy». `paper` (not `book`) so it never collides with the detector's COCO `book`.
 */
export const CALIBRATION_CLASSES = ['screen', 'paper', 'phone', 'away', 'absent'] as const;
export type CalibrationClass = (typeof CALIBRATION_CLASSES)[number];

/** Classes that count as studying. */
export const STUDY_CLASSES = ['screen', 'paper'] as const;
export type StudyClass = (typeof STUDY_CLASSES)[number];

/** Classifier output: one probability per calibration class, summing to 1. */
export type ClassProbabilities = Readonly<Record<CalibrationClass, number>>;

// ---------------------------------------------------------------------------------------
// PERCEPTION: MediaPipe-shaped inputs (structural, so tests pass plain objects)
// ---------------------------------------------------------------------------------------

/** `Matrix` of @mediapipe/tasks-vision: a 4×4 transform, column-major by default. */
export interface MatrixLike {
  rows: number;
  columns: number;
  data: ArrayLike<number>;
}

export interface CategoryLike {
  categoryName: string;
  score: number;
  index?: number;
  displayName?: string;
}

export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
}

export interface FaceLandmarkerResultLike {
  faceLandmarks: ArrayLike<ArrayLike<LandmarkLike>>;
  faceBlendshapes?: ArrayLike<{ categories: ArrayLike<CategoryLike> }>;
  facialTransformationMatrixes?: ArrayLike<MatrixLike>;
}

/** Pixel coordinates of the analysed frame, as the Object Detector returns them. */
export interface BoundingBoxLike {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface DetectionLike {
  categories: ArrayLike<CategoryLike>;
  boundingBox?: BoundingBoxLike;
}

export interface DetectionResultLike {
  detections: ArrayLike<DetectionLike>;
}

/** A tiny grey thumbnail (32×24) used only for luma statistics, discarded right after. */
export interface GrayThumbnail {
  width: number;
  height: number;
  /** Row-major 0–255 values, length width × height. */
  data: Uint8Array | Uint8ClampedArray;
}

/** One analysed frame's raw MediaPipe outputs, the input of `FeatureExtractor.extract`. */
export interface RawVisionInput {
  t: MonoMs;
  width: number;
  height: number;
  face: FaceLandmarkerResultLike;
  /** `null` when the object detector did not run on this frame (held values are used). */
  objects: DetectionResultLike | null;
  /** `null` when luma was not sampled on this frame (held ≤ 2 s). */
  gray: GrayThumbnail | null;
}

// ---------------------------------------------------------------------------------------
// PERCEPTION: features (the only thing that leaves the vision pipeline)
// ---------------------------------------------------------------------------------------

/** Normalised to the frame: centre and size in [0, 1] (a truncated face can exceed it). */
export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * Degrees, camera frame (not mirrored). `yaw > 0`: face turned towards the image's right.
 * `pitch > 0`: face tilted up, so writing or reading gives a negative pitch. Signs are
 * pinned by composed-matrix tests and one manual check in `demo/`.
 */
export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceFeatures {
  pose: HeadPose;
  box: Box;
  /** Share of landmarks outside the frame, 0–1. */
  truncated: number;
  /** mean(eyeBlinkLeft, eyeBlinkRight), 0–1. */
  blink: number;
  /** mean(eyeLookDownLeft, eyeLookDownRight), 0–1. */
  lookDown: number;
  /** mean(eyeLookUpLeft, eyeLookUpRight), 0–1. */
  lookUp: number;
  /** Horizontal gaze, −1…1, `+` towards the image's right (same sign as yaw). */
  gazeX: number;
  /** jawOpen, 0–1 (yawns). */
  jawOpen: number;
  /** Median landmark displacement / box height since the previous frame (0 with no previous). */
  jitter: number;
  /** Faces detected in the frame (the user is the one chosen; ≥ 1). */
  faces: number;
}

export interface ObjectDetection {
  /** Detector score, 0–1. */
  score: number;
  box: Box;
}

export interface PhoneDetection extends ObjectDetection {
  /**
   * Held near the face: the box overlaps the face box or sits in front of the chest (±1.2
   * face widths, down to 1.5 face heights below the chin); never a phone at rest (still for
   * 20 s) nor a box cut by the bottom edge that does not move.
   */
  nearFace: boolean;
  /** Box clearly moved or resized since it was last seen at rest or on the previous run. */
  moving: boolean;
  /**
   * How long the box has stayed at one spot (pixel-tolerant, kept across detector misses
   * for 60 s), e.g. a phone lying on the desk or a timer on a stand. 0 while it moves.
   */
  stillMs: number;
}

export interface ObjectFeatures {
  /** When the detector produced these values. */
  ranAt: MonoMs;
  /** `t − ranAt`. Perception returns `objects: null` once this exceeds the hold time (4 s). */
  ageMs: number;
  /** The detector ran on this very frame (persistence rules count runs, not frames). */
  fresh: boolean;
  /**
   * A `cell phone` above the detector threshold with area ≥ 0.4 % of the frame: the best one
   * that looks in hand (near the face or moving), else the best one.
   */
  phone: PhoneDetection | null;
  /** Best `book`. */
  book: ObjectDetection | null;
  /** Best `person` with area ≥ 5 % of the frame. */
  person: ObjectDetection | null;
}

export interface LumaFeatures {
  at: MonoMs;
  /** Mean luma, 0–1. */
  mean: number;
  /** Spatial standard deviation, 0–1. */
  spatialStd: number;
  /** Mean absolute difference with the previous thumbnail, 0–1. */
  temporalDiff: number;
  /** Temporal difference inside the last face box (×2), 0–1. */
  motionNearFace: number;
  /** Finger, sticker, closed lid or a wall right in front of the lens. */
  covered: boolean;
  /** Too dark for reliable landmarks (mean < 0.18 and not covered). */
  lowLight: boolean;
}

/** Everything the rest of the package knows about one frame. Numbers only. */
export interface FrameFeatures {
  t: MonoMs;
  width: number;
  height: number;
  /** The user's face, or `null` when no usable face was found. */
  face: FaceFeatures | null;
  /** Latest detector values (held ≤ 4 s), or `null`. */
  objects: ObjectFeatures | null;
  /** Latest luma values (held ≤ 2 s), or `null`. */
  luma: LumaFeatures | null;
  /** Frame weight q in [0.2, 1]: truncation, jitter and low light lower it. */
  quality: number;
}

// ---------------------------------------------------------------------------------------
// PERCEPTION: camera, frames and the vision pipeline
// ---------------------------------------------------------------------------------------

export type CameraStatus = 'off' | 'starting' | 'ok' | 'stalled' | 'error';

export type CameraErrorCode =
  'permission_denied' | 'blocked_by_system' | 'not_found' | 'in_use' | 'unsupported' | 'unknown';

/** Identifies the camera a profile was calibrated with (hash only, never the raw label). */
export interface CameraIdentity {
  /** `sha256:<64 hex>` of `label|WxH`. */
  key: string;
  /** width / height of the analysed frames. */
  aspect: number;
}

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export interface OpenCameraOptions {
  deviceId?: string | null;
  /** Ideal capture size; defaults 320×240 at 5 fps (max 10). */
  width?: number;
  height?: number;
  frameRate?: number;
}

/**
 * A camera frame owned by the loop. The loop calls `close()` exactly once, in a `finally`.
 * `source` is the browser pixel source (ImageBitmap, VideoFrame or HTMLVideoElement),
 * opaque here so this file stays DOM-free; it is never stored, copied or sent anywhere.
 */
export interface AnalysisFrame {
  readonly t: MonoMs;
  readonly width: number;
  readonly height: number;
  readonly source: unknown;
  close(): void;
}

export interface FrameSource {
  readonly status: CameraStatus;
  readonly width: number;
  readonly height: number;
  /** Newest frame, or `null` when the camera delivered nothing new (stalled, ended). */
  next(): Promise<AnalysisFrame | null>;
  identity(): Promise<CameraIdentity>;
  /** Stops every track (the camera light goes off). Idempotent. */
  stop(): void;
}

export interface ModelManifestEntry {
  id: 'face' | 'objects';
  name: string;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  license: 'Apache-2.0';
}

/** A model given by local URL (the app's asset scheme, or loopback in dev) or by bytes. */
export type ModelSource = { url: string } | { bytes: Uint8Array };

export interface VisionAssets {
  /** Folder holding vision_wasm_internal.{js,wasm}, without a trailing slash. */
  wasmBaseUrl: string;
  faceModel: ModelSource;
  objectModel: ModelSource;
}

export type VisionErrorCode =
  'simd_unsupported' | 'asset_rejected' | 'hash_mismatch' | 'load_failed' | 'process_failed';

export interface VisionPipelineOptions {
  /** 2 (default) so a person behind the user never replaces them. */
  numFaces?: 1 | 2;
  /** Brighten dark frames before inference (default true). */
  lowLightBoost?: boolean;
}

export interface VisionFrameOptions {
  /** Run the object detector on this frame. */
  objects: boolean;
  /** Sample the luma thumbnail on this frame. */
  luma: boolean;
}

export interface VisionCost {
  faceMs: number;
  objectMs: number;
  lumaMs: number;
  totalMs: number;
}

export interface VisionResult {
  features: FrameFeatures;
  cost: VisionCost;
}

export interface VisionPipeline {
  /** Synchronous inference on one frame. Does not close the frame. */
  process(frame: AnalysisFrame, options: VisionFrameOptions): VisionResult;
  /** Clears trackers and held values (after a camera restart or a gap). */
  reset(): void;
  close(): void;
  /**
   * True once the WebGL context MediaPipe runs through was lost (GPU reset, resume from
   * sleep): `process` then throws a `VisionLoadError` with `contextLost: true` and the
   * pipeline must be rebuilt. Absent on pipelines without WebGL (test fakes).
   */
  readonly contextLost?: boolean;
}

// ---------------------------------------------------------------------------------------
// LEARNING: rows, classifier, calibration and profile
// ---------------------------------------------------------------------------------------

/** Version of the stored row layout (`FEATURE_ROW_COLUMNS`). */
export const FEATURE_SCHEMA = 1;

/**
 * Stored calibration row, schema 1: absolute values (not baseline-relative), quantised at
 * record time (angles 0.1°, the rest 0.001) so a JSON round trip is exact.
 */
export const FEATURE_ROW_COLUMNS = [
  'face',
  'yaw',
  'pitch',
  'roll',
  'cx',
  'cy',
  'w',
  'h',
  'truncated',
  'blink',
  'lookDown',
  'lookUp',
  'gazeX',
  'jawOpen',
  'phone',
  'phoneNear',
  'phoneMoving',
  'book',
  'person',
  'lumaMean',
  'lumaStd',
  'quality',
] as const;
export type FeatureRowColumn = (typeof FEATURE_ROW_COLUMNS)[number];
export type FeatureRow = readonly number[];

/** Head pose and box relative to the user's screen baseline. */
export interface RelativePose {
  dyaw: number;
  dpitch: number;
  droll: number;
  /** (cx − cx0) / w0 */
  dcx: number;
  /** (cy − cy0) / h0 */
  dcy: number;
  /** ln(h / h0) */
  logScale: number;
}

export interface EyeModel {
  /** False with glasses glare or unstable blink values: drowsiness detection is then off. */
  reliable: boolean;
  /** blink ≈ a + b·dpitch on study frames (reading lowers the eyelids). */
  blinkFit: readonly [number, number];
  /** Closed when blink − fit > this. */
  closedDelta: number;
}

export interface ClassifierThresholds {
  /** Phone score that counts as a phone (0.45–0.8; absorbs a calculator seen in calibration). */
  phone: number;
  /** Person score that counts as someone there (0.4–0.8; from the «no estoy» clip). */
  person: number;
}

export interface ClassifierObserveHint {
  inputActive: boolean;
  distraction: boolean;
  phone: boolean;
  /**
   * Keyboard/mouse idle time of this tick (`null`: unknown). The generic classifier learns a
   * screen direction only from fresh input (< 2 s); without the field it uses `inputActive`.
   */
  idleMs?: number | null;
}

export type ClassifierKind = 'personal' | 'generic';

export interface AttentionClassifier {
  readonly kind: ClassifierKind;
  /** Generic: false until its session baseline is known. Personal: always true. */
  readonly ready: boolean;
  readonly thresholds: Readonly<ClassifierThresholds>;
  /** π: P(truly studying | predicted class), from cross-validation (0–0.8). */
  readonly trust: Readonly<{ phone: number; away: number }>;
  readonly eyes: Readonly<EyeModel>;
  /** Probabilities for a frame with a face or a visible person; `null` for an empty frame. */
  predict(frame: FrameFeatures): ClassProbabilities | null;
  /** Pose relative to the screen baseline; `null` before a baseline exists. */
  relativePose(face: FaceFeatures): RelativePose | null;
  /** Generic: learns its baseline. Personal: slow in-memory baseline drift (±10°, τ 10 min). */
  observe(frame: FrameFeatures, hint: ClassifierObserveHint): void;
}

export type CalibrationIssueCode =
  | 'missing'
  | 'too_short'
  | 'no_face'
  | 'too_dark'
  | 'covered'
  | 'still_visible'
  | 'phone_not_seen'
  | 'same_as_screen'
  | 'unstable'
  | 'weak_separation';

export interface CalibrationIssue {
  code: CalibrationIssueCode;
  cls: CalibrationClass | null;
  severity: 'error' | 'warning';
  /** `weak_separation`: the two classes the model confuses. */
  pair?: readonly [CalibrationClass, CalibrationClass];
}

export interface CalibrationRecorderOptions {
  /** Default 20 000. */
  durationMs?: number;
  /** Discarded start while the user settles, default 2 000. */
  settleMs?: number;
  /** Discarded end, default 1 000. */
  tailMs?: number;
  /** Row cap per clip, default 80. */
  maxRows?: number;
}

export interface CalibrationProgress {
  cls: CalibrationClass;
  phase: 'settling' | 'recording' | 'done';
  elapsedMs: number;
  remainingMs: number;
  frames: number;
  faceRatio: number;
  /** Issues visible so far (e.g. `no_face`) so the wizard can say so before the end. */
  liveIssues: readonly CalibrationIssueCode[];
}

export interface SituationRecording {
  cls: CalibrationClass;
  startedAt: MonoMs;
  durationMs: number;
  rows: readonly FeatureRow[];
  faceRatio: number;
  personRatio: number;
  issues: readonly CalibrationIssue[];
}

export interface BuildProfileInput {
  recordings: Readonly<Partial<Record<CalibrationClass, SituationRecording>>>;
  /** Re-recording one situation keeps the others (and the feedback rows) from here. */
  previous: CalibrationProfile | null;
  camera: CameraIdentity;
  nowIso: IsoUtc;
}

export interface CalibrationReport {
  /** Blocked 4-fold CV, study vs not-study, balanced accuracy 0–1. */
  cvBinaryBalancedAccuracy: number;
  recall: Readonly<Record<CalibrationClass, number | null>>;
  /** confusion[true][predicted], in `CALIBRATION_CLASSES` order, out-of-fold counts. */
  confusion: readonly (readonly number[])[];
  /** Usable but with `weak_separation`. */
  weak: boolean;
}

export type BuildProfileResult =
  | {
      ok: true;
      profile: CalibrationProfile;
      report: CalibrationReport;
      issues: readonly CalibrationIssue[];
    }
  | { ok: false; issues: readonly CalibrationIssue[] };

export interface SoftmaxModelData {
  kind: 'softmax-l2';
  lambda: number;
  /** Robust standardisation of the classifier vector. */
  center: readonly number[];
  scale: readonly number[];
  /** RBF anchors over (dyaw, dpitch, gazeX), K ≤ 4. */
  anchors: readonly (readonly number[])[];
  sigma: number;
  /** K × D weights, `CALIBRATION_CLASSES` order. */
  W: readonly (readonly number[])[];
  b: readonly number[];
}

export interface ScreenBaseline {
  yaw: number;
  pitch: number;
  roll: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface ProfileClipInfo {
  recordedAt: IsoUtc;
  rows: number;
  faceRatio: number;
}

/** `profile.json` (userData/study-ai/), written atomically by main. Numbers only. */
export interface CalibrationProfile {
  format: 'centrate-study-ai-profile';
  version: 1;
  featureSchema: typeof FEATURE_SCHEMA;
  /** Trainer version; a mismatch retrains from `samples` on load. */
  trainer: number;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
  camera: CameraIdentity;
  clips: Readonly<Record<CalibrationClass, ProfileClipInfo | null>>;
  baseline: ScreenBaseline;
  thresholds: ClassifierThresholds;
  eyes: EyeModel;
  /** Parallel arrays: class index, source (0 calibration, 1 feedback) and the row. */
  samples: {
    cls: readonly number[];
    src: readonly number[];
    rows: readonly FeatureRow[];
  };
  model: SoftmaxModelData;
  trust: { phone: number; away: number };
  report: CalibrationReport;
}

export type ParseProfileError =
  'syntax' | 'format' | 'version' | 'schema' | 'too_large' | 'non_finite';

export type ParseProfileResult =
  | { ok: true; profile: CalibrationProfile; migrated: boolean }
  | { ok: false; error: ParseProfileError };

export interface TrainReport {
  iterations: number;
  loss: number;
  /** Rows used, by source. */
  rows: { calibration: number; feedback: number };
  ms: number;
}

// ---------------------------------------------------------------------------------------
// DECISION: context, observations, engine
// ---------------------------------------------------------------------------------------

export const FOREGROUND_CLASSES = ['study', 'neutral', 'distraction', 'unknown'] as const;
/** Foreground app/web as the desktop's active-window layer classifies it. */
export type ForegroundClass = (typeof FOREGROUND_CLASSES)[number];

export interface ContextSignals {
  foreground: ForegroundClass;
  /** `powerMonitor.getSystemIdleTime()` × 1000; `null` when unknown. */
  idleMs: number | null;
}

/** What main sends to the analysis window every second. */
export interface ContextInput extends ContextSignals {
  /** Guardian-computed phase of the session. */
  phase: StudyPhase;
}

export interface TickInput {
  now: MonoMs;
  phase: StudyPhase;
  context: ContextSignals;
  camera: CameraStatus;
  /** `null`: no frame this tick (break, no-camera mode, stalled camera). */
  frame: FrameFeatures | null;
}

export const PRESENCES = [
  'visible',
  'hidden',
  'absent',
  'covered',
  'camera_lost',
  'no_camera',
] as const;
/**
 * - `visible`: a face.
 * - `hidden`: no face but a person (or motion where the face was): head down writing, turned.
 * - `absent`: nobody. `covered`: the lens is covered (counts as absent whatever the input).
 * - `camera_lost`: the camera stalled or failed (absent after 10 s: fails closed).
 * - `no_camera`: no-camera mode.
 */
export type Presence = (typeof PRESENCES)[number];

export const LOW_CAUSES = ['phone', 'distraction_app', 'looking_away', 'idle', 'unknown'] as const;
/** Why a frame scored low; the dominant cause over the low period picks the strike cause. */
export type LowCause = (typeof LOW_CAUSES)[number];

export const HINT_CODES = [
  'low_light',
  'camera_covered',
  'camera_cant_see_you',
  'camera_lost',
  'recalibrate',
  'over_budget',
  'throttled',
  'vision_failed',
] as const;
/** Conditions the UI explains; codes only (strings live in the desktop i18n). */
export type HintCode = (typeof HINT_CODES)[number];

export interface ObservationEvidence {
  /** Phone in hand, persistent (≥ 60 % of detector runs in 5 s). Overrides every floor. */
  phone: boolean;
  /** Book seen, persistent (≥ 50 % of runs in 6 s). Only ever raises the score. */
  book: boolean;
  /** Head or eyes down (writing, reading) and not turned. Never punished without a phone. */
  lookingDown: boolean;
  /** Foreground is a distraction for ≥ 5 s. */
  distractionApp: boolean;
  /** Keyboard or mouse used in the last 15 s. */
  inputActive: boolean;
}

/** One tick turned into numbers the state machine understands (camera or no-camera). */
export interface Observation {
  at: MonoMs;
  presence: Presence;
  /** Instant study value 0–1 pushed into the window; `null` keeps it out (absent, drowsy…). */
  study: number | null;
  /** Weight of this sample in the window, 0–1 (frame quality). */
  weight: number;
  /** Dominant reason when `study` is low; `null` otherwise. */
  cause: LowCause | null;
  evidence: ObservationEvidence;
  eyes: { closed: boolean; yawn: boolean };
  /** Conditions active on this tick; the engine debounces them into `hint` events. */
  hints: readonly HintCode[];
  /** Kept ≤ 90 s in memory for «¡Estaba estudiando!»; `null` in no-camera mode. */
  frame: FrameFeatures | null;
  rel: RelativePose | null;
}

/** Turns ticks into observations. DECISION implements the camera one, RUNTIME the other. */
export interface Observer {
  readonly mode: StudyMode;
  observe(input: TickInput, settings: Readonly<StudyAiSettings>): Observation;
  /** Re-scores a stored observation after the classifier changed (feedback retrain). */
  rescore(observation: Observation, settings: Readonly<StudyAiSettings>): number | null;
  /** Forgets temporal state (gap, break, camera restart). */
  reset(): void;
}

export const ATTENTION_STATES = [
  'warmup',
  'focused',
  'doubt',
  'away',
  'break',
  'paused',
  'ended',
] as const;
/**
 * ENFOCADO = `focused` (and `warmup`), DUDA = `doubt`, «No te veo» = `away`. The 60 s after
 * a strike is not a state: it is `graceLeftMs` > 0 while the state is `focused` or `away`.
 */
export type AttentionState = (typeof ATTENTION_STATES)[number];

export interface AttentionSnapshot {
  at: MonoMs;
  mode: StudyMode;
  state: AttentionState;
  /** Smoothed focus score 0–100 (integer); `null` in warm-up, breaks or without data. */
  score: number | null;
  /** Under the threshold with hysteresis. */
  low: boolean;
  /** Debounced presence. */
  presence: Presence;
  cause: LowCause | null;
  drowsy: boolean;
  classifier: ClassifierKind | null;
  graceLeftMs: number;
  /** Time until DUDA if it stays low, or `null`. */
  doubtInMs: number | null;
  /** Time until a strike on the doubt or absence path, or `null`. */
  strikeInMs: number | null;
  hints: readonly HintCode[];
}

/** Cumulative since the engine started; main sends deltas (robust to lost IPC). */
export interface AttentionTotals {
  focusedMs: number;
  /** `warning` events (doubt and absence). */
  warnings: number;
  strikesRequested: number;
  ticks: number;
  /** Work-phase time the engine observed. */
  workMs: number;
}

export type AttentionEvent =
  | { type: 'state'; at: MonoMs; from: AttentionState; to: AttentionState }
  /** Soft sound + «¿Sigues ahí?» (`doubt`) or «No te veo» (`absent`). Counts as a warning. */
  | { type: 'warning'; at: MonoMs; kind: 'doubt' | 'absent' }
  | { type: 'doubt_cleared'; at: MonoMs; by: 'score' | 'feedback' }
  /** Main POSTs `/strike` with idempotency key `<sessionId>:<runId>:<seq>`. */
  | { type: 'strike'; at: MonoMs; cause: StrikeCause; seq: number }
  /** Eyes closed for long or repeated yawns: suggest a break, never a strike. */
  | { type: 'suggest_break'; at: MonoMs; reason: 'eyes_closed' | 'yawning' }
  | { type: 'hint'; at: MonoMs; code: HintCode; active: boolean };

export interface TickOutput {
  snapshot: AttentionSnapshot;
  events: readonly AttentionEvent[];
  observation: Observation;
}

/** The guardian's answer to a strike, converted by main (display time → duration). */
export interface StrikeAck {
  seq: number;
  counted: boolean;
  reason: 'cooldown' | 'not_in_work_phase' | null;
  /** `cooldownUntil − now`, or `null`. Extends the grace when longer than ours. */
  cooldownLeftMs: number | null;
}

export interface AttentionEngineOptions {
  settings: Readonly<StudyAiSettings>;
  observer: Observer;
  startedAt: MonoMs;
}

export interface FeedbackFrame {
  frame: FrameFeatures;
  rel: RelativePose | null;
  book: boolean;
  lookingDown: boolean;
}

export interface FeedbackEpisode {
  ok: true;
  episodeId: number;
  trigger: 'doubt' | 'away' | 'strike';
  /** ≤ 30 evenly spaced usable frames (never absent, phone, covered or outside work). */
  frames: readonly FeedbackFrame[];
}

export type FeedbackRejectionReason =
  | 'no_episode'
  | 'already_used'
  | 'no_usable_frames'
  | 'no_camera'
  | 'limit_reached'
  | 'not_calibrated';

export interface FeedbackRejection {
  ok: false;
  reason: FeedbackRejectionReason;
}

export type FeedbackEpisodeResult = FeedbackEpisode | FeedbackRejection;

export type LearnFromFeedbackResult =
  | { ok: true; profile: CalibrationProfile; added: number; report: TrainReport }
  | { ok: false; reason: 'no_usable_frames' };

/** «¡Estaba estudiando!» as the UI sees it. Never refunds a strike. */
export type FeedbackOutcome =
  | { ok: true; added: number; doubtCleared: boolean }
  | { ok: false; reason: FeedbackRejectionReason };

export const TIMELINE_KINDS = [
  'focused',
  'low',
  'doubt',
  'away',
  'drowsy',
  'break',
  'paused',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** Relative to the session start; neighbours of the same kind merged, ≥ 5 s pieces. */
export interface TimelineSegment {
  startMs: number;
  endMs: number;
  kind: TimelineKind;
}

export interface TimelineMark {
  atMs: number;
  kind: 'warning' | 'strike' | 'suggest_break';
  cause: StrikeCause | null;
}

export interface SessionTimeline {
  durationMs: number;
  segments: readonly TimelineSegment[];
  marks: readonly TimelineMark[];
}

// ---------------------------------------------------------------------------------------
// RUNTIME: loop, CPU governor, session facade, IPC contract
// ---------------------------------------------------------------------------------------

export interface LoopLevel {
  intervalMs: number;
  /** Object detector every N face frames. */
  objectEvery: number;
}

export interface CpuBudget {
  /** Inference wall time / wall time, share of one core (0.08). */
  targetDuty: number;
  /** Process CPU % (of one core) above which the governor slows down, when measured (12). */
  processCpuLimitPct: number;
  /** Time under 0.75 × target before speeding up (10 000). */
  upHoldMs: number;
  /** A single step slower than this is ignored as an outlier (400). */
  outlierMs: number;
}

export interface StepCost {
  at: MonoMs;
  visionMs: number;
  objectMs: number;
  otherMs: number;
  ranObjects: boolean;
  faceSeen: boolean;
}

export interface LoopPlan {
  level: number;
  intervalMs: number;
  objectEvery: number;
  lumaEveryMs: number;
  overBudget: boolean;
}

export interface LoopStats {
  ticks: number;
  errors: number;
  fps: number;
  duty: number;
  processCpuPct: number | null;
  level: number;
  overBudget: boolean;
  /** Under 1 tick/s for 30 s while running (hidden-window throttling). */
  throttled: boolean;
  lastTickAt: MonoMs;
  maxGapMs: number;
}

/** Everything main needs, sent at 1 Hz. Totals are cumulative per `runId`. */
export interface SessionReport {
  /** Random per analysis run; a new id means the totals restarted from zero. */
  runId: string;
  at: MonoMs;
  mode: StudyMode;
  camera: CameraStatus;
  /** Camera track live and being analysed (false in breaks once the camera is off). */
  cameraOn: boolean;
  snapshot: AttentionSnapshot;
  totals: AttentionTotals;
  loop: LoopStats | null;
}

export type SessionEvent =
  | AttentionEvent
  /** Main persists `profileJson` atomically (debounced). */
  | { type: 'profile_updated'; at: MonoMs; profileJson: string; reason: 'feedback' | 'migrated' }
  | { type: 'camera'; at: MonoMs; status: CameraStatus; error: CameraErrorCode | null }
  | { type: 'mode'; at: MonoMs; mode: StudyMode; reason: 'user' | 'vision_failed' };

/** Local summary for the «Resumen» timeline (the guardian owns points and the outcome). */
export interface SessionLocalSummary {
  totals: AttentionTotals;
  timeline: SessionTimeline;
}

export interface SessionDeps {
  clock: Clock;
  timers: TimerApi;
  createVision(assets: VisionAssets, options?: VisionPipelineOptions): Promise<VisionPipeline>;
  openCamera(options: OpenCameraOptions): Promise<FrameSource>;
  /** Process CPU % of one core (e.g. `process.getCPUUsage()` via the preload), or `null`. */
  cpuProbe: (() => number | null) | null;
  nowIso(): IsoUtc;
  randomId(): string;
}

export interface StudySessionOptions {
  mode: StudyMode;
  settings?: Partial<StudyAiSettings>;
  profileJson: string | null;
  /** Required in camera mode. */
  assets: VisionAssets | null;
  cameraDeviceId?: string | null;
  initialContext?: ContextInput;
  onEvent(event: SessionEvent): void;
  onReport(report: SessionReport): void;
  deps?: Partial<SessionDeps>;
}

export interface StudySessionHandle {
  setContext(context: ContextInput): void;
  setSettings(settings: Partial<StudyAiSettings>): void;
  strikeResult(ack: StrikeAck): void;
  /** «¡Estaba estudiando!»: adds the moment as examples and retrains. */
  studyingFeedback(): FeedbackOutcome;
  /** Offered after the camera fails; returns false when not allowed right now. */
  continueWithoutCamera(): boolean;
  /** After `powerMonitor` resume: gap reset, camera re-check. */
  resume(): void;
  report(): SessionReport;
  stop(): Promise<SessionLocalSummary>;
}

export interface CalibrationSessionOptions {
  assets: VisionAssets;
  profileJson: string | null;
  cameraDeviceId?: string | null;
  onProgress(progress: CalibrationProgress): void;
  deps?: Partial<SessionDeps>;
}

export interface CalibrationRecordingSummary {
  cls: CalibrationClass;
  rows: number;
  faceRatio: number;
  issues: readonly CalibrationIssue[];
}

export type CalibrationBuildOutcome =
  | {
      ok: true;
      profileJson: string;
      report: CalibrationReport;
      issues: readonly CalibrationIssue[];
    }
  | { ok: false; issues: readonly CalibrationIssue[] };

export interface CalibrationSessionHandle {
  /** Records one situation (~20 s at 4 fps); re-recording replaces it. */
  record(cls: CalibrationClass): Promise<CalibrationRecordingSummary>;
  /** Aborts the recording in progress (its promise rejects with `AbortError`). */
  cancel(): void;
  /** Trains a profile from the recordings (plus the previous profile's other clips). */
  build(): CalibrationBuildOutcome;
  close(): void;
}

/** main → hidden analysis window. */
export type AnalysisInbound =
  | {
      type: 'session_start';
      mode: StudyMode;
      settings: Partial<StudyAiSettings>;
      profileJson: string | null;
      cameraDeviceId: string | null;
      context: ContextInput;
    }
  | { type: 'context'; context: ContextInput }
  | { type: 'settings'; settings: Partial<StudyAiSettings> }
  | { type: 'strike_result'; ack: StrikeAck }
  | { type: 'studying_feedback' }
  | { type: 'continue_without_camera' }
  | { type: 'resume' }
  | { type: 'session_stop' }
  | { type: 'calibration_start'; profileJson: string | null; cameraDeviceId: string | null }
  | { type: 'calibration_record'; cls: CalibrationClass }
  | { type: 'calibration_cancel' }
  | { type: 'calibration_build' }
  | { type: 'calibration_close' };

export type AnalysisErrorCode =
  'busy' | 'not_running' | 'invalid_message' | 'camera_failed' | 'vision_failed';

/** hidden analysis window → main. Never carries pixels. */
export type AnalysisOutbound =
  | { type: 'event'; event: SessionEvent }
  | { type: 'report'; report: SessionReport }
  | { type: 'feedback_result'; outcome: FeedbackOutcome }
  | { type: 'session_stopped'; summary: SessionLocalSummary }
  | { type: 'calibration_progress'; progress: CalibrationProgress }
  | { type: 'calibration_recorded'; summary: CalibrationRecordingSummary }
  | { type: 'calibration_built'; outcome: CalibrationBuildOutcome }
  | { type: 'error'; code: AnalysisErrorCode; camera: CameraErrorCode | null };

export interface AnalysisHostOptions {
  post(message: AnalysisOutbound): void;
  assets: VisionAssets;
  deps?: Partial<SessionDeps>;
}

export interface AnalysisHost {
  handle(message: unknown): void;
  dispose(): Promise<void>;
}

/**
 * The heartbeat body main sends every 15 s: `HeartbeatRequest` of @centrate/shared without
 * `seq` (main adds it). Mirrored here so this file never pulls guardian-api into main's
 * pure typecheck; test/contracts.test.ts proves both stay identical.
 */
export interface HeartbeatBody {
  state: HeartbeatState;
  focusScore: number | null;
  /** 0–600 000. */
  focusedMsSinceLast: number;
  /** 0–100. */
  warningsSinceLast: number;
  cameraOn: boolean;
}

export interface HeartbeatAccumulatorOptions {
  /** No progress in `totals.ticks` for this long = dead loop, stop heartbeating (60 000). */
  deadAfterMs?: number;
}
