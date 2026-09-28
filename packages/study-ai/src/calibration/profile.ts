/**
 * Profile training, serialisation and strict parsing (owner: LEARNING). DESIGN.md §6.4–6.11.
 *
 * - `buildProfile`: clips (new recordings, or the previous profile's for the situations not
 *   re-recorded) → per-clip and cross-clip checks → baseline, thresholds, eyes → CV-trained
 *   softmax, trust and quality report. Re-recording one situation keeps the other clips and
 *   the feedback rows; «Recalibrar» (all five) passes `previous: null`: a clean slate.
 * - `serializeProfile`: canonical JSON (sorted keys, shortest exact numbers).
 * - `parseProfile`: strict validation, per-version migrations, and a retrain from `samples`
 *   when the profile was trained by another trainer version (then `migrated: true`).
 * The profile holds numbers, ISO dates and fixed strings only: never an image.
 */
import { MAX_ANCHORS, X_DIM, phiDim } from '../classifier/constants';
import { wrapDeg } from '../classifier/features';
import { COL, isValidRow } from '../classifier/rows';
import { CALIBRATION_CLASSES, FEATURE_SCHEMA } from '../types';
import type {
  BuildProfileInput,
  BuildProfileResult,
  CalibrationClass,
  CalibrationIssue,
  CalibrationProfile,
  CameraIdentity,
  FeatureRow,
  ParseProfileError,
  ParseProfileResult,
  ProfileClipInfo,
  ScreenBaseline,
} from '../types';
import { median } from '../util/math';
import {
  AWAY_MIN_DPITCH,
  AWAY_MIN_DYAW,
  CAMERA_ASPECT_TOLERANCE,
  CAMERA_KEY_RE,
  ISO_RE,
  MIN_CLIP_ROWS,
  PROFILE_FORMAT,
  PROFILE_MAX_BYTES,
  PROFILE_MAX_ROWS,
  PROFILE_VERSION,
} from './constants';
import { issue } from './recorder';
import { faceRows, learnEyes, learnThresholds, screenBaseline } from './stats';
import {
  CLASS_INDEX,
  K_CLASSES,
  SRC_CALIBRATION,
  SRC_FEEDBACK,
  trainFull,
  type SampleSet,
} from './train';

/** Current trainer version (`profile.trainer`); bump when training changes. */
export const PROFILE_TRAINER_VERSION = 1;

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

export function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

/** Rows of one class and source, in stored order. */
export function samplesOf(
  profile: Pick<CalibrationProfile, 'samples'>,
  cls: CalibrationClass,
  src: number,
): FeatureRow[] {
  const c = CLASS_INDEX[cls];
  const out: FeatureRow[] = [];
  profile.samples.rows.forEach((row, i) => {
    if (profile.samples.cls[i] === c && profile.samples.src[i] === src) out.push(row);
  });
  return out;
}

function dedupe(issues: readonly CalibrationIssue[]): CalibrationIssue[] {
  const seen = new Set<string>();
  const out: CalibrationIssue[] = [];
  for (const i of issues) {
    const key = `${i.code}|${i.cls ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

const hasError = (issues: readonly CalibrationIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/** `away` clip too close to the screen pose (§6.2). */
function awayLooksLikeScreen(awayRows: readonly FeatureRow[], base: ScreenBaseline): boolean {
  const rows = faceRows(awayRows);
  if (rows.length === 0) return false;
  const dyaw = median(
    Float64Array.from(rows, (r) => Math.abs(wrapDeg((r[COL.yaw] ?? 0) - base.yaw))),
  );
  const dpitch = median(Float64Array.from(rows, (r) => Math.abs((r[COL.pitch] ?? 0) - base.pitch)));
  return dyaw < AWAY_MIN_DYAW && dpitch < AWAY_MIN_DPITCH;
}

// ---------------------------------------------------------------------------------------
// buildProfile
// ---------------------------------------------------------------------------------------

/** Trains a profile: baseline, thresholds, eyes, CV-selected λ, trust and report. */
export function buildProfile(input: BuildProfileInput): BuildProfileResult {
  if (!isIsoUtc(input.nowIso)) throw new RangeError('buildProfile: nowIso must be an IsoUtc');
  const previous =
    input.previous &&
    input.previous.featureSchema === FEATURE_SCHEMA &&
    profileMatchesCamera(input.previous, input.camera)
      ? input.previous
      : null;

  const issues: CalibrationIssue[] = [];
  const calibration: Record<CalibrationClass, FeatureRow[]> = {
    screen: [],
    paper: [],
    phone: [],
    away: [],
    absent: [],
  };
  const clips = {} as Record<CalibrationClass, ProfileClipInfo | null>;

  for (const cls of CALIBRATION_CLASSES) {
    const rec = input.recordings[cls];
    if (rec && rec.cls === cls) {
      const rows = rec.rows.filter((r) => isValidRow(r)).map((r) => [...r]);
      calibration[cls] = rows;
      clips[cls] = { recordedAt: input.nowIso, rows: rows.length, faceRatio: rec.faceRatio };
      for (const i of rec.issues) issues.push({ ...i, cls: i.cls ?? cls });
      if (rows.length < MIN_CLIP_ROWS) issues.push(issue('too_short', cls));
    } else if (previous && previous.clips[cls]) {
      calibration[cls] = samplesOf(previous, cls, SRC_CALIBRATION).map((r) => [...r]);
      clips[cls] = { ...(previous.clips[cls] as ProfileClipInfo) };
    } else {
      clips[cls] = null;
      issues.push(issue('missing', cls));
    }
  }
  if (hasError(issues)) return { ok: false, issues: dedupe(issues) };

  const baseline = screenBaseline(calibration.screen);
  if (!baseline) return { ok: false, issues: dedupe([...issues, issue('no_face', 'screen')]) };
  // «Mirando a otro lado» must show a face turned away (the recorder flags it; crafted input too).
  if (faceRows(calibration.away).length === 0) issues.push(issue('no_face', 'away'));
  if (awayLooksLikeScreen(calibration.away, baseline)) issues.push(issue('same_as_screen', 'away'));
  if (hasError(issues)) return { ok: false, issues: dedupe(issues) };

  const thresholds = learnThresholds(
    [...calibration.screen, ...calibration.paper],
    calibration.absent,
  );
  const eyes = learnEyes(calibration.screen, calibration.paper, baseline);

  const cls: number[] = [];
  const src: number[] = [];
  const rows: FeatureRow[] = [];
  for (const c of CALIBRATION_CLASSES) {
    for (const row of calibration[c]) {
      cls.push(CLASS_INDEX[c]);
      src.push(SRC_CALIBRATION);
      rows.push(row);
    }
  }
  if (previous) {
    for (const c of CALIBRATION_CLASSES) {
      for (const row of samplesOf(previous, c, SRC_FEEDBACK)) {
        cls.push(CLASS_INDEX[c]);
        src.push(SRC_FEEDBACK);
        rows.push([...row]);
      }
    }
  }
  const samples: SampleSet = { cls, src, rows };
  const trained = trainFull(samples, baseline, thresholds);
  if (trained.pair) issues.push(issue('weak_separation', null, trained.pair));

  const profile: CalibrationProfile = {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    featureSchema: FEATURE_SCHEMA,
    trainer: PROFILE_TRAINER_VERSION,
    createdAt: previous ? previous.createdAt : input.nowIso,
    updatedAt: input.nowIso,
    camera: { key: input.camera.key, aspect: input.camera.aspect },
    clips,
    baseline,
    thresholds,
    eyes,
    samples: { cls, src, rows },
    model: trained.model,
    trust: trained.trust,
    report: trained.report,
  };
  return {
    ok: true,
    profile: canonicalProfile(profile),
    report: trained.report,
    issues: dedupe(issues),
  };
}

/**
 * The canonical, validated and deep-frozen form of a freshly built profile (what a JSON
 * round trip gives back). Throws on an internal inconsistency.
 */
export function canonicalProfile(profile: CalibrationProfile): CalibrationProfile {
  const parsed = parseProfile(serializeProfile(profile));
  if (!parsed.ok) throw new Error(`study-ai: built an invalid profile (${parsed.error})`);
  return parsed.profile;
}

// ---------------------------------------------------------------------------------------
// serializeProfile
// ---------------------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('serializeProfile: non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`serializeProfile: unsupported ${typeof value}`);
  }
}

/** Canonical JSON (stable key order, numbers only besides fixed strings). */
export function serializeProfile(profile: CalibrationProfile): string {
  return canonicalJson(profile);
}

// ---------------------------------------------------------------------------------------
// parseProfile
// ---------------------------------------------------------------------------------------

class Reject extends Error {
  constructor(readonly code: ParseProfileError) {
    super(code);
  }
}

const reject = (code: ParseProfileError = 'schema'): never => {
  throw new Reject(code);
};

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A plain object with exactly these keys. */
function exact(value: unknown, keys: readonly string[]): Raw {
  if (!isRecord(value)) return reject();
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(value, k))) reject();
  return value;
}

function num(value: unknown, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return reject();
  }
  return value;
}

function int(value: unknown, min: number, max: number): number {
  const v = num(value, min, max);
  if (!Number.isInteger(v)) reject();
  return v;
}

function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : reject();
}

function iso(value: unknown): string {
  return isIsoUtc(value) ? value : reject();
}

function list(value: unknown, length?: number): unknown[] {
  if (!Array.isArray(value)) return reject();
  if (length !== undefined && value.length !== length) reject();
  return value;
}

function nums(value: unknown, length?: number, min = -Infinity, max = Infinity): number[] {
  return list(value, length).map((v) => num(v, min, max));
}

function scanNonFinite(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('non_finite');
  } else if (Array.isArray(value)) {
    for (const v of value) scanNonFinite(v);
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) scanNonFinite(v);
  }
}

type Migration = (raw: Raw) => Raw;
/** Upgrades from older profile versions, keyed by the version they read. None yet. */
const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

const PROFILE_KEYS = [
  'format',
  'version',
  'featureSchema',
  'trainer',
  'createdAt',
  'updatedAt',
  'camera',
  'clips',
  'baseline',
  'thresholds',
  'eyes',
  'samples',
  'model',
  'trust',
  'report',
] as const;

function readCamera(value: unknown): CameraIdentity {
  const v = exact(value, ['key', 'aspect']);
  const key = typeof v.key === 'string' && CAMERA_KEY_RE.test(v.key) ? v.key : reject();
  return { key, aspect: num(v.aspect, 1e-3, 1e3) };
}

function readClips(value: unknown): Record<CalibrationClass, ProfileClipInfo | null> {
  const v = exact(value, CALIBRATION_CLASSES);
  const out = {} as Record<CalibrationClass, ProfileClipInfo | null>;
  for (const cls of CALIBRATION_CLASSES) {
    const clip = v[cls];
    if (clip === null) {
      out[cls] = null;
      continue;
    }
    const c = exact(clip, ['recordedAt', 'rows', 'faceRatio']);
    out[cls] = {
      recordedAt: iso(c.recordedAt),
      rows: int(c.rows, 0, PROFILE_MAX_ROWS),
      faceRatio: num(c.faceRatio, 0, 1),
    };
  }
  return out;
}

function readBaseline(value: unknown): ScreenBaseline {
  const v = exact(value, ['yaw', 'pitch', 'roll', 'cx', 'cy', 'w', 'h']);
  return {
    yaw: num(v.yaw, -180, 180),
    pitch: num(v.pitch, -180, 180),
    roll: num(v.roll, -180, 180),
    cx: num(v.cx),
    cy: num(v.cy),
    w: num(v.w, 1e-6),
    h: num(v.h, 1e-6),
  };
}

function readProfile(raw: Raw): CalibrationProfile {
  const v = exact(raw, PROFILE_KEYS);
  if (v.featureSchema !== FEATURE_SCHEMA) reject();
  const trainer = int(v.trainer, 1, 1_000_000);

  const t = exact(v.thresholds, ['phone', 'person']);
  const e = exact(v.eyes, ['reliable', 'blinkFit', 'closedDelta']);
  const blinkFit = nums(e.blinkFit, 2);

  const s = exact(v.samples, ['cls', 'src', 'rows']);
  const rowsRaw = list(s.rows);
  const n = rowsRaw.length;
  const cls = list(s.cls, n).map((c) => int(c, 0, K_CLASSES - 1));
  const src = list(s.src, n).map((c) => int(c, SRC_CALIBRATION, SRC_FEEDBACK));
  const rows = rowsRaw.map((r) => (isValidRow(r) ? [...r] : reject()));

  const m = exact(v.model, ['kind', 'lambda', 'center', 'scale', 'anchors', 'sigma', 'W', 'b']);
  if (m.kind !== 'softmax-l2') reject();
  const anchorsRaw = list(m.anchors);
  if (anchorsRaw.length > MAX_ANCHORS) reject();
  const anchors = anchorsRaw.map((a) => nums(a, 3));
  const d = phiDim(anchors.length);
  const W = list(m.W, K_CLASSES).map((row) => nums(row, d));

  const tr = exact(v.trust, ['phone', 'away']);
  const r = exact(v.report, ['cvBinaryBalancedAccuracy', 'recall', 'confusion', 'weak']);
  const recallRaw = exact(r.recall, CALIBRATION_CLASSES);
  const recall = {} as Record<CalibrationClass, number | null>;
  for (const c of CALIBRATION_CLASSES) {
    recall[c] = recallRaw[c] === null ? null : num(recallRaw[c], 0, 1);
  }

  const clips = readClips(v.clips);
  // Clip info must describe the stored calibration rows.
  CALIBRATION_CLASSES.forEach((c, index) => {
    let count = 0;
    for (let i = 0; i < n; i += 1) if (cls[i] === index && src[i] === SRC_CALIBRATION) count += 1;
    const clip = clips[c];
    if ((clip === null && count > 0) || (clip !== null && clip.rows !== count)) reject();
  });

  return {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    featureSchema: FEATURE_SCHEMA,
    trainer,
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
    camera: readCamera(v.camera),
    clips,
    baseline: readBaseline(v.baseline),
    thresholds: { phone: num(t.phone, 0, 1), person: num(t.person, 0, 1) },
    eyes: {
      reliable: bool(e.reliable),
      blinkFit: [blinkFit[0] as number, blinkFit[1] as number],
      closedDelta: num(e.closedDelta, 1e-6, 1),
    },
    samples: { cls, src, rows },
    model: {
      kind: 'softmax-l2',
      lambda: num(m.lambda, 1e-12, 1e3),
      center: nums(m.center, X_DIM),
      scale: nums(m.scale, X_DIM, 1e-9),
      anchors,
      sigma: num(m.sigma, 1e-6),
      W,
      b: nums(m.b, K_CLASSES),
    },
    trust: { phone: num(tr.phone, 0, 1), away: num(tr.away, 0, 1) },
    report: {
      cvBinaryBalancedAccuracy: num(r.cvBinaryBalancedAccuracy, 0, 1),
      recall,
      confusion: list(r.confusion, K_CLASSES).map((row) =>
        list(row, K_CLASSES).map((c) => int(c, 0, PROFILE_MAX_ROWS)),
      ),
      weak: bool(r.weak),
    },
  };
}

/**
 * Strict: ≤ 512 KB, ≤ 5 000 rows, finite numbers, no unknown keys, known version.
 * A profile trained by another trainer version is retrained from its samples here and
 * comes back with `migrated: true` (the facade persists it); if that retrain fails, the
 * error is `version` and the UI asks to recalibrate.
 */
export function parseProfile(json: string): ParseProfileResult {
  if (typeof json !== 'string') return { ok: false, error: 'syntax' };
  if (json.length > PROFILE_MAX_BYTES) return { ok: false, error: 'too_large' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'syntax' };
  }
  try {
    if (!isRecord(raw) || raw.format !== PROFILE_FORMAT) return { ok: false, error: 'format' };
    let current: Raw = raw;
    let migrated = false;
    for (let hops = 0; current.version !== PROFILE_VERSION; hops += 1) {
      const version = current.version;
      const migrate = typeof version === 'number' ? MIGRATIONS[version] : undefined;
      if (!migrate || hops > 16) return { ok: false, error: 'version' };
      current = migrate(current);
      migrated = true;
    }
    scanNonFinite(current);
    const samples = current.samples;
    if (
      isRecord(samples) &&
      Array.isArray(samples.rows) &&
      samples.rows.length > PROFILE_MAX_ROWS
    ) {
      return { ok: false, error: 'too_large' };
    }
    const profile = readProfile(current);
    if (profile.trainer !== PROFILE_TRAINER_VERSION) {
      const rebuilt = buildProfile({
        recordings: {},
        previous: profile,
        camera: profile.camera,
        nowIso: profile.updatedAt,
      });
      if (!rebuilt.ok) return { ok: false, error: 'version' };
      return { ok: true, profile: rebuilt.profile, migrated: true };
    }
    return { ok: true, profile: deepFreeze(profile), migrated };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, error: error.code };
    throw error;
  }
}

/** Same camera key (the aspect may differ by ≤ 2 %). */
export function profileMatchesCamera(profile: CalibrationProfile, camera: CameraIdentity): boolean {
  const a = profile.camera.aspect;
  const b = camera.aspect;
  if (profile.camera.key !== camera.key) return false;
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a / b - 1) <= CAMERA_ASPECT_TOLERANCE;
}
