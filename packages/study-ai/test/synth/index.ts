/**
 * Seeded synthetic streams of `FrameFeatures` (numbers only) for every test suite.
 * Owner: DECISION (created by the lead). Other builders import it read-only; ask the
 * coordinator for changes, or build extra fixtures in your own test folder.
 *
 * A script is a list of activities with durations. `synthesize` turns it into ticks the way
 * the real loop would produce them: a face frame every 1000/fps ms, object detector runs
 * every `objectEveryMs` (held between runs), luma every `lumaEveryMs`, and the context
 * (foreground, keyboard/mouse idle time) main would send.
 */
import type {
  Box,
  CalibrationClass,
  CameraStatus,
  ContextSignals,
  FaceFeatures,
  ForegroundClass,
  FrameFeatures,
  LumaFeatures,
  MonoMs,
  ObjectDetection,
  ObjectFeatures,
  PhoneDetection,
  StudyPhase,
} from '../../src/types';
import { PhoneTracker } from '../../src/perception/objects';
import { clamp, clamp01 } from '../../src/util/math';
import { gaussian, mulberry32, uniform, type Rng } from '../../src/util/rng';

export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 240;

// ---------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------

export type PersonaId =
  'baseline' | 'glasses' | 'lowLight' | 'secondMonitor' | 'offAxisCamera' | 'calculator';

export interface Persona {
  id: PersonaId;
  /** Absolute pose (degrees) when looking at the main screen. */
  screen: { yaw: number; pitch: number; roll: number };
  box: Box;
  poseSd: number;
  /** Resting blink value at the screen and blendshape noise. */
  blink: number;
  eyeSd: number;
  /** Extra probability of losing the face on any frame. */
  faceDrop: number;
  quality: number;
  lumaMean: number;
  secondScreenYaw: number;
  /** A calculator or a phone lying on the desk that the detector half-believes. */
  deskPhoneScore: number;
  /**
   * Added to every activity's `lookDown`: the eyes already look down at the screen (a laptop
   * placed low, progressive lenses). 0.4 reads ≈ 0.5 at the screen. Absent = 0.
   */
  lookDownAdd?: number;
  /** Name for test labels of the variants below (their `id` is the persona they vary). */
  label?: string;
}

const BASE: Persona = {
  id: 'baseline',
  screen: { yaw: 0, pitch: -5, roll: 0 },
  box: { cx: 0.5, cy: 0.42, w: 0.22, h: 0.3 },
  poseSd: 3,
  blink: 0.12,
  eyeSd: 0.05,
  faceDrop: 0,
  quality: 0.95,
  lumaMean: 0.45,
  secondScreenYaw: 30,
  deskPhoneScore: 0,
};

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = Object.freeze({
  baseline: BASE,
  glasses: { ...BASE, id: 'glasses', blink: 0.3, eyeSd: 0.2 },
  lowLight: { ...BASE, id: 'lowLight', lumaMean: 0.12, faceDrop: 0.2, poseSd: 5, quality: 0.6 },
  secondMonitor: { ...BASE, id: 'secondMonitor', secondScreenYaw: 35 },
  offAxisCamera: {
    ...BASE,
    id: 'offAxisCamera',
    screen: { yaw: 25, pitch: -15, roll: 2 },
    box: { cx: 0.62, cy: 0.4, w: 0.2, h: 0.28 },
  },
  calculator: { ...BASE, id: 'calculator', deskPhoneScore: 0.5 },
});

/**
 * Variants outside `PERSONAS` (the suites that loop over every persona stay as they are):
 *
 * - `lowScreen`: a laptop placed low, or progressive lenses: `lookDown` ≈ 0.5 at the screen;
 * - `glare`: glasses glare (a lamp turned on after calibration): open eyes read blink ≈ 0.7.
 */
export const LOW_SCREEN_PERSONA: Persona = Object.freeze({
  ...BASE,
  label: 'lowScreen',
  lookDownAdd: 0.4,
});
export const GLARE_PERSONA: Persona = Object.freeze({
  ...BASE,
  id: 'glasses',
  label: 'glare',
  blink: 0.7,
});

// ---------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------

export const ACTIVITIES = [
  'screen',
  'secondMonitor',
  'typing',
  'notebook',
  'readBook',
  'sideNotebook',
  'sideBook',
  'phoneInHand',
  'phoneOnDesk',
  'phoneOnStand',
  'lookAway',
  'talkToSomeone',
  'stretch',
  'coffeeSip',
  'eyesClosed',
  'absent',
  'covered',
  'dark',
  'huntAndPeck',
  'phoneEyeLevel',
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** The activity each calibration situation is recorded with. */
export const CALIBRATION_ACTIVITY: Readonly<Record<CalibrationClass, Activity>> = Object.freeze({
  screen: 'screen',
  paper: 'notebook',
  phone: 'phoneInHand',
  away: 'lookAway',
  absent: 'absent',
});

interface ObjectSpec {
  score: readonly [number, number];
  /** Probability that a detector run sees it. */
  detectP: number;
}

/**
 * Where the phone is: in the hand (in front of the chest, wobbling), lying on the desk, or
 * upright on a stand in front of the user (a Pomodoro or Forest timer). `nearFace`, `moving`
 * and `stillMs` come from PERCEPTION's real `PhoneTracker` on these boxes.
 */
type PhonePlace = 'hand' | 'desk' | 'stand';

interface PhoneSpec extends ObjectSpec {
  place: PhonePlace;
}

/** A phone lying on the desk at the side of the frame (32×19 px at 320×240). */
export const DESK_PHONE_BOX: Box = Object.freeze({ cx: 0.8, cy: 0.9, w: 0.1, h: 0.08 });
/** A phone upright on a stand, right in front of the user's chest (inside the «near» band). */
export const STAND_PHONE_BOX: Box = Object.freeze({ cx: 0.66, cy: 0.78, w: 0.07, h: 0.13 });

interface ActivitySpec {
  /** Offsets from the persona's screen pose (side = ±1, chosen per activity instance). */
  yaw: (p: Persona, side: number) => number;
  pitch: number;
  roll: number;
  poseSd: number;
  blinkAdd: number;
  lookDown: number;
  lookUp: number;
  gazeX: (side: number) => number;
  jaw: number;
  truncated: number;
  boxDy: number;
  faceDrop: number;
  person: number;
  phone: PhoneSpec | null;
  book: ObjectSpec | null;
  /** Horizontal offset of the book box from the face (× side). */
  bookDx?: number;
  /**
   * Periodic glances (deterministic, no extra random draws): for the first `forMs` of every
   * `everyMs` of the step, `lookDown` and the pitch offset are these instead.
   */
  glance?: { lookDown: number; pitch: number; everyMs: number; forMs: number };
  /** Probability per second of a keyboard/mouse event. */
  inputRate: number;
  luma: 'normal' | 'dark' | 'covered';
}

const SCREEN: ActivitySpec = {
  yaw: () => 0,
  pitch: 0,
  roll: 0,
  poseSd: 1,
  blinkAdd: 0,
  lookDown: 0.1,
  lookUp: 0.05,
  gazeX: () => 0,
  jaw: 0.02,
  truncated: 0,
  boxDy: 0,
  faceDrop: 0,
  person: 0.9,
  phone: null,
  book: null,
  inputRate: 0.5,
  luma: 'normal',
};

const NO_FACE = 1;

const SPECS: Readonly<Record<Activity, ActivitySpec>> = {
  screen: SCREEN,
  secondMonitor: { ...SCREEN, yaw: (p) => p.secondScreenYaw, gazeX: () => 0.2 },
  typing: { ...SCREEN, pitch: -15, poseSd: 2, lookDown: 0.35, inputRate: 1 },
  notebook: {
    ...SCREEN,
    pitch: -35,
    poseSd: 2.5,
    blinkAdd: 0.3,
    lookDown: 0.6,
    truncated: 0.1,
    boxDy: 0.06,
    faceDrop: 0.3,
    book: { score: [0.4, 0.7], detectP: 0.3 },
    inputRate: 0,
  },
  readBook: {
    ...SCREEN,
    pitch: -25,
    poseSd: 2,
    blinkAdd: 0.2,
    lookDown: 0.5,
    truncated: 0.15,
    boxDy: 0.04,
    faceDrop: 0.1,
    book: { score: [0.5, 0.9], detectP: 0.6 },
    inputRate: 0,
  },
  /** Writing in a notebook lying next to the laptop, 40° to one side. */
  sideNotebook: {
    ...SCREEN,
    yaw: (_p, side) => side * 40,
    pitch: -35,
    poseSd: 2.5,
    blinkAdd: 0.3,
    lookDown: 0.6,
    truncated: 0.1,
    boxDy: 0.06,
    faceDrop: 0.3,
    book: { score: [0.4, 0.7], detectP: 0.3 },
    bookDx: 0.3,
    inputRate: 0,
  },
  /** Reading a textbook lying next to the laptop, 40° to one side. */
  sideBook: {
    ...SCREEN,
    yaw: (_p, side) => side * 40,
    pitch: -25,
    poseSd: 2,
    blinkAdd: 0.2,
    lookDown: 0.5,
    truncated: 0.15,
    boxDy: 0.04,
    faceDrop: 0.1,
    book: { score: [0.5, 0.9], detectP: 0.6 },
    bookDx: 0.3,
    inputRate: 0,
  },
  phoneInHand: {
    ...SCREEN,
    pitch: -30,
    poseSd: 2.5,
    blinkAdd: 0.2,
    lookDown: 0.6,
    boxDy: 0.04,
    faceDrop: 0.1,
    phone: { score: [0.5, 0.9], detectP: 0.7, place: 'hand' },
    inputRate: 0,
  },
  phoneOnDesk: {
    ...SCREEN,
    phone: { score: [0.45, 0.6], detectP: 0.5, place: 'desk' },
  },
  phoneOnStand: {
    ...SCREEN,
    phone: { score: [0.7, 0.9], detectP: 0.8, place: 'stand' },
  },
  lookAway: {
    ...SCREEN,
    yaw: (_p, side) => side * 50,
    pitch: 5,
    poseSd: 3,
    gazeX: (side) => side * 0.3,
    inputRate: 0,
  },
  talkToSomeone: {
    ...SCREEN,
    yaw: (_p, side) => side * 45,
    poseSd: 3,
    jaw: 0.35,
    gazeX: (side) => side * 0.2,
    inputRate: 0,
  },
  stretch: { ...SCREEN, yaw: (_p, side) => side * 20, pitch: 25, poseSd: 5, inputRate: 0 },
  coffeeSip: { ...SCREEN, pitch: 10, truncated: 0.2, inputRate: 0.3 },
  eyesClosed: { ...SCREEN, pitch: -5, blinkAdd: 0.8, lookDown: 0.2, inputRate: 0 },
  absent: { ...SCREEN, faceDrop: NO_FACE, person: 0.05, inputRate: 0 },
  covered: { ...SCREEN, faceDrop: NO_FACE, person: 0, luma: 'covered', inputRate: 1 },
  dark: { ...SCREEN, poseSd: 2, faceDrop: 0.2, luma: 'dark' },
  /** Typing while looking at the keys two seconds out of three (eyes and head down). */
  huntAndPeck: {
    ...SCREEN,
    poseSd: 2,
    inputRate: 1,
    glance: { lookDown: 0.6, pitch: -10, everyMs: 3_000, forMs: 2_000 },
  },
  /** A phone held up at eye level in front of the screen: head level, eyes barely down. */
  phoneEyeLevel: {
    ...SCREEN,
    poseSd: 2,
    lookDown: 0.2,
    faceDrop: 0.05,
    phone: { score: [0.5, 0.9], detectP: 0.7, place: 'hand' },
    inputRate: 0,
  },
};

// ---------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------

export interface ScriptStep {
  activity: Activity;
  ms: number;
  foreground?: ForegroundClass;
  camera?: CameraStatus;
  /** Guardian phase during the step (`work`). */
  phase?: StudyPhase;
}

export type Script = readonly (ScriptStep | readonly [Activity, number])[];

export interface SynthOptions {
  persona?: Persona;
  /** Face frames per second (3). */
  fps?: number;
  seed?: number;
  /** Object detector period (1 000). */
  objectEveryMs?: number;
  /** Luma thumbnail period (1 000). */
  lumaEveryMs?: number;
  /** First tick time (0). */
  startAt?: MonoMs;
  /** ± uniform jitter on frame times (20). */
  jitterMs?: number;
  /** Default foreground (`study`). */
  foreground?: ForegroundClass;
  /** Detector jitter on each edge of a phone box, in pixels (1). */
  phoneJitterPx?: number;
}

export interface SynthTick {
  now: MonoMs;
  activity: Activity;
  frame: FrameFeatures | null;
  context: ContextSignals;
  camera: CameraStatus;
  phase: StudyPhase;
}

const OBJECT_HOLD_MS = 4_000;
const LUMA_HOLD_MS = 2_000;

function norm(step: ScriptStep | readonly [Activity, number]): ScriptStep {
  return 'activity' in step ? step : { activity: step[0], ms: step[1] };
}

function range(rng: Rng, [min, max]: readonly [number, number]): number {
  return uniform(rng, min, max);
}

function boxAround(face: Box, dx: number, dy: number, w: number, h: number): Box {
  return { cx: clamp01(face.cx + dx), cy: clamp01(face.cy + dy), w, h };
}

/** The extractor uses the last face box for `nearFace` while it is ≤ 10 s old. */
const FACE_MEMORY_MS = 10_000;

/** `box` with Gaussian noise of `sd` pixels on each of its four edges, clipped to the frame. */
function jitterBox(rng: Rng, box: Box, sd: number): Box {
  const x0 = clamp((box.cx - box.w / 2) * FRAME_WIDTH + gaussian(rng, 0, sd), 0, FRAME_WIDTH);
  const x1 = clamp((box.cx + box.w / 2) * FRAME_WIDTH + gaussian(rng, 0, sd), 0, FRAME_WIDTH);
  const y0 = clamp((box.cy - box.h / 2) * FRAME_HEIGHT + gaussian(rng, 0, sd), 0, FRAME_HEIGHT);
  const y1 = clamp((box.cy + box.h / 2) * FRAME_HEIGHT + gaussian(rng, 0, sd), 0, FRAME_HEIGHT);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  return {
    cx: (x0 + x1) / 2 / FRAME_WIDTH,
    cy: (y0 + y1) / 2 / FRAME_HEIGHT,
    w: w / FRAME_WIDTH,
    h: h / FRAME_HEIGHT,
  };
}

export function synthesize(script: Script, options: SynthOptions = {}): SynthTick[] {
  const persona = options.persona ?? PERSONAS.baseline;
  const fps = options.fps ?? 3;
  const rng = mulberry32(options.seed ?? 1);
  const objectEveryMs = options.objectEveryMs ?? 1_000;
  const lumaEveryMs = options.lumaEveryMs ?? 1_000;
  const jitterMs = options.jitterMs ?? 20;
  const phoneJitterPx = options.phoneJitterPx ?? 1;
  // Box jitter has its own stream, so the rest of a seeded script does not depend on it.
  const boxRng = mulberry32(((options.seed ?? 1) ^ 0x5eed_b0c5) >>> 0);
  const phones = new PhoneTracker();
  let lastFaceBox: Box | null = null;
  let lastFaceAt = Number.NEGATIVE_INFINITY;
  const interval = 1_000 / fps;
  const ticks: SynthTick[] = [];

  let t = options.startAt ?? 0;
  let lastInputAt = t;
  let nextObjectAt = t;
  let nextLumaAt = t;
  let heldObjects: ObjectFeatures | null = null;
  let heldLuma: LumaFeatures | null = null;
  let prevLumaMean = persona.lumaMean;

  for (const raw of script) {
    const step = norm(raw);
    const spec = SPECS[step.activity];
    const side = rng() < 0.5 ? -1 : 1;
    const stepStart = t;
    const end = t + step.ms;
    const foreground = step.foreground ?? options.foreground ?? 'study';
    const camera = step.camera ?? 'ok';
    const phase = step.phase ?? 'work';

    while (t < end) {
      const dt = interval + uniform(rng, -jitterMs, jitterMs);
      // inputRate ≥ 1 means continuous typing; otherwise a Poisson-ish event rate per second.
      if (spec.inputRate >= 1 || rng() < spec.inputRate * (dt / 1_000)) lastInputAt = t;

      const lost = rng() < Math.min(1, spec.faceDrop + persona.faceDrop);
      let face: FaceFeatures | null = null;
      const sd = persona.poseSd * spec.poseSd;
      const box: Box = {
        cx: clamp01(persona.box.cx + gaussian(rng, 0, 0.01)),
        cy: clamp01(persona.box.cy + spec.boxDy + gaussian(rng, 0, 0.01)),
        w: persona.box.w * (1 + gaussian(rng, 0, 0.02)),
        h: persona.box.h * (1 + gaussian(rng, 0, 0.02)),
      };
      const glance = spec.glance;
      const glancing = glance !== undefined && (t - stepStart) % glance.everyMs < glance.forMs;
      const pitch = glancing ? glance.pitch : spec.pitch;
      const lookDown = (glancing ? glance.lookDown : spec.lookDown) + (persona.lookDownAdd ?? 0);
      if (!lost && camera === 'ok') {
        face = {
          pose: {
            yaw: persona.screen.yaw + spec.yaw(persona, side) + gaussian(rng, 0, sd),
            pitch: persona.screen.pitch + pitch + gaussian(rng, 0, sd),
            roll: persona.screen.roll + spec.roll + gaussian(rng, 0, sd / 2),
          },
          box,
          truncated: clamp01(spec.truncated + gaussian(rng, 0, 0.02)),
          blink: clamp01(persona.blink + spec.blinkAdd + gaussian(rng, 0, persona.eyeSd)),
          lookDown: clamp01(lookDown + gaussian(rng, 0, persona.eyeSd)),
          lookUp: clamp01(spec.lookUp + gaussian(rng, 0, persona.eyeSd / 2)),
          gazeX: clamp(spec.gazeX(side) + gaussian(rng, 0, persona.eyeSd), -1, 1),
          jawOpen: clamp01(spec.jaw + gaussian(rng, 0, 0.03)),
          jitter: Math.abs(gaussian(rng, 0, persona.id === 'lowLight' ? 0.02 : 0.005)),
          faces: 1,
        };
        lastFaceBox = box;
        lastFaceAt = t;
      }
      if (camera !== 'ok') phones.reset(); // the session resets vision after a camera restart

      // Object detector
      let objects: ObjectFeatures | null = null;
      if (camera === 'ok' && t >= nextObjectAt) {
        // Fixed cadence on average (like "every N frames" in the real loop), no catch-up burst.
        nextObjectAt = Math.max(nextObjectAt + objectEveryMs, t + objectEveryMs / 2);
        const phoneSpec: PhoneSpec | null =
          spec.phone ??
          (persona.deskPhoneScore > 0 && step.activity !== 'absent' && step.activity !== 'covered'
            ? {
                score: [persona.deskPhoneScore - 0.15, persona.deskPhoneScore + 0.1],
                detectP: 0.5,
                place: 'desk',
              }
            : null);
        const seen: ObjectDetection[] = [];
        if (phoneSpec && rng() < phoneSpec.detectP) {
          rng(); // (was the «moving» draw; kept so seeded scripts keep their other values)
          const where: Box =
            phoneSpec.place === 'hand'
              ? boxAround(box, gaussian(rng, 0, 0.05), box.h * 0.9, 0.12, 0.18)
              : phoneSpec.place === 'stand'
                ? STAND_PHONE_BOX
                : DESK_PHONE_BOX;
          seen.push({
            score: range(rng, phoneSpec.score),
            box: jitterBox(boxRng, where, phoneJitterPx),
          });
        }
        const faceBox = t - lastFaceAt <= FACE_MEMORY_MS ? lastFaceBox : null;
        const phone: PhoneDetection | null = phones.update(
          seen,
          t,
          faceBox,
          FRAME_WIDTH,
          FRAME_HEIGHT,
        );
        let book: ObjectDetection | null = null;
        if (spec.book && rng() < spec.book.detectP) {
          const dx = (spec.bookDx ?? 0) * side;
          book = { score: range(rng, spec.book.score), box: boxAround(box, dx, 0.45, 0.35, 0.2) };
        }
        let person: ObjectDetection | null = null;
        const personScore = spec.person + gaussian(rng, 0, 0.03);
        if (personScore > 0.3) {
          person = { score: clamp01(personScore), box: boxAround(box, 0, 0.2, 0.6, 0.8) };
        }
        heldObjects = { ranAt: t, ageMs: 0, fresh: true, phone, book, person };
        objects = heldObjects;
      } else if (camera === 'ok' && heldObjects && t - heldObjects.ranAt <= OBJECT_HOLD_MS) {
        objects = { ...heldObjects, ageMs: t - heldObjects.ranAt, fresh: false };
      }

      // Luma
      let luma: LumaFeatures | null = null;
      if (camera === 'ok' && t >= nextLumaAt) {
        nextLumaAt = Math.max(nextLumaAt + lumaEveryMs, t + lumaEveryMs / 2);
        const covered = spec.luma === 'covered';
        const mean = covered
          ? 0.03
          : clamp01((spec.luma === 'dark' ? 0.12 : persona.lumaMean) + gaussian(rng, 0, 0.01));
        heldLuma = {
          at: t,
          mean,
          spatialStd: covered ? 0.01 : 0.12,
          temporalDiff: covered ? 0.001 : Math.abs(mean - prevLumaMean) + 0.01,
          motionNearFace: face ? 0.02 : spec.person > 0.3 ? 0.03 : 0.003,
          covered,
          lowLight: !covered && mean < 0.18,
        };
        prevLumaMean = mean;
        luma = heldLuma;
      } else if (camera === 'ok' && heldLuma && t - heldLuma.at <= LUMA_HOLD_MS) {
        luma = heldLuma;
      }

      const frame: FrameFeatures | null =
        camera === 'ok'
          ? {
              t,
              width: FRAME_WIDTH,
              height: FRAME_HEIGHT,
              face,
              objects,
              luma,
              quality: face
                ? clamp(persona.quality - 0.5 * face.truncated + gaussian(rng, 0, 0.02), 0.2, 1)
                : objects?.person
                  ? 0.6
                  : 0.2,
            }
          : null;

      ticks.push({
        now: t,
        activity: step.activity,
        frame,
        context: { foreground, idleMs: Math.max(0, t - lastInputAt) },
        camera,
        phase,
      });
      t += dt;
    }
  }
  return ticks;
}

/** Frames of one calibration situation (20 s at 4 fps, objects at 2 Hz). */
export function calibrationFrames(
  cls: CalibrationClass,
  options: Omit<SynthOptions, 'fps' | 'objectEveryMs'> = {},
): FrameFeatures[] {
  return synthesize([[CALIBRATION_ACTIVITY[cls], 20_000]], {
    ...options,
    fps: 4,
    objectEveryMs: 500,
  })
    .map((tick) => tick.frame)
    .filter((frame): frame is FrameFeatures => frame !== null);
}
