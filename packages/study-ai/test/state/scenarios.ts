/** Shared scenario runner and scripts for the synth engine suites. */
import type { AttentionClassifier, StudyAiSettings, Presence } from '../../src/types';
import { PERSONAS, synthesize, type Persona, type Script, type ScriptStep } from '../synth';
import { cameraEngine, oracleClassifier, type Recorder } from './harness';

export interface ScenarioOptions {
  persona?: Persona;
  fps?: number;
  seed?: number;
  settings?: Partial<StudyAiSettings>;
  classifier?: AttentionClassifier;
  fallback?: AttentionClassifier | null;
}

export interface ScenarioResult {
  rec: Recorder;
  /** Time of the first observation with each presence. */
  firstPresence: Map<Presence, number>;
  /** Time of the first tick of each script step (by index). */
  stepStarts: number[];
}

export function runScenario(script: Script, options: ScenarioOptions = {}): ScenarioResult {
  const persona = options.persona ?? PERSONAS.baseline;
  const classifier = options.classifier ?? oracleClassifier({ persona });
  const { rec } = cameraEngine(classifier, {
    settings: options.settings,
    fallback: options.fallback ?? null,
  });
  const ticks = synthesize(script, { persona, fps: options.fps ?? 3, seed: options.seed ?? 1 });
  const firstPresence = new Map<Presence, number>();
  const stepStarts: number[] = [];
  let boundary = 0;
  let index = 0;
  const lengths = script.map((s) => ('activity' in s ? s.ms : s[1]));
  for (const t of ticks) {
    while (index < lengths.length && t.now >= boundary) {
      stepStarts.push(t.now);
      boundary += lengths[index] as number;
      index += 1;
    }
    const out = rec.tick({
      now: t.now,
      phase: t.phase,
      context: t.context,
      camera: t.camera,
      frame: t.frame,
    });
    const p = out.observation.presence;
    if (!firstPresence.has(p)) firstPresence.set(p, t.now);
  }
  return { rec, firstPresence, stepStarts };
}

/** Share of work time credited as focused. */
export function focusShare(rec: Recorder): number {
  const totals = rec.engine.totals();
  return totals.workMs > 0 ? totals.focusedMs / totals.workMs : 0;
}

const MIN = 60_000;

function repeat(
  n: number,
  steps: readonly (ScriptStep | readonly [ScriptStep['activity'], number])[],
) {
  return Array.from({ length: n }, () => steps).flat();
}

/** Study-only scripts that must never strike (DESIGN.md §7.12, false positives). */
export const STUDY_SCRIPTS: Readonly<Record<string, Script>> = Object.freeze({
  screen: [['screen', 20 * MIN]],
  notebook: [
    ['typing', 30_000],
    ['notebook', 20 * MIN],
  ],
  readBook: [
    ['typing', 30_000],
    ['readBook', 20 * MIN],
  ],
  /** A notebook or a textbook next to the laptop, 40° to the side (yaw ±40, head down). */
  sideNotebook: [
    ['typing', 30_000],
    ['sideNotebook', 20 * MIN],
  ],
  sideBook: [
    ['typing', 30_000],
    ['sideBook', 20 * MIN],
  ],
  /** Copying from a book at the side into the laptop. */
  copyFromSideBook: repeat(20, [
    ['typing', 20_000],
    ['sideBook', 40_000],
  ]),
  secondMonitor: repeat(5, [
    ['screen', 2 * MIN],
    ['secondMonitor', 2 * MIN],
  ]),
  typing: [['typing', 20 * MIN]],
  coffeeSip: repeat(10, [
    ['screen', 110_000],
    ['coffeeSip', 10_000],
  ]),
  phoneOnDesk: [['phoneOnDesk', 20 * MIN]],
  /** Upright on a stand in front of the chest, a Pomodoro timer the detector is sure of. */
  phoneOnStand: [['phoneOnStand', 20 * MIN]],
  stretch: repeat(6, [
    ['screen', 3 * MIN],
    ['stretch', 20_000],
  ]),
});
