/**
 * App-only preferences of the Phase 5 features (docs/DESKTOP.md §15): «Avisos grandes» (OSD),
 * concentration sounds, reminders, global shortcuts, the mini timer, the custom Pomodoro and
 * the onboarding progress. They live in `UiPrefs` (`prefs.json`, applied at once through
 * `prefs:set`), next to the Phase 1 fields; the guardian's own settings (daily goal,
 * penalties…) are separate (`settings:get` / `settings:put`).
 *
 * This module holds their types, defaults and the field-by-field validators that
 * `src/main/db/prefs-store.ts` delegates to: a damaged or older `prefs.json` falls back to
 * the default of each field, and a `prefs:set` patch is refused unless every key is known and
 * every value valid. Nested patches merge (`{ sounds: { volume: 40 } }` keeps the rest).
 *
 * Pure module: no DOM, Node or Electron imports.
 */
import { POMODORO_PRESETS } from '@centrate/shared/points';

// ---------------------------------------------------------------------------------------
// Sounds (PROMPT §9 «Sonidos de concentración», resources/sounds/README.md)
// ---------------------------------------------------------------------------------------

/** The three offline loops, in the order «Sonido» cycles through them after «Nada». */
export const SOUND_IDS = ['rain', 'white-noise', 'lofi'] as const;
export type SoundId = (typeof SOUND_IDS)[number];

/**
 * File of each loop in `apps/desktop/resources/sounds/` (packaged as
 * `process.resourcesPath/sounds`). Main reads it for `sounds:load`; nothing else touches it.
 */
export const SOUND_FILES: Readonly<Record<SoundId, string>> = Object.freeze({
  rain: 'lluvia.wav',
  'white-noise': 'ruido-blanco.wav',
  lofi: 'lo-fi.wav',
});

/** `none` = silence («Sonido: Nada»). */
export type AmbientSound = 'none' | SoundId;

export interface SoundPrefs {
  /** The loop «Sonido: …» plays (`none`: silence). */
  ambient: AmbientSound;
  /** App volume over the −20 LUFS files, 0–100. */
  volume: number;
  /** Play `ambient` on its own while a block is active (off: only when started by hand). */
  autoplay: boolean;
}

// ---------------------------------------------------------------------------------------
// Reminders (PROMPT §9 «Recordatorios»)
// ---------------------------------------------------------------------------------------

/** How long before a schedule starts «Es tu hora de estudiar» is shown (0 = at the start). */
export const REMINDER_LEAD_MINUTES = [0, 5, 10, 15] as const;
export type ReminderLeadMinutes = (typeof REMINDER_LEAD_MINUTES)[number];

/** The 20-20-20 rule: every 20 min of a block, look 6 m away for 20 s. */
export const EYE_BREAK_RULE = Object.freeze({ everyMinutes: 20, lookSeconds: 20 });

export interface ReminderPrefs {
  /** «Es tu hora de estudiar» before each enabled schedule. */
  schedules: boolean;
  leadMinutes: ReminderLeadMinutes;
  /** 20-20-20 eye breaks while a block is active. */
  eyeBreaks: boolean;
}

// ---------------------------------------------------------------------------------------
// Global shortcuts (Ajustes › General «Atajo global»; each one shows the OSD)
// ---------------------------------------------------------------------------------------

export const SHORTCUT_ACTIONS = [
  /** Show or hide the main window (like a tray click). */
  'toggle-main',
  /** +15 min on the primary block (the 5 s undo queue; the OSD says «+15 min · hasta 18:12»). */
  'extend-15',
  /** Show or hide the mini timer. */
  'toggle-mini-timer',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Electron accelerator per action (`CommandOrControl+Alt+C`); `null` = not registered. */
export type ShortcutPrefs = Readonly<Record<ShortcutAction, string | null>>;

const ACCELERATOR_MODIFIERS = new Set([
  'Command',
  'Cmd',
  'Control',
  'Ctrl',
  'CommandOrControl',
  'CmdOrCtrl',
  'Alt',
  'Option',
  'AltGr',
  'Shift',
  'Super',
  'Meta',
]);

const ACCELERATOR_KEY_RE =
  /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Plus|[,./;'[\]\\`=-])$/;

/**
 * A global shortcut the app may register: one or more modifiers (at least one of
 * Command/Control/Alt/Super, so a bare letter never becomes global) and exactly one key.
 */
export function isAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  const parts = value.split('+');
  const key = parts.pop();
  if (key === undefined || !ACCELERATOR_KEY_RE.test(key) || parts.length === 0) return false;
  if (!parts.every((p) => ACCELERATOR_MODIFIERS.has(p))) return false;
  if (new Set(parts).size !== parts.length) return false;
  return parts.some((p) => p !== 'Shift');
}

// ---------------------------------------------------------------------------------------
// Mini timer (PROMPT §10: 180×44, frameless, always on top, draggable, remembers its place)
// ---------------------------------------------------------------------------------------

export interface MiniTimerPrefs {
  visible: boolean;
  /** Top-left corner in DIP (screen coordinates, may be negative); `null` = default corner. */
  position: { x: number; y: number } | null;
}

/** Mini timer content size in DIP. */
export const MINI_TIMER_SIZE = Object.freeze({ width: 180, height: 44 });

// ---------------------------------------------------------------------------------------
// Pomodoro (PROMPT §9: 25/5 and 50/10, customisable)
// ---------------------------------------------------------------------------------------

export interface PomodoroPrefs {
  /** The «Personalizado» preset (25/5 and 50/10 are `POMODORO_PRESETS`). */
  workMinutes: number;
  breakMinutes: number;
  cycles: number;
}

/** Bounds of the custom Pomodoro (work 5–120 min, break 1–60 min, 1–12 cycles). */
export const POMODORO_LIMITS = Object.freeze({
  workMinutes: { min: 5, max: 120 },
  breakMinutes: { min: 1, max: 60 },
  cycles: { min: 1, max: 12 },
});

// ---------------------------------------------------------------------------------------
// Onboarding (PROMPT §9, §10: five steps, the main window centred)
// ---------------------------------------------------------------------------------------

/** Bienvenida → guardián → extensión → cámara (optional) → primer bloqueo. */
export const ONBOARDING_STEPS = [
  'welcome',
  'guardian',
  'extension',
  'camera',
  'first-block',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingPrefs {
  /** Finished or skipped: never shown again (Ajustes can restart it). */
  done: boolean;
  /** The step shown (resumed after a restart). */
  step: OnboardingStep;
}

// ---------------------------------------------------------------------------------------
// The group as stored and patched
// ---------------------------------------------------------------------------------------

/** The Phase 5 fields of `UiPrefs`. */
export interface FeaturePrefs {
  /** «Avisos grandes» (the OSD) on or off. */
  osd: boolean;
  sounds: SoundPrefs;
  reminders: ReminderPrefs;
  shortcuts: ShortcutPrefs;
  miniTimer: MiniTimerPrefs;
  pomodoro: PomodoroPrefs;
  onboarding: OnboardingPrefs;
}

/** `prefs:set` for the Phase 5 fields: nested objects merge key by key. */
export interface FeaturePrefsPatch {
  osd?: boolean;
  sounds?: Partial<SoundPrefs>;
  reminders?: Partial<ReminderPrefs>;
  shortcuts?: Partial<Record<ShortcutAction, string | null>>;
  miniTimer?: Partial<MiniTimerPrefs>;
  pomodoro?: Partial<PomodoroPrefs>;
  onboarding?: Partial<OnboardingPrefs>;
}

export const FEATURE_PREF_KEYS = [
  'osd',
  'sounds',
  'reminders',
  'shortcuts',
  'miniTimer',
  'pomodoro',
  'onboarding',
] as const satisfies readonly (keyof FeaturePrefs)[];
export type FeaturePrefKey = (typeof FEATURE_PREF_KEYS)[number];

const DEFAULT_POMODORO = POMODORO_PRESETS[0] ?? {
  workMinutes: 25,
  breakMinutes: 5,
  cycles: 4,
};

const FEATURE_DEFAULTS: FeaturePrefs = {
  osd: true,
  sounds: { ambient: 'none', volume: 60, autoplay: false },
  reminders: { schedules: true, leadMinutes: 5, eyeBreaks: false },
  shortcuts: {
    'toggle-main': 'CommandOrControl+Alt+C',
    'extend-15': null,
    'toggle-mini-timer': null,
  },
  miniTimer: { visible: false, position: null },
  pomodoro: {
    workMinutes: DEFAULT_POMODORO.workMinutes,
    breakMinutes: DEFAULT_POMODORO.breakMinutes,
    cycles: DEFAULT_POMODORO.cycles,
  },
  onboarding: { done: false, step: 'welcome' },
};

/** Defaults of a fresh install (frozen, nested objects too: copy before changing). */
export const DEFAULT_FEATURE_PREFS: Readonly<FeaturePrefs> = Object.freeze({
  ...FEATURE_DEFAULTS,
  sounds: Object.freeze(FEATURE_DEFAULTS.sounds),
  reminders: Object.freeze(FEATURE_DEFAULTS.reminders),
  shortcuts: Object.freeze(FEATURE_DEFAULTS.shortcuts),
  miniTimer: Object.freeze(FEATURE_DEFAULTS.miniTimer),
  pomodoro: Object.freeze(FEATURE_DEFAULTS.pomodoro),
  onboarding: Object.freeze(FEATURE_DEFAULTS.onboarding),
});

// ---------------------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function oneOf<T extends string | number>(list: readonly T[], v: unknown): v is T {
  return (list as readonly unknown[]).includes(v);
}

export function isAmbientSound(v: unknown): v is AmbientSound {
  return v === 'none' || oneOf(SOUND_IDS, v);
}

export function isSoundId(v: unknown): v is SoundId {
  return oneOf(SOUND_IDS, v);
}

export function isShortcutAction(v: unknown): v is ShortcutAction {
  return oneOf(SHORTCUT_ACTIONS, v);
}

export function isOnboardingStep(v: unknown): v is OnboardingStep {
  return oneOf(ONBOARDING_STEPS, v);
}

/** Screen coordinates stay within ±100 000 DIP (multi-display setups can be negative). */
function isPosition(v: unknown): v is { x: number; y: number } {
  return (
    isRecord(v) &&
    Object.keys(v).length === 2 &&
    intIn(v['x'], -100_000, 100_000) &&
    intIn(v['y'], -100_000, 100_000)
  );
}

type FieldCheck = (key: string, value: unknown) => boolean;

/** Validators of each nested field (key → value check); unknown keys fail. */
const NESTED: { [K in Exclude<FeaturePrefKey, 'osd'>]: FieldCheck } = {
  sounds: (k, v) =>
    k === 'ambient'
      ? isAmbientSound(v)
      : k === 'volume'
        ? intIn(v, 0, 100)
        : k === 'autoplay' && typeof v === 'boolean',
  reminders: (k, v) =>
    k === 'schedules' || k === 'eyeBreaks'
      ? typeof v === 'boolean'
      : k === 'leadMinutes' && oneOf(REMINDER_LEAD_MINUTES, v),
  shortcuts: (k, v) => isShortcutAction(k) && (v === null || isAccelerator(v)),
  miniTimer: (k, v) =>
    k === 'visible' ? typeof v === 'boolean' : k === 'position' && (v === null || isPosition(v)),
  pomodoro: (k, v) => {
    if (k !== 'workMinutes' && k !== 'breakMinutes' && k !== 'cycles') return false;
    const range = POMODORO_LIMITS[k];
    return intIn(v, range.min, range.max);
  },
  onboarding: (k, v) =>
    k === 'done' ? typeof v === 'boolean' : k === 'step' && isOnboardingStep(v),
};

/** Keeps each valid nested field of `raw` over `fallback` (a damaged file loses one field). */
function sanitizeNested<T extends object>(
  key: Exclude<FeaturePrefKey, 'osd'>,
  raw: unknown,
  fallback: T,
): T {
  const out = { ...fallback } as Record<string, unknown>;
  if (isRecord(raw)) {
    for (const field of Object.keys(fallback)) {
      if (Object.hasOwn(raw, field) && NESTED[key](field, raw[field])) out[field] = raw[field];
    }
  }
  return out as T;
}

/** The Phase 5 fields read from a stored `prefs.json` object (each falls back on its own). */
export function sanitizeFeaturePrefs(stored: unknown): FeaturePrefs {
  const r = isRecord(stored) ? stored : {};
  const d = DEFAULT_FEATURE_PREFS;
  const miniTimer = sanitizeNested('miniTimer', r['miniTimer'], d.miniTimer);
  return {
    osd: typeof r['osd'] === 'boolean' ? r['osd'] : d.osd,
    sounds: sanitizeNested('sounds', r['sounds'], d.sounds),
    reminders: sanitizeNested('reminders', r['reminders'], d.reminders),
    shortcuts: sanitizeNested('shortcuts', r['shortcuts'], d.shortcuts),
    miniTimer: {
      visible: miniTimer.visible,
      position: miniTimer.position ? { ...miniTimer.position } : null,
    },
    pomodoro: sanitizeNested('pomodoro', r['pomodoro'], d.pomodoro),
    onboarding: sanitizeNested('onboarding', r['onboarding'], d.onboarding),
  };
}

export function isFeaturePrefKey(key: string): key is FeaturePrefKey {
  return oneOf(FEATURE_PREF_KEYS, key);
}

/** One `prefs:set` entry for a Phase 5 key: `osd` a boolean, the rest a non-empty partial. */
export function isFeaturePrefsPatchEntry(key: FeaturePrefKey, value: unknown): boolean {
  if (key === 'osd') return typeof value === 'boolean';
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([k, v]) => NESTED[key](k, v));
}

/** `prefs` with the Phase 5 part of `patch` merged in (validated before). */
export function applyFeaturePrefsPatch<P extends FeaturePrefs>(
  prefs: P,
  patch: FeaturePrefsPatch,
): P {
  const next = { ...prefs };
  if (patch.osd !== undefined) next.osd = patch.osd;
  if (patch.sounds) next.sounds = { ...prefs.sounds, ...patch.sounds };
  if (patch.reminders) next.reminders = { ...prefs.reminders, ...patch.reminders };
  if (patch.shortcuts) next.shortcuts = { ...prefs.shortcuts, ...patch.shortcuts };
  if (patch.miniTimer) next.miniTimer = { ...prefs.miniTimer, ...patch.miniTimer };
  if (patch.pomodoro) next.pomodoro = { ...prefs.pomodoro, ...patch.pomodoro };
  if (patch.onboarding) next.onboarding = { ...prefs.onboarding, ...patch.onboarding };
  return next;
}
