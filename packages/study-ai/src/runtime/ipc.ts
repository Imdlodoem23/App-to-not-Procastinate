/**
 * Strict guards for the main ↔ analysis-window messages (owner: RUNTIME). Pure.
 * DESIGN.md §8.6.
 *
 * Every message is a plain object with exactly the keys of its `type`, finite numbers, known
 * enum values and capped strings/arrays (`profileJson` ≤ 512 KB). Both sides validate: the
 * analysis window checks `AnalysisInbound`, Electron main checks `AnalysisOutbound`.
 *
 * A profile going to main (`profile_updated`, `calibration_built`) must also be the canonical
 * serialisation of a strictly valid profile of the current format, version and trainer
 * (`canonicalProfileJson`): main writes it to disk as is, so the file can only ever hold
 * calibration numbers, whatever the renderer sends.
 */
import { PROFILE_FORMAT, PROFILE_MAX_BYTES, PROFILE_VERSION } from '../calibration/constants';
import { PROFILE_TRAINER_VERSION, parseProfile, serializeProfile } from '../calibration/profile';
import {
  ATTENTION_STATES,
  CALIBRATION_CLASSES,
  FOREGROUND_CLASSES,
  HINT_CODES,
  LOW_CAUSES,
  PRESENCES,
  TIMELINE_KINDS,
} from '../types';
import type {
  AnalysisInbound,
  AnalysisOutbound,
  CameraErrorCode,
  CameraStatus,
  CalibrationIssueCode,
  FeedbackRejectionReason,
  AnalysisErrorCode,
  StrikeCause,
  StudyMode,
  StudyPhase,
} from '../types';
import {
  array,
  bool,
  exact,
  int,
  isPlainObject,
  literal,
  nullable,
  num,
  oneOf,
  optional,
  str,
  tagged,
  tuple,
  type Check,
} from './validate';

// ---------------------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------------------

/**
 * Spells a string union out as a value list; compiles only when the list has every member
 * of `Union` (and, through the parameter type, nothing else).
 */
function vocabulary<Union extends string>() {
  return <const List extends readonly Union[]>(
    list: List & ([Union] extends [List[number]] ? unknown : never),
  ): List => list;
}

/** From @centrate/shared/domain, which this package may import as types only. */
const STUDY_PHASES = vocabulary<StudyPhase>()(['work', 'break', 'paused', 'ended']);
const STRIKE_CAUSES = vocabulary<StrikeCause>()([
  'doubt_timeout',
  'no_face',
  'phone',
  'distraction_app',
]);
const STUDY_MODES = vocabulary<StudyMode>()(['camera', 'no-camera']);
const CAMERA_STATUSES = vocabulary<CameraStatus>()(['off', 'starting', 'ok', 'stalled', 'error']);
const CAMERA_ERROR_CODES = vocabulary<CameraErrorCode>()([
  'permission_denied',
  'blocked_by_system',
  'not_found',
  'in_use',
  'unsupported',
  'unknown',
]);
const CALIBRATION_ISSUE_CODES = vocabulary<CalibrationIssueCode>()([
  'missing',
  'too_short',
  'no_face',
  'too_dark',
  'covered',
  'still_visible',
  'phone_not_seen',
  'same_as_screen',
  'unstable',
  'narrow_gaze',
  'weak_separation',
]);
const FEEDBACK_REJECTIONS = vocabulary<FeedbackRejectionReason>()([
  'no_episode',
  'already_used',
  'no_usable_frames',
  'no_camera',
  'limit_reached',
  'not_calibrated',
]);
const ANALYSIS_ERROR_CODES = vocabulary<AnalysisErrorCode>()([
  'busy',
  'not_running',
  'invalid_message',
  'camera_failed',
  'vision_failed',
]);

/** Caps: generous for real data, small enough that a bad message cannot hog memory. */
const MAX_CAMERA_LABEL = 256;
const MAX_CAMERAS = 32;
const MAX_RUN_ID = 128;
const MAX_TIMELINE_ITEMS = 20_000;
const MAX_ISSUES = 64;
const MAX_HINTS = HINT_CODES.length;

// ---------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------

const time = num(0);
const duration = num(0);
const count = int(0);
const ratio = num(0, 1);
/** Main → window: the stored profile; the window parses it (and may migrate it) itself. */
const profileJson = str(PROFILE_MAX_BYTES);

/** The last profile string that passed (a pure check: it stays valid). */
let lastCanonicalProfile: string | null = null;

/**
 * Window → main: the canonical JSON of a strictly valid profile of the current format,
 * version and trainer (fixed keys, finite numbers, ISO dates and the camera hash only), so
 * main can write it to `profile.json` as is.
 *
 * It never retrains: a profile of another version or trainer is refused before the full
 * parse (`parseProfile` would retrain it, seconds of CPU on main's thread). The window only
 * sends profiles it has just serialised, so a genuine one always passes.
 */
export function canonicalProfileJson(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > PROFILE_MAX_BYTES) return false;
  if (value === lastCanonicalProfile) return true;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    !isPlainObject(raw) ||
    raw.format !== PROFILE_FORMAT ||
    raw.version !== PROFILE_VERSION ||
    raw.trainer !== PROFILE_TRAINER_VERSION
  ) {
    return false;
  }
  try {
    const parsed = parseProfile(value);
    if (!parsed.ok || parsed.migrated || serializeProfile(parsed.profile) !== value) return false;
  } catch {
    return false;
  }
  lastCanonicalProfile = value;
  return true;
}
const outboundProfileJson: Check = canonicalProfileJson;
const studyMode = oneOf(STUDY_MODES);
const calibrationClass = oneOf(CALIBRATION_CLASSES);
const cameraStatus = oneOf(CAMERA_STATUSES);
const cameraError = oneOf(CAMERA_ERROR_CODES);

const settings: Check = exact({
  doubtAfterMs: optional(num()),
  strikeAfterDoubtMs: optional(num()),
  noFaceStrikeMs: optional(num()),
  focusScoreThreshold: optional(num()),
  focusWindowMs: optional(num()),
  noCameraIdleMs: optional(num()),
});

const context: Check = exact({
  phase: oneOf(STUDY_PHASES),
  foreground: oneOf(FOREGROUND_CLASSES),
  idleMs: nullable(duration),
  visibleDistraction: optional(bool),
});

/** A camera label (never a `deviceId`: those are salted per partition and run). */
const cameraLabel = nullable(str(MAX_CAMERA_LABEL));

const strikeAck: Check = exact({
  seq: int(1),
  counted: bool,
  reason: literal('cooldown', 'not_in_work_phase', null),
  cooldownLeftMs: nullable(duration),
});

const empty = (type: string): Check => exact({ type: literal(type) });

// ---------------------------------------------------------------------------------------
// Inbound (main → analysis window)
// ---------------------------------------------------------------------------------------

const inbound: Check = tagged({
  session_start: exact({
    type: literal('session_start'),
    mode: studyMode,
    settings,
    profileJson: nullable(profileJson),
    cameraLabel,
    context,
  }),
  context: exact({ type: literal('context'), context }),
  settings: exact({ type: literal('settings'), settings }),
  strike_result: exact({ type: literal('strike_result'), ack: strikeAck }),
  studying_feedback: empty('studying_feedback'),
  continue_without_camera: empty('continue_without_camera'),
  resume: empty('resume'),
  session_stop: empty('session_stop'),
  calibration_start: exact({
    type: literal('calibration_start'),
    profileJson: nullable(profileJson),
    cameraLabel,
  }),
  calibration_record: exact({ type: literal('calibration_record'), cls: calibrationClass }),
  calibration_cancel: empty('calibration_cancel'),
  calibration_build: empty('calibration_build'),
  calibration_close: empty('calibration_close'),
  list_cameras: empty('list_cameras'),
});

// ---------------------------------------------------------------------------------------
// Outbound (analysis window → main)
// ---------------------------------------------------------------------------------------

const attentionState = oneOf(ATTENTION_STATES);

const attentionEvent: Record<string, Check> = {
  state: exact({ type: literal('state'), at: time, from: attentionState, to: attentionState }),
  warning: exact({ type: literal('warning'), at: time, kind: literal('doubt', 'absent') }),
  doubt_cleared: exact({
    type: literal('doubt_cleared'),
    at: time,
    by: literal('score', 'feedback'),
  }),
  strike: exact({
    type: literal('strike'),
    at: time,
    cause: oneOf(STRIKE_CAUSES),
    seq: int(1),
  }),
  suggest_break: exact({
    type: literal('suggest_break'),
    at: time,
    reason: literal('eyes_closed', 'yawning'),
  }),
  hint: exact({ type: literal('hint'), at: time, code: oneOf(HINT_CODES), active: bool }),
};

const sessionEvent: Check = tagged({
  ...attentionEvent,
  profile_updated: exact({
    type: literal('profile_updated'),
    at: time,
    profileJson: outboundProfileJson,
    reason: literal('feedback', 'migrated'),
  }),
  camera: exact({
    type: literal('camera'),
    at: time,
    status: cameraStatus,
    error: nullable(cameraError),
  }),
  // `recovered` is the way back to camera mode; `user` and `vision_failed` lead away from it.
  mode: (value) =>
    exact({
      type: literal('mode'),
      at: time,
      mode: studyMode,
      reason: literal('user', 'vision_failed', 'recovered'),
    })(value) &&
    ((value as { mode: unknown }).mode === 'camera') ===
      ((value as { reason: unknown }).reason === 'recovered'),
});

const snapshot: Check = exact({
  at: time,
  mode: studyMode,
  state: attentionState,
  score: nullable(int(0, 100)),
  low: bool,
  presence: oneOf(PRESENCES),
  cause: nullable(oneOf(LOW_CAUSES)),
  drowsy: bool,
  classifier: nullable(literal('personal', 'generic')),
  graceLeftMs: duration,
  doubtInMs: nullable(duration),
  strikeInMs: nullable(duration),
  hints: array(oneOf(HINT_CODES), MAX_HINTS),
});

const totals: Check = exact({
  focusedMs: duration,
  warnings: count,
  strikesRequested: count,
  ticks: count,
  workMs: duration,
});

const loopStats: Check = exact({
  ticks: count,
  errors: count,
  fps: num(0, 1_000),
  duty: num(0),
  processCpuPct: nullable(num(0)),
  level: count,
  overBudget: bool,
  throttled: bool,
  lastTickAt: time,
  maxGapMs: duration,
});

const report: Check = exact({
  runId: str(MAX_RUN_ID, /^[A-Za-z0-9_-]+$/),
  at: time,
  mode: studyMode,
  camera: cameraStatus,
  cameraOn: bool,
  snapshot,
  totals,
  loop: nullable(loopStats),
});

/** `tagged` needs a string tag: map `ok: boolean` onto it. */
function okUnion(ok: Check, notOk: Check): Check {
  return (value) => {
    if (typeof value !== 'object' || value === null) return false;
    const flag = (value as { ok?: unknown }).ok;
    return flag === true ? ok(value) : flag === false ? notOk(value) : false;
  };
}
const outcome: Check = okUnion(
  exact({ ok: literal(true), added: count, doubtCleared: bool }),
  exact({ ok: literal(false), reason: oneOf(FEEDBACK_REJECTIONS) }),
);

const timeline: Check = exact({
  durationMs: duration,
  segments: array(
    exact({ startMs: duration, endMs: duration, kind: oneOf(TIMELINE_KINDS) }),
    MAX_TIMELINE_ITEMS,
  ),
  marks: array(
    exact({
      atMs: duration,
      kind: literal('warning', 'strike', 'suggest_break'),
      cause: nullable(oneOf(STRIKE_CAUSES)),
    }),
    MAX_TIMELINE_ITEMS,
  ),
});

const issue: Check = exact({
  code: oneOf(CALIBRATION_ISSUE_CODES),
  cls: nullable(calibrationClass),
  severity: literal('error', 'warning'),
  pair: optional(tuple(calibrationClass, calibrationClass)),
});
const issues = array(issue, MAX_ISSUES);

const progress: Check = exact({
  cls: calibrationClass,
  phase: literal('settling', 'recording', 'done'),
  elapsedMs: duration,
  remainingMs: duration,
  frames: count,
  faceRatio: ratio,
  liveIssues: array(oneOf(CALIBRATION_ISSUE_CODES), MAX_ISSUES),
});

const recall: Check = exact(
  Object.fromEntries(CALIBRATION_CLASSES.map((c) => [c, nullable(ratio)])),
);
const K = CALIBRATION_CLASSES.length;
const calibrationReport: Check = exact({
  cvBinaryBalancedAccuracy: ratio,
  recall,
  confusion: array(array(num(0), K, K), K, K),
  weak: bool,
});

const buildOutcome: Check = okUnion(
  exact({ ok: literal(true), profileJson: outboundProfileJson, report: calibrationReport, issues }),
  exact({ ok: literal(false), issues }),
);

const outbound: Check = tagged({
  event: exact({ type: literal('event'), event: sessionEvent }),
  report: exact({ type: literal('report'), report }),
  feedback_result: exact({ type: literal('feedback_result'), outcome }),
  session_stopped: exact({
    type: literal('session_stopped'),
    summary: exact({ totals, timeline }),
  }),
  calibration_progress: exact({ type: literal('calibration_progress'), progress }),
  calibration_recorded: exact({
    type: literal('calibration_recorded'),
    summary: exact({ cls: calibrationClass, rows: count, faceRatio: ratio, issues }),
  }),
  calibration_built: exact({ type: literal('calibration_built'), outcome: buildOutcome }),
  cameras: exact({
    type: literal('cameras'),
    cameras: array(exact({ label: str(MAX_CAMERA_LABEL) }), MAX_CAMERAS),
  }),
  error: exact({
    type: literal('error'),
    code: oneOf(ANALYSIS_ERROR_CODES),
    camera: nullable(cameraError),
  }),
});

export function isAnalysisInbound(value: unknown): value is AnalysisInbound {
  return inbound(value);
}

export function isAnalysisOutbound(value: unknown): value is AnalysisOutbound {
  return outbound(value);
}
