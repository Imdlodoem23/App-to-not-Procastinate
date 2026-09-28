import { describe, expect, it } from 'vitest';
import { poseFromMatrix } from '../../src/perception/pose';
import type { MatrixLike } from '../../src/types';
import { apply, headRotation, poseMatrix, transform } from './fixtures';

const angleError = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('poseFromMatrix', () => {
  it('is the identity pose for a face looking straight at the camera', () => {
    const pose = poseFromMatrix(poseMatrix(0, 0, 0));
    expect(pose).not.toBeNull();
    expect(Math.abs(pose!.yaw)).toBeLessThan(1e-9);
    expect(Math.abs(pose!.pitch)).toBeLessThan(1e-9);
    expect(Math.abs(pose!.roll)).toBeLessThan(1e-9);
  });

  it('round-trips a ±80° grid within 0.5° (both layouts, scaled and translated)', () => {
    const angles = [-80, -60, -35, -12, 0, 7, 20, 45, 70, 80];
    const variants = [
      { layout: 'column' as const },
      { layout: 'row' as const },
      {
        layout: 'column' as const,
        scale: 0.37,
        translation: [12, -8, -60] as [number, number, number],
      },
      { layout: 'row' as const, scale: 4.2, translation: [-3, 5, -30] as [number, number, number] },
    ];
    let worst = 0;
    for (const variant of variants) {
      for (const yaw of angles) {
        for (const pitch of angles) {
          for (const roll of [-40, 0, 25]) {
            const pose = poseFromMatrix(poseMatrix(yaw, pitch, roll, variant));
            expect(pose, `${yaw}/${pitch}/${roll} ${variant.layout}`).not.toBeNull();
            worst = Math.max(
              worst,
              angleError(pose!.yaw, yaw),
              angleError(pose!.pitch, pitch),
              angleError(pose!.roll, roll),
            );
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('gives yaw > 0 when the nose moves towards the image right', () => {
    // Canonical nose tip is +Z (towards the camera); after turning it has x > 0 (image right).
    const nose = apply(headRotation(30, 0, 0), [0, 0, 7.5]);
    expect(nose[0]).toBeGreaterThan(0);
    expect(poseFromMatrix(poseMatrix(30, 0, 0))!.yaw).toBeGreaterThan(29);
    expect(poseFromMatrix(poseMatrix(-30, 0, 0))!.yaw).toBeLessThan(-29);
  });

  it('gives pitch < 0 when looking down (writing, reading)', () => {
    // Looking down moves the nose tip down in the image (metric −Y).
    const nose = apply(headRotation(0, -35, 0), [0, 0, 7.5]);
    expect(nose[1]).toBeLessThan(0);
    const pose = poseFromMatrix(poseMatrix(0, -35, 0))!;
    expect(pose.pitch).toBeCloseTo(-35, 6);
    expect(Math.abs(pose.yaw)).toBeLessThan(1e-9);
  });

  it('reads the translation to tell column-major from row-major', () => {
    const col = poseMatrix(25, -15, 10, { layout: 'column' });
    const row = poseMatrix(25, -15, 10, { layout: 'row' });
    const a = poseFromMatrix(col)!;
    const b = poseFromMatrix(row)!;
    expect(a.yaw).toBeCloseTo(b.yaw, 9);
    expect(a.pitch).toBeCloseTo(b.pitch, 9);
    expect(a.roll).toBeCloseTo(b.roll, 9);
  });

  it('returns null for a face pointing away from the camera', () => {
    expect(poseFromMatrix(poseMatrix(120, 0, 0))).toBeNull();
    expect(poseFromMatrix(poseMatrix(180, 0, 0))).toBeNull();
    expect(poseFromMatrix(poseMatrix(0, 100, 0))).toBeNull();
  });

  it('returns null for NaN, Infinity, short or non-4×4 matrices', () => {
    const good = poseMatrix(10, 10, 0);
    const withValue = (i: number, v: number): MatrixLike => {
      const data = Array.from(good.data);
      data[i] = v;
      return { rows: 4, columns: 4, data };
    };
    expect(poseFromMatrix(withValue(9, Number.NaN))).toBeNull();
    expect(poseFromMatrix(withValue(0, Number.POSITIVE_INFINITY))).toBeNull();
    expect(poseFromMatrix({ rows: 4, columns: 4, data: [1, 0, 0] })).toBeNull();
    expect(poseFromMatrix({ rows: 3, columns: 3, data: Array.from(good.data) })).toBeNull();
    expect(poseFromMatrix({ rows: 4, columns: 4, data: new Array<number>(16).fill(0) })).toBeNull();
  });

  it('stays finite near straight up or down (roll is 0 there)', () => {
    const pose = poseFromMatrix(transform(headRotation(0, 89.9999999, 0)));
    expect(pose).not.toBeNull();
    for (const v of Object.values(pose!)) expect(Number.isFinite(v)).toBe(true);
  });
});
