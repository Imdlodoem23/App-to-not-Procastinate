/**
 * The engine scenarios again, through LEARNING's real classifiers: the generic one (no
 * profile) and a personal one calibrated on the synth persona's five situations.
 */
import { describe, expect, it } from 'vitest';
import { CalibrationRecorder } from '../../src/calibration/recorder';
import { buildProfile } from '../../src/calibration/profile';
import { createGenericClassifier } from '../../src/classifier/generic';
import { createPersonalClassifier } from '../../src/classifier/personal';
import { learnFromFeedback } from '../../src/calibration/feedback';
import { NoCameraObserver } from '../../src/runtime/no-camera';
import { AttentionEngine } from '../../src/state/engine';
import { resolveStudyAiSettings } from '../../src/config';
import { CALIBRATION_CLASSES } from '../../src/types';
import type {
  AttentionClassifier,
  CalibrationClass,
  CalibrationProfile,
  FrameFeatures,
  SituationRecording,
} from '../../src/types';
import { implemented } from '../helpers/implemented';
import { PERSONAS, calibrationFrames, synthesize, type Persona, type Script } from '../synth';
import { Recorder, cameraEngine } from './harness';
import { STUDY_SCRIPTS, focusShare, runScenario } from './scenarios';

const MIN = 60_000;
const HEAVY_MS = 300_000;
const CAMERA = Object.freeze({ key: `sha256:${'c'.repeat(64)}`, aspect: 4 / 3 });

function framesFor(
  persona: Persona,
  cls: CalibrationClass,
  seed: number,
  bothScreens = true,
): FrameFeatures[] {
  if (cls === 'screen' && bothScreens) {
    // The wizard asks to look at every screen the user studies with (both monitors here).
    return synthesize(
      [
        ['screen', 10_000],
        ['secondMonitor', 10_000],
      ],
      { persona, seed, fps: 4, objectEveryMs: 500 },
    ).flatMap((t) => (t.frame ? [t.frame] : []));
  }
  return calibrationFrames(cls, { persona, seed });
}

const profiles = new Map<string, CalibrationProfile>();

function profileFor(persona: Persona, seed = 40, bothScreens = true): CalibrationProfile {
  const key = `${persona.id}:${persona.screen.yaw}:${seed}:${bothScreens}`;
  const hit = profiles.get(key);
  if (hit) return hit;
  const recordings: Partial<Record<CalibrationClass, SituationRecording>> = {};
  CALIBRATION_CLASSES.forEach((cls, i) => {
    const frames = framesFor(persona, cls, seed + i, bothScreens);
    const start = frames[0]?.t ?? 0;
    const recorder = new CalibrationRecorder(cls, start);
    for (const f of frames) recorder.push(f);
    recordings[cls] = recorder.finish(start + 20_000);
  });
  const result = buildProfile({
    recordings,
    previous: null,
    camera: CAMERA,
    nowIso: '2026-09-28T10:00:00.000Z',
  });
  if (!result.ok) throw new Error(`calibration failed: ${JSON.stringify(result.issues)}`);
  profiles.set(key, result.profile);
  return result.profile;
}

const ready =
  implemented(() => createGenericClassifier()) && implemented(() => profileFor(PERSONAS.baseline));

type Kind = 'generic' | 'personal';

function classifiers(
  kind: Kind,
  persona: Persona,
): {
  classifier: AttentionClassifier;
  fallback: AttentionClassifier | null;
} {
  if (kind === 'generic') return { classifier: createGenericClassifier(), fallback: null };
  return {
    classifier: createPersonalClassifier(profileFor(persona)),
    fallback: createGenericClassifier(),
  };
}

const PERSONA_LIST = Object.values(PERSONAS);

describe.runIf(ready)('real classifiers', { timeout: HEAVY_MS }, () => {
  describe.each<Kind>(['generic', 'personal'])('%s classifier', (kind) => {
    it('writing in a notebook for 20 min: 0 strikes, every persona', () => {
      for (const persona of PERSONA_LIST) {
        for (const fps of [2, 4]) {
          const { rec } = runScenario(STUDY_SCRIPTS.notebook as Script, {
            persona,
            fps,
            seed: 11,
            ...classifiers(kind, persona),
          });
          const label = `${persona.id} ${fps} fps`;
          expect(rec.strikes(), label).toEqual([]);
          expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
          expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
        }
      }
    });

    it('study scripts never strike, every persona', () => {
      for (const persona of PERSONA_LIST) {
        for (const [name, script] of Object.entries(STUDY_SCRIPTS)) {
          const { rec } = runScenario(script, { persona, seed: 12, ...classifiers(kind, persona) });
          const label = `${persona.id} ${name}`;
          expect(rec.strikes(), label).toEqual([]);
          expect(rec.warnings().length, label).toBeLessThanOrEqual(1);
          expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
        }
      }
    });

    it('phone in hand strikes with cause phone within 45–65 s', () => {
      for (const persona of PERSONA_LIST) {
        const { rec, stepStarts } = runScenario(
          [
            ['screen', MIN],
            ['phoneInHand', 2 * MIN],
          ],
          { persona, seed: 13, ...classifiers(kind, persona) },
        );
        const strike = rec.strikes()[0];
        const label = persona.id;
        expect(strike?.cause, label).toBe('phone');
        const after = (strike?.at as number) - (stepStarts[1] as number);
        expect(after, label).toBeGreaterThanOrEqual(45_000);
        expect(after, label).toBeLessThanOrEqual(65_000);
      }
    });

    it('leaving strikes no_face; a Pomodoro break away does not', () => {
      for (const persona of PERSONA_LIST) {
        const cls = classifiers(kind, persona);
        const leave = runScenario(
          [
            ['screen', MIN],
            ['absent', 70_000],
          ],
          { persona, seed: 14, ...cls },
        );
        expect(
          leave.rec.strikes().map((s) => s.cause),
          persona.id,
        ).toEqual(['no_face']);
        const brk = runScenario(
          [
            ['screen', 5 * MIN],
            { activity: 'absent', ms: 5 * MIN, phase: 'break', camera: 'off' },
            ['absent', 5_000],
            ['screen', 3 * MIN],
          ],
          { persona, seed: 15, ...classifiers(kind, persona) },
        );
        expect(brk.rec.strikes(), persona.id).toEqual([]);
        expect(brk.rec.warnings(), persona.id).toEqual([]);
      }
    });

    it('looking away for 2 min strikes; 40 s then back does not', () => {
      for (const persona of PERSONA_LIST) {
        const away = runScenario(
          [
            ['screen', MIN],
            ['lookAway', 2 * MIN],
          ],
          { persona, seed: 16, ...classifiers(kind, persona) },
        );
        expect(away.rec.strikes()[0]?.cause, persona.id).toBe('doubt_timeout');
        const back = runScenario(
          [
            ['screen', MIN],
            ['lookAway', 40_000],
            ['screen', 2 * MIN],
          ],
          { persona, seed: 17, ...classifiers(kind, persona) },
        );
        expect(back.rec.strikes(), persona.id).toEqual([]);
      }
    });

    it('eyes closed for 2 min never strike', () => {
      for (const persona of PERSONA_LIST) {
        const { rec } = runScenario(
          [
            ['screen', MIN],
            ['eyesClosed', 2 * MIN],
            ['screen', MIN],
          ],
          { persona, seed: 18, ...classifiers(kind, persona) },
        );
        expect(rec.strikes(), persona.id).toEqual([]);
      }
    });
  });

  it('a profile whose screen moved falls back to the generic classifier', () => {
    // Calibrated with the screen 50° to the side; now the user types facing the camera,
    // which that profile learned as «looking away»: the stale-profile check switches.
    const moved: Persona = { ...PERSONAS.baseline, screen: { yaw: 50, pitch: -5, roll: 0 } };
    const { rec } = runScenario([['typing', 5 * MIN]], {
      persona: PERSONAS.baseline,
      classifier: createPersonalClassifier(profileFor(moved)),
      fallback: createGenericClassifier(),
    });
    expect(rec.engine.snapshot().classifier).toBe('generic');
    expect(rec.of('hint').map((e) => e.code)).toContain('recalibrate');
    expect(rec.strikes()).toEqual([]);
  });

  it('a profile that goes stale mid-session (external monitor at another desk) falls back', () => {
    // Calibrated on the laptop screen only; the same built-in camera matches at home, where
    // after 3 min on the laptop the user types nonstop on an external monitor to the side.
    for (const secondScreenYaw of [25, 40]) {
      const persona: Persona = { ...PERSONAS.baseline, secondScreenYaw };
      const ticks = synthesize(
        [
          ['typing', 3 * MIN],
          ['secondMonitor', 10 * MIN],
        ],
        { persona, seed: 21 },
      ).map((t) => (t.now >= 3 * MIN ? { ...t, context: { ...t.context, idleMs: 500 } } : t));
      const { rec } = cameraEngine(
        createPersonalClassifier(profileFor(PERSONAS.baseline, 43, false)),
        { fallback: createGenericClassifier() },
      );
      rec.synth(ticks);
      const label = `${secondScreenYaw}°`;
      expect(rec.strikes(), label).toEqual([]);
      expect(rec.engine.snapshot().classifier, label).toBe('generic');
      expect(
        rec.of('hint').map((e) => e.code),
        label,
      ).toContain('recalibrate');
      expect(focusShare(rec), label).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('«¡Estaba estudiando!» teaches an uncalibrated study posture and clears the DUDA', () => {
    // Calibrated on the main screen only; then reads on the second monitor without touching
    // the keyboard (typing there would make the rolling stale-profile check fall back to the
    // generic classifier before any DUDA: see the test above).
    let profile = profileFor(PERSONAS.baseline, 41, false);
    const { rec, engine, observer } = cameraEngine(createPersonalClassifier(profile), {
      fallback: createGenericClassifier(),
    });
    const ticks = synthesize(
      [
        ['screen', MIN],
        ['secondMonitor', 4 * MIN],
      ],
      { seed: 19 },
    ).map((t) => (t.now >= MIN ? { ...t, context: { ...t.context, idleMs: t.now } } : t));
    let clicked = false;
    for (const t of ticks) {
      const out = rec.tick({
        now: t.now,
        phase: t.phase,
        context: t.context,
        camera: t.camera,
        frame: t.frame,
      });
      if (!clicked && out.snapshot.state === 'doubt') {
        clicked = true;
        const episode = engine.feedbackEpisode(t.now);
        expect(episode.ok).toBe(true);
        if (!episode.ok) break;
        const learned = learnFromFeedback(profile, episode, { nowIso: '2026-09-28T10:05:00.000Z' });
        expect(learned.ok).toBe(true);
        if (!learned.ok) break;
        profile = learned.profile;
        observer.setClassifier(createPersonalClassifier(profile));
        const events = engine.applyFeedback(t.now, episode.episodeId);
        expect(events.map((e) => e.type)).toEqual(['state', 'doubt_cleared']);
        rec.events.push(...events); // the facade emits these
      }
    }
    expect(clicked).toBe(true);
    expect(rec.of('doubt_cleared').map((e) => e.by)).toContain('feedback');
    // The retrained model now reads the second monitor as studying.
    const later = ticks.filter((x) => x.now > 3 * MIN && x.frame?.face);
    const study = later.map((x) => {
      const p = observer.classifier.predict(x.frame as FrameFeatures);
      return p ? p.screen + p.paper : 0;
    });
    expect(study.reduce((a, b) => a + b, 0) / study.length).toBeGreaterThan(0.6);
    expect(rec.strikes()).toEqual([]);
    expect(rec.warnings('doubt')).toHaveLength(1);
  });

  it('no-camera mode: idle and a distraction app strike, typing clears the doubt', () => {
    const settings = resolveStudyAiSettings({ noCameraIdleMs: 180_000 });
    const engine = new AttentionEngine({
      settings,
      observer: new NoCameraObserver(),
      startedAt: 0,
    });
    const rec = new Recorder(engine);
    let t = 0;
    const run = (ms: number, spec: { idleFrom?: number; foreground?: 'study' | 'distraction' }) => {
      for (const end = t + ms; t < end; t += 1_000) {
        const idleMs = spec.idleFrom === undefined ? 1_000 : t - spec.idleFrom;
        rec.tick({
          now: t,
          camera: 'off',
          context: { foreground: spec.foreground ?? 'study', idleMs },
        });
      }
    };
    run(60_000, {});
    const idleFrom = t;
    run(360_000, { idleFrom }); // study app: limit 1.5 × 3 min = 4.5 min
    expect(rec.strikes().map((s) => s.cause)).toEqual(['doubt_timeout']);
    expect(rec.warnings('absent')).toEqual([]); // no absence path without a camera
    run(30_000, {}); // typing again
    expect(
      rec.of('doubt_cleared').length + rec.of('state').filter((e) => e.to === 'focused').length,
    ).toBeGreaterThan(0);
    run(120_000, { foreground: 'distraction' });
    expect(rec.strikes().at(-1)?.cause).toBe('distraction_app');
    expect(engine.snapshot().presence).toBe('no_camera');
    expect(engine.feedbackEpisode(t)).toEqual({ ok: false, reason: 'no_camera' });
  });
});
