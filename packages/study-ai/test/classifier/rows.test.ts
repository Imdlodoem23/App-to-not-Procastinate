/** Stored row layout, schema 1 (DESIGN.md §6.3). */
import { describe, expect, it } from 'vitest';
import { COL, frameToRow, isValidRow } from '../../src/classifier/rows';
import { FEATURE_ROW_COLUMNS } from '../../src/types';
import { face, frame } from '../calibration/fixtures';

describe('frameToRow', () => {
  it('follows FEATURE_ROW_COLUMNS', () => {
    expect(FEATURE_ROW_COLUMNS).toHaveLength(22);
    FEATURE_ROW_COLUMNS.forEach((name, index) => expect(COL[name]).toBe(index));
    expect(frameToRow(frame())).toHaveLength(22);
  });

  it('stores absolute values quantised to 0.1° and 0.001', () => {
    const row = frameToRow(
      frame({
        face: face({ yaw: 12.345, pitch: -33.36, roll: 1.04, cx: 0.51234, blink: 0.33333 }),
        phone: { score: 0.87654, nearFace: true, moving: true },
        book: 0.4444,
        person: 0.91919,
        luma: { mean: 0.456789 },
      }),
    );
    expect(row[COL.face]).toBe(1);
    expect(row[COL.yaw]).toBe(12.3);
    expect(row[COL.pitch]).toBe(-33.4);
    expect(row[COL.roll]).toBe(1);
    expect(row[COL.cx]).toBe(0.512);
    expect(row[COL.blink]).toBe(0.333);
    expect(row[COL.phone]).toBe(0.877);
    expect(row[COL.phoneNear]).toBe(1);
    expect(row[COL.phoneMoving]).toBe(1);
    expect(row[COL.book]).toBe(0.444);
    expect(row[COL.person]).toBe(0.919);
    expect(row[COL.lumaMean]).toBe(0.457);
    expect(row[COL.quality]).toBe(0.95);
  });

  it('leaves out a phone lying still for 20 s (on the desk or a stand)', () => {
    const resting = frameToRow(
      frame({ phone: { score: 0.9, nearFace: false, moving: false, stillMs: 20_000 } }),
    );
    expect([resting[COL.phone], resting[COL.phoneNear], resting[COL.phoneMoving]]).toEqual([
      0, 0, 0,
    ]);
    const settling = frameToRow(
      frame({ phone: { score: 0.9, nearFace: false, moving: false, stillMs: 19_999 } }),
    );
    expect(settling[COL.phone]).toBe(0.9);
    const moved = frameToRow(
      frame({ phone: { score: 0.9, nearFace: false, moving: true, stillMs: 25_000 } }),
    );
    expect(moved[COL.phone]).toBe(0.9);
  });

  it('round-trips exactly through JSON', () => {
    const row = frameToRow(frame({ face: face({ yaw: 1 / 3, pitch: -2 / 3, gazeX: -0.1234567 }) }));
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });

  it('zeroes the face columns without a face and marks missing luma', () => {
    const row = frameToRow(frame({ face: null, person: 0.8, luma: null }));
    expect(row[COL.face]).toBe(0);
    for (const name of ['yaw', 'pitch', 'roll', 'cx', 'cy', 'w', 'h', 'blink', 'gazeX'] as const) {
      expect(row[COL[name]]).toBe(0);
    }
    expect(row[COL.person]).toBe(0.8);
    expect(row[COL.lumaMean]).toBe(-1);
    expect(row[COL.lumaStd]).toBe(-1);
  });

  it('never stores a non-finite or out-of-range value', () => {
    const bad = frame({
      face: face({ yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY, cx: 1e9, gazeX: -7 }),
      phone: { score: Number.NaN },
      person: 1e6,
    });
    const row = frameToRow(bad);
    expect(row.every(Number.isFinite)).toBe(true);
    expect(row[COL.yaw]).toBe(0);
    expect(Math.abs(row[COL.pitch] as number)).toBeLessThanOrEqual(180);
    expect(row[COL.gazeX]).toBe(-1);
    expect(row[COL.person]).toBe(1);
    expect(isValidRow(row)).toBe(true);
  });

  it('isValidRow rejects malformed rows', () => {
    expect(isValidRow(frameToRow(frame()))).toBe(true);
    expect(isValidRow([1, 2, 3])).toBe(false);
    expect(isValidRow(new Array(22).fill('0'))).toBe(false);
    const row = [...frameToRow(frame())];
    row[COL.yaw] = 200;
    expect(isValidRow(row)).toBe(false);
  });
});
