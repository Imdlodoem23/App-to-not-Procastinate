/**
 * `PUT /v1/settings` semantics for the in-memory guardian (ARCHITECTURE §5.8), so the dev mock
 * and the harness answer Ajustes and the exam whitelist like the real guardian:
 *
 * - strengthening changes apply at once (a higher goal, penalties on, a whitelist entry removed,
 *   every punishment change);
 * - weakening ones wait 24 h as a `PendingSettingChange` keyed by path (a lower goal, an option
 *   turned off, whitelist entries added: the pending value is the full new list, a time zone);
 * - a new weakening value replaces the pending one; the delay restarts only when it is weaker
 *   than the pending one, and setting the effective value again cancels it.
 *
 * Pure (the time comes in). The guardian's own Go code is the reference; this is a faithful
 * but simplified port (the delay is wall-clock time here).
 */
import type {
  GuardianSettings,
  IsoUtc,
  PendingSettingChange,
  PendingSettingPath,
} from '@centrate/shared/domain';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';

type PendingValue = PendingSettingChange['value'];

function iso(ms: number): IsoUtc {
  return new Date(ms).toISOString();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameValue(a: PendingValue, b: PendingValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return sameList(a, b);
  return a === b;
}

/** Whether `candidate` is weaker than `pending` for the same path (restarts the delay). */
function weakerThanPending(path: PendingSettingPath, candidate: PendingValue, pending: PendingValue): boolean {
  switch (path) {
    case 'dailyGoalMinutes':
      return (candidate as number) < (pending as number);
    case 'studyWhitelist.extraDomains':
    case 'studyWhitelist.extraProcesses':
      return (candidate as string[]).some((v) => !(pending as string[]).includes(v));
    default:
      return !sameValue(candidate, pending);
  }
}

export interface SettingsPutResult {
  settings: GuardianSettings;
  pending: PendingSettingChange[];
}

/**
 * Applies a full `GuardianSettings` body over the effective `current` settings and the
 * `pending` changes at `nowMs`.
 */
export function applySettingsPut(
  current: GuardianSettings,
  pending: readonly PendingSettingChange[],
  body: GuardianSettings,
  nowMs: number,
): SettingsPutResult {
  const next: GuardianSettings = structuredClone(current);
  const waiting = new Map<PendingSettingPath, PendingSettingChange>(
    pending.map((p) => [p.field, structuredClone(p)]),
  );
  const delayed = iso(nowMs + GUARDIAN_LIMITS.settingsWeakeningDelayMs);

  const wait = (path: PendingSettingPath, value: PendingValue): void => {
    const old = waiting.get(path);
    const keep = old !== undefined && !weakerThanPending(path, value, old.value);
    waiting.set(path, {
      field: path,
      value: structuredClone(value),
      effectiveAt: keep && old ? old.effectiveAt : delayed,
    } as PendingSettingChange);
  };
  const cancel = (path: PendingSettingPath): void => {
    waiting.delete(path);
  };

  // Punishment: at once (sessions snapshot it at start).
  next.punishment = { ...body.punishment };

  // Time zone: any change waits, except the first set while detection failed.
  if (body.timezone === current.timezone) cancel('timezone');
  else if (current.timezone === null) next.timezone = body.timezone;
  else wait('timezone', body.timezone);

  // Daily goal: raising applies, lowering waits.
  if (body.dailyGoalMinutes === current.dailyGoalMinutes) cancel('dailyGoalMinutes');
  else if (body.dailyGoalMinutes > current.dailyGoalMinutes) {
    next.dailyGoalMinutes = body.dailyGoalMinutes;
    cancel('dailyGoalMinutes');
  } else wait('dailyGoalMinutes', body.dailyGoalMinutes);

  // On/off options: turning on applies, turning off waits.
  for (const path of ['attemptPenalties', 'closeBrowsersWithoutExtension', 'serverTimeCheck'] as const) {
    if (body[path] === current[path]) cancel(path);
    else if (body[path]) {
      next[path] = true;
      cancel(path);
    } else wait(path, false);
  }

  // Whitelist extras: removals apply (also from a pending list), additions wait.
  for (const [key, path] of [
    ['extraDomains', 'studyWhitelist.extraDomains'],
    ['extraProcesses', 'studyWhitelist.extraProcesses'],
  ] as const) {
    const wanted = body.studyWhitelist[key];
    const effective = current.studyWhitelist[key].filter((v) => wanted.includes(v));
    next.studyWhitelist = { ...next.studyWhitelist, [key]: effective };
    const added = wanted.filter((v) => !effective.includes(v));
    if (added.length === 0) cancel(path);
    else wait(path, [...wanted]);
  }

  return { settings: next, pending: [...waiting.values()] };
}

/** Pending changes whose time came, applied (the guardian does it on its tick). */
export function applyDuePending(
  current: GuardianSettings,
  pending: readonly PendingSettingChange[],
  nowMs: number,
): SettingsPutResult | null {
  const due = pending.filter((p) => Date.parse(p.effectiveAt) <= nowMs);
  if (due.length === 0) return null;
  const next: GuardianSettings = structuredClone(current);
  for (const p of due) {
    switch (p.field) {
      case 'timezone':
        next.timezone = p.value;
        break;
      case 'dailyGoalMinutes':
        next.dailyGoalMinutes = p.value;
        break;
      case 'attemptPenalties':
      case 'closeBrowsersWithoutExtension':
      case 'serverTimeCheck':
        next[p.field] = p.value;
        break;
      case 'studyWhitelist.extraDomains':
        next.studyWhitelist = { ...next.studyWhitelist, extraDomains: [...p.value] };
        break;
      case 'studyWhitelist.extraProcesses':
        next.studyWhitelist = { ...next.studyWhitelist, extraProcesses: [...p.value] };
        break;
    }
  }
  return {
    settings: next,
    pending: pending.filter((p) => !due.includes(p)).map((p) => structuredClone(p)),
  };
}
