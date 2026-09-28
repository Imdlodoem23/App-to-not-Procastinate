/** One calibration situation: timing, trimming, cap and per-clip checks (DESIGN.md §6.1–6.2). */
import { describe, expect, it } from 'vitest';
import { CalibrationRecorder } from '../../src/calibration/recorder';
import { COL } from '../../src/classifier/rows';
import { CALIBRATION_CLASSES } from '../../src/types';
import type { CalibrationClass, FrameFeatures } from '../../src/types';
import { PERSONAS } from '../synth';
import { face, frame, record, situationFrames } from './fixtures';

/** Frames every `stepMs` from 0 to 20 s built by `make`. */
function clip(
  make: (t: number, i: number) => FrameFeatures,
  stepMs = 250,
  endMs = 20_000,
): FrameFeatures[] {
  const out: FrameFeatures[] = [];
  for (let t = 0, i = 0; t < endMs; t += stepMs, i += 1) out.push(make(t, i));
  return out;
}

const codes = (cls: CalibrationClass, frames: FrameFeatures[]): string[] =>
  record(cls, frames).issues.map((i) => i.code);

describe('CalibrationRecorder', () => {
  it('goes settling → recording → done with the remaining time', () => {
    const rec = new CalibrationRecorder('screen', 1_000);
    expect(rec.push(frame({ t: 1_500 }))).toMatchObject({
      cls: 'screen',
      phase: 'settling',
      frames: 0,
      remainingMs: 19_500,
    });
    const mid = rec.push(frame({ t: 9_000 }));
    expect(mid.phase).toBe('recording');
    expect(mid.frames).toBe(1);
    expect(mid.remainingMs).toBe(12_000);
    expect(mid.elapsedMs).toBe(8_000);
    expect(rec.progress(21_000)).toMatchObject({ phase: 'done', remainingMs: 0 });
    expect(rec.push(frame({ t: 21_500 })).frames).toBe(1);
  });

  it('drops the first 2 s and the last 1 s', () => {
    const recording = record(
      'screen',
      clip((t) => frame({ t, face: face({ yaw: t / 1_000 }) })),
    );
    const yaws = recording.rows.map((r) => r[COL.yaw] as number);
    expect(Math.min(...yaws)).toBe(2);
    expect(Math.max(...yaws)).toBe(19);
    expect(recording.rows).toHaveLength(69); // 2.00 … 19.00 s at 4 fps
    expect(recording.issues).toEqual([]);
    expect(recording.faceRatio).toBe(1);
    expect(recording.durationMs).toBe(20_000);
  });

  it('caps a clip at 80 rows spread over the whole recording', () => {
    const recording = record(
      'screen',
      clip((t) => frame({ t, face: face({ yaw: t / 1_000 }) }), 100),
    );
    expect(recording.rows).toHaveLength(80);
    const yaws = recording.rows.map((r) => r[COL.yaw] as number);
    expect(yaws[0]).toBe(2);
    expect(Math.max(...yaws)).toBeGreaterThan(18.5);
  });

  it('ignores frames out of order or with a broken time, and finishes once', () => {
    const rec = new CalibrationRecorder('screen', 0);
    rec.push(frame({ t: 5_000 }));
    rec.push(frame({ t: 4_000 }));
    rec.push(frame({ t: Number.NaN }));
    expect(rec.progress(6_000).frames).toBe(1);
    const a = rec.finish(20_000);
    expect(rec.finish(25_000)).toBe(a);
    expect(rec.progress(30_000)).toMatchObject({ phase: 'done', frames: 1 });
  });

  it('keeps only numbers', () => {
    const recording = record(
      'screen',
      clip((t) => frame({ t })),
    );
    for (const row of recording.rows) expect(row.every((v) => typeof v === 'number')).toBe(true);
  });

  describe('checks', () => {
    it.each(CALIBRATION_CLASSES)('a good %s clip has no issues', (cls) => {
      const recording = record(cls, situationFrames(PERSONAS.baseline, cls, 3));
      expect(recording.issues).toEqual([]);
    });

    it('too_short: fewer than 40 rows', () => {
      const rec = new CalibrationRecorder('screen', 0);
      for (const f of clip((t) => frame({ t }))) if (f.t < 10_000) rec.push(f);
      const recording = rec.finish(10_000);
      expect(recording.issues.map((i) => i.code)).toContain('too_short');
      expect(recording.issues[0]?.severity).toBe('error');
    });

    it('no_face: nobody in most frames', () => {
      expect(
        codes(
          'paper',
          clip((t) => frame({ t, face: null, person: null })),
        ),
      ).toContain('no_face');
      // A hidden face with a person in view is fine (head down writing).
      expect(
        codes(
          'paper',
          clip((t) => frame({ t, face: null, person: 0.9 })),
        ),
      ).not.toContain('no_face');
    });

    it('too_dark: median luma under 0.1', () => {
      expect(
        codes(
          'screen',
          clip((t) => frame({ t, luma: { mean: 0.05 } })),
        ),
      ).toContain('too_dark');
    });

    it('covered: lens covered in ≥ 30 % of frames', () => {
      const frames = clip((t, i) => frame({ t, luma: { covered: i % 3 === 0 } }));
      expect(codes('screen', frames)).toContain('covered');
    });

    it('still_visible: the absent clip still sees the user', () => {
      expect(
        codes(
          'absent',
          clip((t) => frame({ t })),
        ),
      ).toContain('still_visible');
      // A coat on the chair (weak person score) is not the user.
      expect(
        codes(
          'absent',
          clip((t) => frame({ t, face: null, person: 0.55 })),
        ),
      ).toEqual([]);
    });

    it('phone_not_seen (warning): the detector never saw the phone', () => {
      const recording = record(
        'phone',
        clip((t) => frame({ t, face: face({ pitch: -35 }) })),
      );
      const found = recording.issues.find((i) => i.code === 'phone_not_seen');
      expect(found?.severity).toBe('warning');
    });

    it('unstable (warning): the screen pose wanders', () => {
      const frames = clip((t, i) => frame({ t, face: face({ yaw: i % 2 === 0 ? -20 : 20 }) }));
      const found = record('screen', frames).issues.find((i) => i.code === 'unstable');
      expect(found?.severity).toBe('warning');
    });

    it('reports live issues before the end', () => {
      const rec = new CalibrationRecorder('screen', 0);
      let progress = rec.push(frame({ t: 2_000, face: null, person: null }));
      for (let t = 2_250; t < 5_000; t += 250)
        progress = rec.push(frame({ t, face: null, person: null }));
      expect(progress.phase).toBe('recording');
      expect(progress.liveIssues).toContain('no_face');
      expect(progress.faceRatio).toBe(0);
    });
  });
});
