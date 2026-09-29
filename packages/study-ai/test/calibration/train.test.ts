/** Training internals: folds, leakage, augmentation, weights, trust and report (§6.6–6.8). */
import { describe, expect, it } from 'vitest';
import { learnThresholds, screenBaseline, theilSen } from '../../src/calibration/stats';
import {
  CLASS_INDEX,
  K_CLASSES,
  SRC_CALIBRATION,
  SRC_FEEDBACK,
  SRC_PSEUDO,
  assembleTraining,
  augment,
  fitFeatureSpace,
  foldTrainingRows,
  reportFromOof,
  sampleFolds,
  trainFull,
  trustFromOof,
  type Assembled,
  type SampleSet,
} from '../../src/calibration/train';
import { XI } from '../../src/classifier/constants';
import { COL } from '../../src/classifier/rows';
import { CALIBRATION_CLASSES } from '../../src/types';
import type { FeatureRow } from '../../src/types';
import { calibrationFrames } from '../synth';
import { record, recordAll } from './fixtures';

function samplesFrom(extraFeedback: readonly FeatureRow[] = []): SampleSet {
  const recordings = recordAll();
  const cls: number[] = [];
  const src: number[] = [];
  const rows: FeatureRow[] = [];
  for (const name of CALIBRATION_CLASSES) {
    for (const row of recordings[name].rows) {
      cls.push(CLASS_INDEX[name]);
      src.push(SRC_CALIBRATION);
      rows.push(row);
    }
  }
  for (const row of extraFeedback) {
    cls.push(CLASS_INDEX.screen);
    src.push(SRC_FEEDBACK);
    rows.push(row);
  }
  return { cls, src, rows };
}

function context(samples: SampleSet) {
  const pick = (c: number) =>
    samples.rows.filter((_, i) => samples.cls[i] === c && samples.src[i] === 0);
  const baseline = screenBaseline(pick(0));
  if (!baseline) throw new Error('no baseline');
  const thresholds = learnThresholds([...pick(0), ...pick(1)], pick(4));
  return { baseline, thresholds };
}

describe('blocked folds', () => {
  it('holds out the k-th contiguous quarter of each clip', () => {
    const samples = samplesFrom();
    const folds = sampleFolds(samples);
    for (let c = 0; c < K_CLASSES; c += 1) {
      const clip = Array.from(folds).filter((_, i) => samples.cls[i] === c);
      // Non-decreasing 0…3 along the clip, each quarter present.
      for (let i = 1; i < clip.length; i += 1)
        expect(clip[i]).toBeGreaterThanOrEqual(clip[i - 1] as number);
      expect(new Set(clip)).toEqual(new Set([0, 1, 2, 3]));
      const sizes = [0, 1, 2, 3].map((f) => clip.filter((v) => v === f).length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it('never trains a fold on rows derived from its held-out frames', () => {
    const samples = samplesFrom();
    const { baseline, thresholds } = context(samples);
    const assembled = assembleTraining(
      samples,
      baseline,
      thresholds,
      fitFeatureSpace(samples, baseline),
    );
    const folds = sampleFolds(samples);
    expect(assembled.data.n).toBeGreaterThan(samples.rows.length); // pseudo-rows exist
    for (let k = 0; k < 4; k += 1) {
      for (const i of foldTrainingRows(assembled, k)) {
        expect(folds[assembled.parent[i] as number]).not.toBe(k);
      }
    }
    for (let i = samples.rows.length; i < assembled.data.n; i += 1) {
      expect(assembled.src[i]).toBe(SRC_PSEUDO);
      expect(assembled.fold[i]).toBe(folds[assembled.parent[i] as number]);
    }
  });
});

describe('augmentation', () => {
  const samples = samplesFrom();
  const { baseline, thresholds } = context(samples);
  const pseudo = augment(samples, thresholds, baseline);

  it('is deterministic', () => {
    expect(augment(samples, thresholds, baseline)).toEqual(pseudo);
  });

  it('adds phone copies of study rows and removes the phone from phone rows', () => {
    const toPhone = pseudo.filter(
      (p) => p.cls === CLASS_INDEX.phone && (samples.cls[p.parent] ?? -1) <= 1,
    );
    expect(toPhone.length).toBeGreaterThan(40);
    for (const p of toPhone) {
      expect(p.row[COL.phone]).toBe(0.8);
      expect(p.row[COL.phoneNear]).toBe(1);
    }
    const toPaper = pseudo.filter(
      (p) => p.cls === CLASS_INDEX.paper && samples.cls[p.parent] === CLASS_INDEX.phone,
    );
    expect(toPaper.length).toBeGreaterThan(40);
    for (const p of toPaper) expect(p.row[COL.phone]).toBe(0);
  });

  it('mirrors looking away to the other side', () => {
    const away = pseudo.filter((p) => p.cls === CLASS_INDEX.away && p.weight === 1);
    expect(away.length).toBeGreaterThan(40);
    for (const p of away) {
      const source = samples.rows[p.parent] as FeatureRow;
      const d0 = (source[COL.yaw] as number) - baseline.yaw;
      const d1 = (p.row[COL.yaw] as number) - baseline.yaw;
      expect(d1).toBeCloseTo(-d0, 6);
      expect(p.row[COL.gazeX]).toBeCloseTo(-(source[COL.gazeX] as number), 10);
    }
  });

  it('pins absent copies at no face and a person under the threshold', () => {
    const absent = pseudo.filter((p) => p.cls === CLASS_INDEX.absent);
    expect(absent.length).toBeGreaterThan(10);
    for (const p of absent) {
      expect(p.row[COL.face]).toBe(0);
      expect(p.row[COL.person] as number).toBeLessThan(thresholds.person);
    }
  });

  it('adds copies of study rows read across the screen: eyes ±0.3, head ±10°, same label', () => {
    // Only yaw and gazeX differ from the source (the pose-noise copies also move pitch).
    const scan = pseudo.filter((p) => {
      const source = samples.rows[p.parent] as FeatureRow;
      return (
        p.cls === samples.cls[p.parent] &&
        p.cls <= CLASS_INDEX.paper &&
        p.row.every((v, c) => c === COL.yaw || c === COL.gazeX || v === source[c]) &&
        p.row[COL.gazeX] !== source[COL.gazeX]
      );
    });
    const studyFaceRows = samples.rows.filter(
      (row, i) => (samples.cls[i] ?? 9) <= CLASS_INDEX.paper && (row[COL.face] ?? 0) === 1,
    ).length;
    expect(scan.length).toBe(studyFaceRows);
    const gaze: number[] = [];
    const yaw: number[] = [];
    for (const p of scan) {
      const source = samples.rows[p.parent] as FeatureRow;
      gaze.push((p.row[COL.gazeX] as number) - (source[COL.gazeX] as number));
      yaw.push((p.row[COL.yaw] as number) - (source[COL.yaw] as number));
      expect(p.weight).toBe(0.3);
    }
    expect(Math.max(...gaze.map(Math.abs))).toBeLessThanOrEqual(0.3);
    expect(Math.max(...yaw.map(Math.abs))).toBeLessThanOrEqual(10);
    // Spread over the whole range on both sides, not a few fixed offsets.
    expect(Math.min(...gaze)).toBeLessThan(-0.25);
    expect(Math.max(...gaze)).toBeGreaterThan(0.25);
    expect(Math.min(...yaw)).toBeLessThan(-8);
    expect(Math.max(...yaw)).toBeGreaterThan(8);
  });

  it('floors the gaze scale at 0.15 when calibration looked at one spot', () => {
    const still = samples.rows.map((row) => row.map((v, c) => (c === COL.gazeX ? 0 : v)));
    const space = fitFeatureSpace({ ...samples, rows: still }, baseline);
    expect(space.scale[XI.gazeX]).toBe(0.15);
    // A real spread above the floor is kept.
    expect(fitFeatureSpace(samples, baseline).scale[XI.gazeX] ?? 0).toBeGreaterThan(0.15);
  });

  it('toggles the book on paper rows', () => {
    const paper = pseudo.filter(
      (p) =>
        p.cls === CLASS_INDEX.paper &&
        samples.cls[p.parent] === CLASS_INDEX.paper &&
        p.row[COL.book] !== (samples.rows[p.parent] as FeatureRow)[COL.book],
    );
    expect(paper.length).toBeGreaterThan(40);
    for (const p of paper) expect([0, 0.7]).toContain(p.row[COL.book]);
  });
});

describe('weights', () => {
  function classTotals(assembled: Assembled): number[] {
    const totals = new Array<number>(K_CLASSES).fill(0);
    for (let i = 0; i < assembled.data.n; i += 1) {
      const c = assembled.data.y[i] as number;
      totals[c] = (totals[c] as number) + (assembled.data.w[i] as number);
    }
    return totals;
  }

  it('equalises the class totals', () => {
    const samples = samplesFrom();
    const { baseline, thresholds } = context(samples);
    const totals = classTotals(
      assembleTraining(samples, baseline, thresholds, fitFeatureSpace(samples, baseline)),
    );
    for (const t of totals) expect(t).toBeCloseTo(totals[0] as number, 9);
  });

  it('caps feedback at half of its class’s calibration weight', () => {
    const plain = samplesFrom();
    const feedback = plain.rows.filter((_, i) => plain.cls[i] === CLASS_INDEX.away).slice(0, 60);
    const samples = samplesFrom([...feedback, ...feedback, ...feedback, ...feedback]);
    const { baseline, thresholds } = context(samples);
    const assembled = assembleTraining(
      samples,
      baseline,
      thresholds,
      fitFeatureSpace(samples, baseline),
    );
    let fb = 0;
    let calib = 0;
    for (let i = 0; i < assembled.data.n; i += 1) {
      if (assembled.data.y[i] !== CLASS_INDEX.screen) continue;
      if (assembled.src[i] === SRC_FEEDBACK) fb += assembled.data.w[i] as number;
      else calib += assembled.data.w[i] as number;
    }
    expect(fb / calib).toBeCloseTo(0.5, 9);
  });

  it('down-weights phone rows where no phone is visible', () => {
    const samples = samplesFrom();
    const { baseline, thresholds } = context(samples);
    const assembled = assembleTraining(
      samples,
      baseline,
      thresholds,
      fitFeatureSpace(samples, baseline),
    );
    const phoneRows = samples.rows
      .map((row, i) => ({ row, i }))
      .filter(({ i }) => samples.cls[i] === CLASS_INDEX.phone);
    const seen = phoneRows.find(({ row }) => (row[COL.phone] ?? 0) >= thresholds.phone);
    const unseen = phoneRows.find(({ row }) => (row[COL.phone] ?? 0) < thresholds.phone);
    expect(seen && unseen).toBeTruthy();
    const w = (i: number) => assembled.data.w[i] as number;
    expect(w(unseen?.i ?? 0) / w(seen?.i ?? 0)).toBeCloseTo(0.2, 9);
  });
});

// Two full trainings (CV included): well under 5 s alone, slower beside 40 test workers.
describe('trust π and the report', { timeout: 30_000 }, () => {
  /** A fake assembled set: rows with labels and out-of-fold argmax predictions. */
  function fake(pairs: readonly [truth: number, predicted: number][]): {
    assembled: Assembled;
    oof: Float64Array;
  } {
    const n = pairs.length;
    const oof = new Float64Array(n * K_CLASSES);
    const y = new Uint8Array(n);
    pairs.forEach(([truth, predicted], i) => {
      y[i] = truth;
      oof[i * K_CLASSES + predicted] = 1;
    });
    const assembled: Assembled = {
      data: { n, d: 1, k: K_CLASSES, X: new Float64Array(n), y, w: new Float64Array(n).fill(1) },
      fold: new Int8Array(n),
      src: new Uint8Array(n),
      parent: Int32Array.from({ length: n }, (_, i) => i),
      nonEmpty: new Uint8Array(n).fill(1),
    };
    return { assembled, oof };
  }

  it('estimates P(truly study | predicted phone) with smoothing, capped at 0.8', () => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < 6; i += 1) pairs.push([CLASS_INDEX.paper, CLASS_INDEX.phone]);
    for (let i = 0; i < 4; i += 1) pairs.push([CLASS_INDEX.phone, CLASS_INDEX.phone]);
    for (let i = 0; i < 10; i += 1) pairs.push([CLASS_INDEX.away, CLASS_INDEX.away]);
    const { assembled, oof } = fake(pairs);
    const trust = trustFromOof(assembled, oof);
    expect(trust.phone).toBeCloseTo((6 + 1) / (10 + 10), 12);
    expect(trust.away).toBeCloseTo(1 / 20, 12);
    const all = fake(
      Array.from(
        { length: 200 },
        () => [CLASS_INDEX.screen, CLASS_INDEX.phone] as [number, number],
      ),
    );
    expect(trustFromOof(all.assembled, all.oof).phone).toBe(0.8);
    const none = fake([[CLASS_INDEX.screen, CLASS_INDEX.screen]]);
    expect(trustFromOof(none.assembled, none.oof)).toEqual({ phone: 0.1, away: 0.1 });
  });

  it('computes the confusion, recall and binary balanced accuracy', () => {
    const pairs: [number, number][] = [
      [0, 0],
      [0, 0],
      [1, 2],
      [1, 1],
      [2, 2],
      [2, 1],
      [3, 3],
      [4, 4],
    ];
    const { assembled, oof } = fake(pairs);
    const { report, pair } = reportFromOof(assembled, oof);
    expect(report.confusion[1]).toEqual([0, 1, 1, 0, 0]);
    expect(report.recall).toEqual({ screen: 1, paper: 0.5, phone: 0.5, away: 1, absent: 1 });
    expect(report.cvBinaryBalancedAccuracy).toBeCloseTo((3 / 4 + 3 / 4) / 2, 12);
    expect(report.weak).toBe(true);
    expect(pair).toEqual(['paper', 'phone']);
  });

  it('learns a high π_phone when the phone posture is the reading posture', () => {
    const recordings = recordAll();
    const withPhone = (seed: number, every: number) =>
      calibrationFrames('paper', { seed }).map((f, i) =>
        i % every === 0 && f.objects
          ? {
              ...f,
              objects: {
                ...f.objects,
                phone: {
                  score: 0.8,
                  box: { cx: 0.5, cy: 0.7, w: 0.1, h: 0.1 },
                  nearFace: true,
                  moving: false,
                  stillMs: 0,
                },
              },
            }
          : f,
      );
    // Writing with the phone in view half the time, and «distraído con el móvil» recorded
    // in the very same posture: the classifier cannot tell them apart.
    const paper = withPhone(80, 2);
    const phone = withPhone(81, 1);
    const rows = { ...recordings, paper: record('paper', paper), phone: record('phone', phone) };
    const cls: number[] = [];
    const src: number[] = [];
    const all: FeatureRow[] = [];
    for (const name of CALIBRATION_CLASSES) {
      for (const row of rows[name].rows) {
        cls.push(CLASS_INDEX[name]);
        src.push(0);
        all.push(row);
      }
    }
    const samples = { cls, src, rows: all };
    const { baseline, thresholds } = context(samples);
    const confused = trainFull(samples, baseline, thresholds);
    const plain = samplesFrom();
    const clean = trainFull(plain, context(plain).baseline, context(plain).thresholds);
    expect(clean.trust.phone).toBeLessThan(0.1);
    expect(confused.trust.phone).toBeGreaterThan(0.25);
    expect(confused.trust.phone).toBeLessThanOrEqual(0.8);
  });
});

describe('theilSen', () => {
  it('fits a line and ignores outliers', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i - 25);
    const ys = xs.map((x) => 0.2 - 0.005 * x);
    ys[3] = 5;
    ys[40] = -3;
    const [a, b] = theilSen(xs, ys);
    expect(a).toBeCloseTo(0.2, 6);
    expect(b).toBeCloseTo(-0.005, 6);
    expect(theilSen([], [])).toEqual([0, 0]);
    expect(theilSen([1, 1, 1], [0.1, 0.2, 0.3])).toEqual([0.2, 0]);
  });
});
