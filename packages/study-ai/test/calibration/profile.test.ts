/** Profile building, canonical serialisation and strict parsing (DESIGN.md §6.4, §6.11). */
import { describe, expect, it } from 'vitest';
import {
  PROFILE_TRAINER_VERSION,
  buildProfile,
  parseProfile,
  profileMatchesCamera,
  serializeProfile,
} from '../../src/calibration/profile';
import { learnFromFeedback } from '../../src/calibration/feedback';
import { COL } from '../../src/classifier/rows';
import { CALIBRATION_CLASSES } from '../../src/types';
import type { CalibrationProfile, FeedbackEpisode, SituationRecording } from '../../src/types';
import { PERSONAS, calibrationFrames } from '../synth';
import {
  CAMERA,
  LATER,
  NOW,
  OTHER_CAMERA,
  cpuMs,
  face,
  frame,
  postureFrames,
  profileFor,
  record,
  recordAll,
} from './fixtures';

type Raw = Record<string, unknown>;

function mutate(profile: CalibrationProfile, change: (raw: Raw) => void): string {
  const raw = JSON.parse(serializeProfile(profile)) as Raw;
  change(raw);
  return JSON.stringify(raw);
}

const obj = (v: unknown): Raw => v as Raw;
const arr = (v: unknown): unknown[] => v as unknown[];

function episode(profile: CalibrationProfile, seed = 1): FeedbackEpisode {
  const frames = postureFrames(profile.baseline, 38, -8, 30, seed, 0.15).map((f) => ({
    frame: f,
    rel: null,
    book: false,
    lookingDown: false,
  }));
  return { ok: true, episodeId: seed, trigger: 'doubt', frames };
}

describe('buildProfile', () => {
  it.each(Object.keys(PERSONAS))('builds a usable profile for %s', (id) => {
    const profile = profileFor(id as keyof typeof PERSONAS);
    expect(profile.trainer).toBe(PROFILE_TRAINER_VERSION);
    expect(profile.report.cvBinaryBalancedAccuracy).toBeGreaterThan(0.85);
    expect(profile.report.weak).toBe(false);
    for (const cls of CALIBRATION_CLASSES) expect(profile.clips[cls]?.recordedAt).toBe(NOW);
  });

  it('reports per-class recall and an out-of-fold confusion matrix', () => {
    const result = buildProfile({
      recordings: recordAll(),
      previous: null,
      camera: CAMERA,
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { report } = result;
    expect(report.confusion).toHaveLength(5);
    const total = report.confusion.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(result.profile.samples.rows.length);
    for (const cls of ['screen', 'paper', 'away', 'absent'] as const) {
      expect(report.recall[cls]).toBeGreaterThan(0.9);
    }
    expect(result.issues).toEqual([]);
  });

  it('learns the screen baseline, the thresholds and the eye model', () => {
    const profile = profileFor('baseline');
    // Medians of ~70 frames with 3° pose noise.
    expect(Math.abs(profile.baseline.yaw)).toBeLessThan(1.5);
    expect(Math.abs(profile.baseline.pitch + 5)).toBeLessThan(1.5);
    expect(profile.baseline.h).toBeCloseTo(0.3, 1);
    expect(profile.thresholds).toEqual({ phone: 0.45, person: 0.4 });
    expect(profile.eyes.reliable).toBe(true);
    expect(profile.eyes.closedDelta).toBe(0.35);
    // Reading lowers the eyelids: blink rises as the head goes down.
    expect(profile.eyes.blinkFit[1]).toBeLessThan(0);
    // A calculator on the desk raises the phone threshold; glasses glare disables the eyes.
    expect(profileFor('calculator').thresholds.phone).toBeGreaterThan(0.6);
    expect(profileFor('glasses').eyes.reliable).toBe(false);
  });

  it('learns the person threshold from the «no estoy» clip (a coat on the chair)', () => {
    const recordings = recordAll();
    const coat = calibrationFrames('absent', { seed: 14 }).map((f) => ({
      ...f,
      objects: f.objects && {
        ...f.objects,
        person: { score: 0.55, box: { cx: 0.5, cy: 0.6, w: 0.5, h: 0.6 } },
      },
    }));
    const result = buildProfile({
      recordings: { ...recordings, absent: record('absent', coat) },
      previous: null,
      camera: CAMERA,
      nowIso: NOW,
    });
    expect(result.ok && result.profile.thresholds.person).toBeCloseTo(0.65, 5);
  });

  it('is deterministic', () => {
    const recordings = recordAll();
    const a = buildProfile({ recordings, previous: null, camera: CAMERA, nowIso: NOW });
    const b = buildProfile({ recordings, previous: null, camera: CAMERA, nowIso: NOW });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(serializeProfile(a.profile)).toBe(serializeProfile(b.profile));
  });

  it('fails with `missing` when a situation was never recorded', () => {
    const { phone: _phone, ...four } = recordAll();
    const result = buildProfile({ recordings: four, previous: null, camera: CAMERA, nowIso: NOW });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({ code: 'missing', cls: 'phone', severity: 'error' });
  });

  it('fails on a clip error and on `same_as_screen`', () => {
    const recordings = recordAll();
    const short: SituationRecording = {
      ...recordings.paper,
      rows: recordings.paper.rows.slice(0, 20),
    };
    const a = buildProfile({
      recordings: { ...recordings, paper: short },
      previous: null,
      camera: CAMERA,
      nowIso: NOW,
    });
    expect(a.ok).toBe(false);
    expect(a.issues.map((i) => i.code)).toContain('too_short');

    const lazyAway = record('away', calibrationFrames('screen', { seed: 30 }));
    const b = buildProfile({
      recordings: { ...recordings, away: lazyAway },
      previous: null,
      camera: CAMERA,
      nowIso: NOW,
    });
    expect(b.ok).toBe(false);
    expect(b.issues).toContainEqual({ code: 'same_as_screen', cls: 'away', severity: 'error' });
  });

  it('warns `weak_separation` when phone and reading cannot be told apart, and stays usable', () => {
    const recordings = recordAll();
    // A phone the detector never sees, held exactly like the notebook.
    const hiddenPhone = calibrationFrames('paper', { seed: 40 }).map((f) => ({
      ...f,
      objects: f.objects && { ...f.objects, phone: null, book: null },
    }));
    const result = buildProfile({
      recordings: { ...recordings, phone: record('phone', hiddenPhone) },
      previous: null,
      camera: CAMERA,
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.weak).toBe(true);
    expect(result.profile.report.weak).toBe(true);
    expect(result.issues).toContainEqual({
      code: 'weak_separation',
      cls: null,
      severity: 'warning',
      pair: ['paper', 'phone'],
    });
    expect(result.issues.map((i) => i.code)).toContain('phone_not_seen');
  });

  it('re-records one situation and keeps the other clips and the feedback rows', () => {
    const first = profileFor('baseline');
    const learned = learnFromFeedback(first, episode(first), { nowIso: NOW });
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    const paper = record('paper', calibrationFrames('paper', { seed: 50 }));
    const result = buildProfile({
      recordings: { paper },
      previous: learned.profile,
      camera: CAMERA,
      nowIso: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.profile;
    expect(p.createdAt).toBe(NOW);
    expect(p.updatedAt).toBe(LATER);
    expect(p.clips.paper?.recordedAt).toBe(LATER);
    expect(p.clips.screen).toEqual(first.clips.screen);
    const rowsOf = (profile: CalibrationProfile, cls: number, src: number) =>
      profile.samples.rows.filter(
        (_, i) => profile.samples.cls[i] === cls && profile.samples.src[i] === src,
      );
    expect(rowsOf(p, 0, 0)).toEqual(rowsOf(first, 0, 0));
    expect(rowsOf(p, 1, 0)).toEqual(paper.rows);
    expect(rowsOf(p, 0, 1)).toEqual(rowsOf(learned.profile, 0, 1));
    expect(rowsOf(p, 0, 1).length).toBeGreaterThan(0);
  });

  it('«Recalibrar» (previous: null) is a clean slate without feedback rows', () => {
    const first = profileFor('baseline');
    const learned = learnFromFeedback(first, episode(first), { nowIso: NOW });
    if (!learned.ok) throw new Error('feedback failed');
    const result = buildProfile({
      recordings: recordAll(PERSONAS.baseline, 60),
      previous: null,
      camera: CAMERA,
      nowIso: LATER,
    });
    expect(result.ok && result.profile.samples.src.every((s) => s === 0)).toBe(true);
    expect(result.ok && result.profile.createdAt).toBe(LATER);
  });

  it('ignores a previous profile from another camera', () => {
    const paper = record('paper', calibrationFrames('paper', { seed: 50 }));
    const result = buildProfile({
      recordings: { paper },
      previous: profileFor('baseline'),
      camera: OTHER_CAMERA,
      nowIso: LATER,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((i) => i.code === 'missing')).toHaveLength(4);
  });

  it('rejects a malformed nowIso', () => {
    expect(() =>
      buildProfile({ recordings: recordAll(), previous: null, camera: CAMERA, nowIso: 'today' }),
    ).toThrow(RangeError);
  });

  it('builds within 2 s', () => {
    const recordings = recordAll(PERSONAS.lowLight, 70);
    const ms = cpuMs(() => {
      const result = buildProfile({ recordings, previous: null, camera: CAMERA, nowIso: NOW });
      expect(result.ok).toBe(true);
    });
    expect(ms).toBeLessThan(2_000);
  });
});

describe('serializeProfile / parseProfile', () => {
  it('round-trips exactly, and the reloaded profile retrains identically', () => {
    const profile = profileFor('baseline');
    const json = serializeProfile(profile);
    const parsed = parseProfile(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.migrated).toBe(false);
    expect(parsed.profile).toEqual(profile);
    expect(serializeProfile(parsed.profile)).toBe(json);
    const rebuild = (previous: CalibrationProfile) =>
      buildProfile({ recordings: {}, previous, camera: CAMERA, nowIso: NOW });
    const a = rebuild(profile);
    const b = rebuild(parsed.profile);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.profile.model).toEqual(a.profile.model);
    const fa = learnFromFeedback(profile, episode(profile), { nowIso: LATER });
    const fb = learnFromFeedback(parsed.profile, episode(parsed.profile), { nowIso: LATER });
    expect(fa.ok && fb.ok).toBe(true);
    if (fa.ok && fb.ok) expect(serializeProfile(fb.profile)).toBe(serializeProfile(fa.profile));
  });

  it('writes sorted keys, a compact file and only numbers or allowed strings', () => {
    const profile = profileFor('baseline');
    const json = serializeProfile(profile);
    expect(json.length).toBeLessThan(150 * 1024);
    expect(json.indexOf('"baseline"')).toBeLessThan(json.indexOf('"camera"'));
    const allowed = (key: string, value: string): boolean =>
      (key === 'format' && value === 'centrate-study-ai-profile') ||
      (key === 'kind' && value === 'softmax-l2') ||
      (key === 'key' && /^sha256:[0-9a-f]{64}$/.test(value)) ||
      (['createdAt', 'updatedAt', 'recordedAt'].includes(key) &&
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value));
    const walk = (value: unknown, key: string): void => {
      if (value === null || typeof value === 'boolean') return;
      if (typeof value === 'number') return expect(Number.isFinite(value), key).toBe(true);
      if (typeof value === 'string')
        return expect(allowed(key, value), `${key}=${value}`).toBe(true);
      if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
      expect(typeof value, key).toBe('object');
      for (const [k, v] of Object.entries(value as Raw)) walk(v, k);
    };
    walk(JSON.parse(json), '');
  });

  it('returns a frozen profile', () => {
    const profile = profileFor('baseline');
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.samples.rows[0])).toBe(true);
    expect(Object.isFrozen(profile.model.W)).toBe(true);
  });

  describe('rejects', () => {
    const profile = profileFor('baseline');

    it('syntax', () => {
      for (const text of ['', 'not json', '{', '{"format":']) {
        expect(parseProfile(text)).toEqual({ ok: false, error: 'syntax' });
      }
    });

    it('too_large', () => {
      expect(parseProfile(' '.repeat(512 * 1024 + 1))).toEqual({ ok: false, error: 'too_large' });
      const many = mutate(profile, (raw) => {
        const s = obj(raw.samples);
        s.rows = Array.from({ length: 5_001 }, () => new Array(22).fill(0));
        s.cls = new Array(5_001).fill(0);
        s.src = new Array(5_001).fill(1);
      });
      expect(many.length).toBeLessThan(512 * 1024);
      expect(parseProfile(many)).toEqual({ ok: false, error: 'too_large' });
    });

    it('non_finite', () => {
      const json = serializeProfile(profile).replace('"lambda":', '"lambda":1e999,"x":');
      expect(parseProfile(json)).toEqual({ ok: false, error: 'non_finite' });
      const deep = mutate(profile, (raw) => {
        obj(raw.baseline).yaw = '__INF__';
      }).replace('"__INF__"', '-1e999');
      expect(parseProfile(deep)).toEqual({ ok: false, error: 'non_finite' });
    });

    it('format', () => {
      expect(parseProfile('[]')).toEqual({ ok: false, error: 'format' });
      expect(parseProfile('42')).toEqual({ ok: false, error: 'format' });
      expect(parseProfile(mutate(profile, (raw) => void (raw.format = 'other')))).toEqual({
        ok: false,
        error: 'format',
      });
    });

    it('version', () => {
      for (const version of [0, 2, '1', null]) {
        expect(parseProfile(mutate(profile, (raw) => void (raw.version = version)))).toEqual({
          ok: false,
          error: 'version',
        });
      }
    });

    const schemaCases: [string, (raw: Raw) => void][] = [
      ['an unknown key', (raw) => void (raw.extra = 1)],
      ['a missing key', (raw) => void delete raw.trust],
      ['an unknown nested key', (raw) => void (obj(raw.eyes).extra = true)],
      ['a wrong row length', (raw) => void arr(obj(raw.samples).rows).splice(0, 1, [1, 2, 3])],
      ['a class index out of range', (raw) => void (arr(obj(raw.samples).cls)[0] = 5)],
      ['an unknown source', (raw) => void (arr(obj(raw.samples).src)[0] = 2)],
      ['mismatched sample arrays', (raw) => void arr(obj(raw.samples).cls).pop()],
      ['a camera key that is not a hash', (raw) => void (obj(raw.camera).key = 'Logitech C920')],
      ['a date that is not ISO', (raw) => void (raw.updatedAt = '28/09/2026')],
      ['a string instead of a number', (raw) => void (obj(raw.thresholds).phone = '0.5')],
      ['a wrong weight shape', (raw) => void arr(arr(obj(raw.model).W)[0]).pop()],
      ['too many anchors', (raw) => void (obj(raw.model).anchors = new Array(5).fill([0, 0, 0]))],
      ['a zero scale', (raw) => void (arr(obj(raw.model).scale)[0] = 0)],
      ['an unknown model kind', (raw) => void (obj(raw.model).kind = 'mlp')],
      [
        'clip info that disagrees with the rows',
        (raw) => void (obj(obj(raw.clips).screen).rows = 3),
      ],
      [
        'a negative confusion count',
        (raw) => void (arr(arr(obj(raw.report).confusion)[0])[0] = -1),
      ],
      ['another feature schema', (raw) => void (raw.featureSchema = 2)],
      ['a boolean as a number', (raw) => void (obj(raw.eyes).reliable = 1)],
    ];
    it.each(schemaCases)('schema: %s', (_name, change) => {
      expect(parseProfile(mutate(profile, change))).toEqual({ ok: false, error: 'schema' });
    });
  });

  it('retrains a profile from another trainer version and reports it as migrated', () => {
    const profile = profileFor('baseline');
    const stale = mutate(profile, (raw) => {
      raw.trainer = PROFILE_TRAINER_VERSION + 1;
      obj(raw.model).W = arr(obj(raw.model).W).map((row) => arr(row).map(() => 0));
    });
    const parsed = parseProfile(stale);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.migrated).toBe(true);
    expect(parsed.profile.trainer).toBe(PROFILE_TRAINER_VERSION);
    expect(parsed.profile.model).toEqual(profile.model);
    expect(parsed.profile.updatedAt).toBe(profile.updatedAt);
  });
});

describe('profileMatchesCamera', () => {
  const profile = profileFor('baseline');
  it('needs the same key and an aspect within 2 %', () => {
    expect(profileMatchesCamera(profile, CAMERA)).toBe(true);
    expect(profileMatchesCamera(profile, { ...CAMERA, aspect: (4 / 3) * 1.019 })).toBe(true);
    expect(profileMatchesCamera(profile, { ...CAMERA, aspect: 16 / 9 })).toBe(false);
    expect(profileMatchesCamera(profile, OTHER_CAMERA)).toBe(false);
    expect(profileMatchesCamera(profile, { ...CAMERA, aspect: Number.NaN })).toBe(false);
  });
});

describe('fixtures sanity', () => {
  it('uses frames with the baseline looking at the screen', () => {
    const row = record('screen', calibrationFrames('screen', { seed: 1 })).rows[0] ?? [];
    expect(row[COL.face]).toBe(1);
    expect(frame({ face: face() }).face?.pose.pitch).toBe(-5);
  });
});
