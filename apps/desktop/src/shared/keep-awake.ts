/**
 * «Mantener despierto» in the app (ARCHITECTURE §5.11), like NoSleep or PowerToys Awake. The
 * guardian owns the configuration and holds the OS idle-sleep inhibition, so the computer
 * stays awake with the window closed, the app quit or after a reboot; the app only offers the
 * controls (tray submenu, footer chip, Ajustes) and, while it runs, keeps the **display** on
 * when `display` is set (Electron `powerSaveBlocker`, `src/main/keep-awake/display.ts`).
 *
 * This module holds what those surfaces share: whether the guardian offers it (capability
 * `keep_awake`), the state they read, the choices they offer, their words and the IPC change
 * they send. Pure: no DOM, Node or Electron imports.
 */
import {
  DEFAULT_KEEP_AWAKE,
  GUARDIAN_LIMITS,
  KEEP_AWAKE_PRESET_MINUTES,
  type KeepAwakeRequest,
  type KeepAwakeState,
} from '@centrate/shared/guardian-api';
import { formatClock, formatMinutes } from './format';
import { SHARED } from './i18n';
import type { UiSnapshot } from './ui-state';

/** A duration the UI offers: minutes, or `null` for «Hasta que lo desactive». */
export type KeepAwakeChoice = number | null;

/** 30 min, 1 h, 2 h, 4 h and «Hasta que lo desactive», in the order every surface lists them. */
export const KEEP_AWAKE_CHOICES: readonly KeepAwakeChoice[] = Object.freeze([
  ...KEEP_AWAKE_PRESET_MINUTES,
  null,
]);

/**
 * `keep-awake:set`: the fields to change (at least one); main reads the guardian's current
 * configuration and sends the whole `PUT` body (`keepAwakeRequest`).
 */
export type KeepAwakeChange = Partial<KeepAwakeRequest>;

/** The change a tray or chip choice asks for: on with that duration, or off. */
export function keepAwakeChangeFor(choice: KeepAwakeChoice | 'off'): KeepAwakeChange {
  return choice === 'off' ? { on: false } : { on: true, durationMinutes: choice };
}

function isDurationMinutes(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= GUARDIAN_LIMITS.keepAwakeMinMinutes &&
      value <= GUARDIAN_LIMITS.keepAwakeMaxMinutes)
  );
}

const CHANGE_KEYS: readonly string[] = ['on', 'durationMinutes', 'display'];

/** IPC guard of `KeepAwakeChange`: only known keys, at least one, each of its type and range. */
export function isKeepAwakeChange(value: unknown): value is KeepAwakeChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every((k) => CHANGE_KEYS.includes(k))) return false;
  if ('on' in record && typeof record['on'] !== 'boolean') return false;
  if ('display' in record && typeof record['display'] !== 'boolean') return false;
  if ('durationMinutes' in record && !isDurationMinutes(record['durationMinutes'])) return false;
  return true;
}

/** The guardian offers it (`health.capabilities`); the controls show only then. */
export function keepAwakeSupported(snapshot: Pick<UiSnapshot, 'health'>): boolean {
  return snapshot.health?.capabilities.includes('keep_awake') ?? false;
}

/**
 * The controls work now: the guardian offers it and answers. While it is down its last state
 * is stale and nothing could change it, so the tray submenu and the chip hide.
 */
export function keepAwakeAvailable(snapshot: Pick<UiSnapshot, 'health' | 'link'>): boolean {
  return keepAwakeSupported(snapshot) && snapshot.link.status === 'ok';
}

/** The state as the guardian served it; off (`DEFAULT_KEEP_AWAKE`) when absent. */
export function keepAwakeOf(snapshot: Pick<UiSnapshot, 'state'>): KeepAwakeState {
  return snapshot.state?.keepAwake ?? { ...DEFAULT_KEEP_AWAKE, active: false, error: null };
}

/**
 * On right now: on, and its end not reached yet (the guardian turns it off within a step;
 * until the next poll shows it, nothing should still say «hasta las 18:30» at 18:31).
 */
export function keepAwakeIsOn(state: KeepAwakeState, nowMs: number): boolean {
  return state.on && (state.until === null || Date.parse(state.until) > nowMs);
}

/** The choice that matches the state (the one shown checked), `undefined` while off. */
export function keepAwakeChoiceOf(
  state: KeepAwakeState,
  nowMs: number,
): KeepAwakeChoice | undefined {
  return keepAwakeIsOn(state, nowMs) ? state.durationMinutes : undefined;
}

/** «30 min», «1 h», «Hasta que lo desactive». */
export function keepAwakeChoiceLabel(choice: KeepAwakeChoice): string {
  return choice === null ? SHARED.keepAwake.forever : formatMinutes(choice);
}

/** «hasta las 18:30», or `null` without an end. */
export function keepAwakeUntilLabel(state: Pick<KeepAwakeState, 'until'>): string | null {
  return state.until === null ? null : SHARED.keepAwake.until(formatClock(Date.parse(state.until)));
}

/** «Despierto · hasta las 18:30» / «Despierto» (the footer chip, sentence case). */
export function keepAwakeSummary(state: Pick<KeepAwakeState, 'until'>, separator = ' · '): string {
  const until = keepAwakeUntilLabel(state);
  return until ? `${SHARED.keepAwake.awake}${separator}${until}` : SHARED.keepAwake.awake;
}

/**
 * What is wrong, if anything: `failed` while on and not held (the guardian keeps retrying),
 * `unsupported` whenever this machine has no mechanism (also while off, so Ajustes can warn).
 */
export function keepAwakeTrouble(state: KeepAwakeState): 'failed' | 'unsupported' | null {
  if (state.error === 'unsupported') return 'unsupported';
  return state.on && state.error === 'failed' ? 'failed' : null;
}

/** The trouble in words («No se ha podido mantener despierto este equipo»), `null` when none. */
export function keepAwakeTroubleText(state: KeepAwakeState): string | null {
  const trouble = keepAwakeTrouble(state);
  return trouble === null ? null : SHARED.keepAwake[trouble];
}

/**
 * The guardian is in frozen mode (`health.mode` or `/v1/state.guardian.mode`): it holds no
 * inhibition and refuses every `PUT /v1/keep-awake` (503 `read_only`), so nothing the user
 * does could turn it off.
 */
function keepAwakeFrozen(snapshot: Pick<UiSnapshot, 'health' | 'state'>): boolean {
  return snapshot.health?.mode === 'frozen' || snapshot.state?.guardian.mode === 'frozen';
}

/**
 * The app should keep the display on: the guardian offers keep-awake, it is on (end not
 * reached) and «Mantener también la pantalla encendida» is set. The last state counts even
 * while the guardian does not answer: the user asked for it, and only its end or an answer
 * saying «off» releases it. Never while the guardian is frozen: it would refuse the change
 * that turns it off, so the screen would stay on for as long as the app runs.
 */
export function keepAwakeDisplayWanted(
  snapshot: Pick<UiSnapshot, 'health' | 'state'>,
  nowMs: number,
): boolean {
  if (!keepAwakeSupported(snapshot) || keepAwakeFrozen(snapshot)) return false;
  const state = keepAwakeOf(snapshot);
  return state.display && keepAwakeIsOn(state, nowMs);
}

/** When the display blocker must be looked at again (the end), `null` when nothing is due. */
export function keepAwakeNextChange(
  snapshot: Pick<UiSnapshot, 'health' | 'state'>,
  nowMs: number,
): number | null {
  if (!keepAwakeSupported(snapshot) || keepAwakeFrozen(snapshot)) return null;
  const state = keepAwakeOf(snapshot);
  if (!keepAwakeIsOn(state, nowMs) || state.until === null) return null;
  return Date.parse(state.until);
}
