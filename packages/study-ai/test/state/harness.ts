/**
 * DECISION test harness: an oracle classifier (fixed rules over the synth personas' pose), a
 * scripted observer for exact state-machine timings, and a runner that feeds ticks to an
 * engine and collects what it emitted.
 */
import { CameraObserver } from '../../src/score/camera-observer';
import { phoneInHandOn } from '../../src/score/evidence';
import { AttentionEngine } from '../../src/state/engine';
import { resolveStudyAiSettings } from '../../src/config';
import type {
  AttentionClassifier,
  AttentionEvent,
  CameraStatus,
  ClassProbabilities,
  ClassifierKind,
  ClassifierThresholds,
  ContextSignals,
  EyeModel,
  FaceFeatures,
  FrameFeatures,
  LowCause,
  MonoMs,
  Observation,
  ObservationEvidence,
  Observer,
  Presence,
  RelativePose,
  StrikeCause,
  StudyAiSettings,
  StudyMode,
  StudyPhase,
  TickInput,
  TickOutput,
} from '../../src/types';
import { PERSONAS, type Persona, type SynthTick } from '../synth';

// ---------------------------------------------------------------------------------------
// Oracle classifier
// ---------------------------------------------------------------------------------------

export const GENERIC_LIKE_EYES: EyeModel = Object.freeze({
  reliable: true,
  blinkFit: Object.freeze([0.15, -0.004] as const),
  closedDelta: 0.45,
});

export interface OracleOptions {
  kind?: ClassifierKind;
  persona?: Persona;
  thresholds?: Partial<ClassifierThresholds>;
  trust?: { phone: number; away: number };
  eyes?: EyeModel;
  /** Replaces the rule-based answer. */
  predict?: (frame: FrameFeatures) => ClassProbabilities | null;
}

export interface OracleClassifier extends AttentionClassifier {
  observed: number;
}

export function probs(p: Partial<Record<keyof ClassProbabilities, number>>): ClassProbabilities {
  return Object.freeze({
    screen: p.screen ?? 0,
    paper: p.paper ?? 0,
    phone: p.phone ?? 0,
    away: p.away ?? 0,
    absent: p.absent ?? 0,
  });
}

/**
 * What a well-calibrated personal classifier answers for the synth personas: study when the
 * head points at the screen, the second monitor or down at the desk; a phone in hand is
 * `phone`; anything else is `away`. Faceless frames with a person get the hidden cap (0.2).
 */
export function oracleClassifier(options: OracleOptions = {}): OracleClassifier {
  const persona = options.persona ?? PERSONAS.baseline;
  const thresholds = Object.freeze({ phone: 0.5, person: 0.5, ...options.thresholds });
  const base = persona.screen;
  const relativePose = (face: FaceFeatures): RelativePose => ({
    dyaw: face.pose.yaw - base.yaw,
    dpitch: face.pose.pitch - base.pitch,
    droll: face.pose.roll - base.roll,
    dcx: 0,
    dcy: 0,
    logScale: 0,
  });
  const rulePredict = (frame: FrameFeatures): ClassProbabilities | null => {
    const face = frame.face;
    if (!face) {
      const person = frame.objects?.person?.score ?? 0;
      if (person < thresholds.person) return null;
      return probs({ screen: 0.1, paper: 0.1, away: 0.8 });
    }
    if (phoneInHandOn(frame, thresholds.phone))
      return probs({ phone: 0.9, paper: 0.05, away: 0.05 });
    const rel = relativePose(face);
    const toScreen = Math.hypot(rel.dyaw, rel.dpitch);
    const toSecond = Math.hypot(rel.dyaw - persona.secondScreenYaw, rel.dpitch);
    const toDesk = Math.hypot(rel.dyaw, Math.max(0, Math.abs(rel.dpitch + 30) - 15));
    if (toScreen <= 22 || toSecond <= 15) return probs({ screen: 0.9, paper: 0.05, away: 0.05 });
    if (toDesk <= 15) return probs({ paper: 0.9, screen: 0.05, away: 0.05 });
    return probs({ away: 0.9, screen: 0.05, paper: 0.05 });
  };
  const oracle: OracleClassifier = {
    kind: options.kind ?? 'personal',
    ready: true,
    thresholds,
    trust: Object.freeze({ ...(options.trust ?? { phone: 0, away: 0 }) }),
    eyes: options.eyes ?? GENERIC_LIKE_EYES,
    predict: options.predict ?? rulePredict,
    relativePose,
    observe: () => {
      oracle.observed += 1;
    },
    observed: 0,
  };
  return oracle;
}

// ---------------------------------------------------------------------------------------
// Scripted observer (exact timings without perception)
// ---------------------------------------------------------------------------------------

export interface ObservationSpec {
  presence?: Presence;
  study?: number | null;
  weight?: number;
  cause?: LowCause | null;
  evidence?: Partial<ObservationEvidence>;
  eyes?: { closed?: boolean; yawn?: boolean };
  hints?: Observation['hints'];
  frame?: FrameFeatures | null;
}

export const NO_EVIDENCE: ObservationEvidence = Object.freeze({
  phone: false,
  book: false,
  lookingDown: false,
  distractionApp: false,
  inputActive: false,
});

export function observation(at: MonoMs, spec: ObservationSpec = {}): Observation {
  const presence = spec.presence ?? 'visible';
  const pushed = presence === 'visible' || presence === 'hidden' || presence === 'no_camera';
  return {
    at,
    presence,
    study: spec.study === undefined ? (pushed ? 1 : null) : spec.study,
    weight: spec.weight ?? 1,
    cause: spec.cause ?? null,
    evidence: { ...NO_EVIDENCE, ...spec.evidence },
    eyes: { closed: spec.eyes?.closed ?? false, yawn: spec.eyes?.yawn ?? false },
    hints: spec.hints ?? [],
    frame: spec.frame ?? null,
    rel: null,
  };
}

/** Returns whatever `script(input)` says; rescoring uses `rescoreWith` when set. */
export class ScriptedObserver implements Observer {
  resets = 0;
  rescoreWith: ((o: Observation) => number | null) | null = null;

  constructor(
    public script: (input: TickInput) => ObservationSpec,
    public readonly mode: StudyMode = 'camera',
  ) {}

  observe(input: TickInput, _settings: Readonly<StudyAiSettings>): Observation {
    return observation(input.now, this.script(input));
  }

  rescore(o: Observation, _settings: Readonly<StudyAiSettings>): number | null {
    return this.rescoreWith ? this.rescoreWith(o) : o.study;
  }

  reset(): void {
    this.resets += 1;
  }
}

// ---------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------

export const STUDY_CONTEXT: ContextSignals = Object.freeze({ foreground: 'study', idleMs: 1_000 });

export interface TickSpec {
  now: MonoMs;
  phase?: StudyPhase;
  context?: ContextSignals;
  camera?: CameraStatus;
  frame?: FrameFeatures | null;
}

export class Recorder {
  readonly events: AttentionEvent[] = [];
  readonly outputs: TickOutput[] = [];

  constructor(
    readonly engine: AttentionEngine,
    private readonly keepOutputs = false,
  ) {}

  tick(spec: TickSpec): TickOutput {
    const out = this.engine.tick({
      now: spec.now,
      phase: spec.phase ?? 'work',
      context: spec.context ?? STUDY_CONTEXT,
      camera: spec.camera ?? 'ok',
      frame: spec.frame ?? null,
    });
    this.events.push(...out.events);
    if (this.keepOutputs) this.outputs.push(out);
    return out;
  }

  /** Ticks every `stepMs` from `from` (inclusive) to `to` (exclusive). */
  run(from: MonoMs, to: MonoMs, stepMs: number, spec: Omit<TickSpec, 'now'> = {}): MonoMs {
    let t = from;
    for (; t < to; t += stepMs) this.tick({ ...spec, now: t });
    return t;
  }

  synth(ticks: readonly SynthTick[]): void {
    for (const t of ticks) {
      this.tick({
        now: t.now,
        phase: t.phase,
        context: t.context,
        camera: t.camera,
        frame: t.frame,
      });
    }
  }

  of<T extends AttentionEvent['type']>(type: T): Extract<AttentionEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<AttentionEvent, { type: T }> => e.type === type);
  }

  strikes(): { at: MonoMs; cause: StrikeCause }[] {
    return this.of('strike').map((e) => ({ at: e.at, cause: e.cause }));
  }

  warnings(kind?: 'doubt' | 'absent'): MonoMs[] {
    return this.of('warning')
      .filter((e) => kind === undefined || e.kind === kind)
      .map((e) => e.at);
  }

  firstStateAt(to: string): MonoMs | null {
    return this.of('state').find((e) => e.to === to)?.at ?? null;
  }
}

export function scriptedEngine(
  script: (input: TickInput) => ObservationSpec,
  settings: Partial<StudyAiSettings> = {},
  mode: StudyMode = 'camera',
): { engine: AttentionEngine; observer: ScriptedObserver; rec: Recorder } {
  const observer = new ScriptedObserver(script, mode);
  const engine = new AttentionEngine({
    settings: resolveStudyAiSettings(settings),
    observer,
    startedAt: 0,
  });
  return { engine, observer, rec: new Recorder(engine) };
}

export function cameraEngine(
  classifier: AttentionClassifier,
  options: {
    settings?: Partial<StudyAiSettings>;
    fallback?: AttentionClassifier | null;
    startedAt?: MonoMs;
    keepOutputs?: boolean;
  } = {},
): { engine: AttentionEngine; observer: CameraObserver; rec: Recorder } {
  const observer = new CameraObserver({ classifier, fallback: options.fallback ?? null });
  const engine = new AttentionEngine({
    settings: resolveStudyAiSettings(options.settings),
    observer,
    startedAt: options.startedAt ?? 0,
  });
  return { engine, observer, rec: new Recorder(engine, options.keepOutputs ?? false) };
}
