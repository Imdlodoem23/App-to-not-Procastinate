/**
 * The schedule editor of the Bloqueos window (PROMPT §9 «Horarios», §10 «Ventanas de detalle ›
 * Bloqueos»; ARCHITECTURE §5.3, §8.8 «Schedules»): «Nuevo horario» and a row's «Editar»
 * open it in place, under the list, with the form's local state in `detail.bloqueos.schedule`
 * (fixture-settable). Pure: no DOM, Node or Electron imports.
 *
 * The guardian is the judge of every write, with two guards evaluated in trusted time:
 * - an occurrence in progress (409 `schedule_in_progress`): no edit and no delete until it ends
 *   («sin tocar uno que ya esté en curso»);
 * - the next occurrence starts within 10 min (409 `schedule_starting_soon`): a delete or a
 *   weakening edit is refused; strengthening edits (enable, add targets or days, stricter mode,
 *   longer window) always go through.
 *
 * The editor says the same before sending, so the user reads why at once (`scheduleProblem`),
 * and shows the guardian's answer when it still refuses (`scheduleErrorText`).
 */
import { CATEGORIES, SERVICES, type CategoryId } from '@centrate/shared/catalog';
import type { BlockMode, IsoWeekday, Schedule, TargetSpec } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  emptyAllow,
  emptyTargets,
  scheduleWindowMinutes,
  type ScheduleInput,
} from '@centrate/shared/guardian-api';
import { durationLabel } from '@centrate/shared/parser';
import { categoryName, formatClock, targetsLabel } from '../../../../shared/format';
import type { DefaultBlockMode, ScheduleEditorState, UiError } from '../../../../shared/ui-state';
import { errorCopy } from '../../i18n/errors';
import { customEntries, selectedCount, withCategory, type EntryView } from './catalog';
import { BLOQUEOS } from './i18n';
import { daysLabel, isWhitelistSchedule, parseClockText } from './schedules';
import { untilPhrase } from './time';

const S = BLOQUEOS.schedules;
const MIN = 60_000;
const WEEK_MINUTES = 7 * 1440;

export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

/** «L–V 16:00–19:00» when a new schedule opens (the brief's example). */
export const NEW_SCHEDULE_DEFAULTS = Object.freeze({
  days: [1, 2, 3, 4, 5] as readonly IsoWeekday[],
  start: '16:00',
  end: '19:00',
});

function clockMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

// ---------------------------------------------------------------------------------------
// Opening the editor
// ---------------------------------------------------------------------------------------

/** The zone of the OS («Europe/Madrid»); the guardian refuses `Local`. */
export function systemTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' && zone !== 'Local' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A new schedule: L–V 16:00–19:00, the default mode and, when the form above already names
 * what to block, the same targets (the user can change them before saving).
 */
export function newScheduleInput(options: {
  timezone: string;
  mode: DefaultBlockMode;
  targets?: TargetSpec | null;
}): ScheduleInput {
  const targets = options.targets;
  return {
    name: '',
    enabled: true,
    days: [...NEW_SCHEDULE_DEFAULTS.days],
    start: NEW_SCHEDULE_DEFAULTS.start,
    end: NEW_SCHEDULE_DEFAULTS.end,
    timezone: options.timezone,
    targets: targets ? cloneTargets(targets) : emptyTargets(),
    whitelistOnly: false,
    allow: emptyAllow(),
    mode: options.mode,
    reason: '',
    acknowledgeNoEmergency: false,
  };
}

function cloneTargets(t: TargetSpec): TargetSpec {
  return {
    serviceIds: [...t.serviceIds],
    categoryIds: [...t.categoryIds],
    appIds: [...t.appIds],
    customDomains: [...t.customDomains],
    customProcesses: [...t.customProcesses],
  };
}

/** A saved schedule as the editor's input (every field copied: the guardian replaces it whole). */
export function scheduleToInput(schedule: Schedule): ScheduleInput {
  return {
    name: schedule.name,
    enabled: schedule.enabled,
    days: [...schedule.days],
    start: schedule.start,
    end: schedule.end,
    timezone: schedule.timezone,
    targets: cloneTargets(schedule.targets),
    whitelistOnly: schedule.whitelistOnly,
    allow: {
      customDomains: [...schedule.allow.customDomains],
      customProcesses: [...schedule.allow.customProcesses],
    },
    mode: schedule.mode,
    reason: schedule.reason,
    acknowledgeNoEmergency: false,
  };
}

export function editorFor(schedule: Schedule): ScheduleEditorState {
  return { id: schedule.id, input: scheduleToInput(schedule), error: null };
}

// ---------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------

export function withDay(input: ScheduleInput, day: IsoWeekday, on: boolean): ScheduleInput {
  const has = input.days.includes(day);
  if (has === on) return input;
  const days = on ? [...input.days, day] : input.days.filter((d) => d !== day);
  return { ...input, days: [...new Set(days)].sort((a, b) => a - b) };
}

/** Switch mode; Examen implies the whitelist (the targets stay aside until it is left). */
export function withScheduleMode(input: ScheduleInput, mode: BlockMode): ScheduleInput {
  return { ...input, mode, whitelistOnly: mode === 'exam' };
}

export function withScheduleCategory(
  input: ScheduleInput,
  id: CategoryId,
  on: boolean,
): ScheduleInput {
  const targets = withCategory(input.targets, id, on);
  return targets === input.targets ? input : { ...input, targets };
}

/** «Añadir lo del formulario de arriba»: the form's targets join the schedule's. */
export function mergeTargets(into: TargetSpec, from: TargetSpec): TargetSpec {
  let out = cloneTargets(into);
  for (const id of from.categoryIds) out = withCategory(out, id, true);
  const covered = (serviceId: string): boolean =>
    SERVICES.find((s) => s.id === serviceId)?.categories.some((c) => out.categoryIds.includes(c)) ??
    false;
  const union = (a: readonly string[], b: readonly string[]): string[] => [
    ...new Set([...a, ...b]),
  ];
  return {
    ...out,
    serviceIds: union(out.serviceIds, from.serviceIds).filter((s) => !covered(s)),
    appIds: union(out.appIds, from.appIds),
    customDomains: union(out.customDomains, from.customDomains),
    customProcesses: union(out.customProcesses, from.customProcesses),
  };
}

/** Whether «Añadir lo del formulario» would add anything. */
export function formAddsTargets(schedule: TargetSpec, form: TargetSpec): boolean {
  return selectedCount(mergeTargets(schedule, form)) > selectedCount(schedule);
}

/** Remove one extra target (a chip): a service, an app, a domain or a process. */
export function withoutScheduleTarget(input: ScheduleInput, chip: ScheduleChip): ScheduleInput {
  const t = input.targets;
  switch (chip.kind) {
    case 'service':
      return {
        ...input,
        targets: { ...t, serviceIds: t.serviceIds.filter((s) => s !== chip.key) },
      };
    case 'app':
      return { ...input, targets: { ...t, appIds: t.appIds.filter((a) => a !== chip.key) } };
    case 'domain':
      return {
        ...input,
        targets: { ...t, customDomains: t.customDomains.filter((d) => d !== chip.key) },
      };
    case 'process':
      return {
        ...input,
        targets: { ...t, customProcesses: t.customProcesses.filter((p) => p !== chip.key) },
      };
  }
}

export interface ScheduleChip {
  kind: 'service' | 'app' | 'domain' | 'process';
  key: string;
  label: string;
}

/** What the schedule blocks beyond its categories (removable chips). */
export function scheduleChips(targets: TargetSpec): ScheduleChip[] {
  const entries = customEntries(targets);
  const services = targets.serviceIds.map((id): ScheduleChip => ({
    kind: 'service',
    key: id,
    label: SERVICES.find((s) => s.id === id)?.name ?? id,
  }));
  const rest = [...entries.apps, ...entries.domains].map((e: EntryView): ScheduleChip => ({
    kind: e.kind,
    key: e.key,
    label: e.label,
  }));
  return [...services, ...rest];
}

/** The six categories with a checkbox each. */
export function scheduleCategories(
  targets: TargetSpec,
): { id: CategoryId; name: string; checked: boolean }[] {
  return CATEGORIES.map((c) => ({
    id: c.id,
    name: categoryName(c.id),
    checked: targets.categoryIds.includes(c.id),
  }));
}

// ---------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------

/** The name saved when the user left «Nombre» empty: «Redes sociales · L–V». */
export function scheduleAutoName(input: ScheduleInput): string {
  const what = targetsLabel(input.targets, isWhitelistSchedule(input), 1);
  const days = input.days.length === 0 ? S.noDays : daysLabel(input.days);
  const name = `${what} · ${days}`;
  const max = GUARDIAN_LIMITS.scheduleNameMaxLength;
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/** «Dura 3 h», «Dura 8 h: acaba al día siguiente»; `null` while a time is not valid. */
export function scheduleWindowLabel(input: Pick<ScheduleInput, 'start' | 'end'>): string | null {
  const start = parseClockText(input.start);
  const end = parseClockText(input.end);
  if (start === null || end === null || start === end) return null;
  const minutes = scheduleWindowMinutes(start, end);
  const overnight = clockMinutes(end) <= clockMinutes(start);
  return overnight
    ? S.editor.windowOvernight(durationLabel(minutes))
    : S.editor.window(durationLabel(minutes));
}

// ---------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------

/** 409 `schedule_in_progress`: an occurrence of it is running now. */
export function scheduleRunning(schedule: Schedule): boolean {
  return schedule.activeBlockId !== null;
}

/**
 * The start of the next occurrence when it is less than `scheduleFreezeMinutes` away (then a
 * delete or a weakening edit is refused), else `null`. A disabled schedule has none.
 */
export function scheduleFrozenStart(schedule: Schedule, nowMs: number): number | null {
  if (!schedule.enabled || !schedule.nextOccurrence) return null;
  const start = Date.parse(schedule.nextOccurrence.startsAt);
  if (!Number.isFinite(start) || start <= nowMs) return null;
  return start - nowMs <= GUARDIAN_LIMITS.scheduleFreezeMinutes * MIN ? start : null;
}

const MODE_RANK: Readonly<Record<BlockMode, number>> = {
  normal: 0,
  strict: 1,
  hardcore: 2,
  exam: 3,
};

/** Minutes of the week (Monday 00:00 = 0) a schedule covers; overnight windows wrap. */
function weekMask(days: readonly IsoWeekday[], start: string, end: string): Uint8Array {
  const mask = new Uint8Array(WEEK_MINUTES);
  const from = clockMinutes(start);
  const length = scheduleWindowMinutes(start, end);
  for (const day of days) {
    const base = (day - 1) * 1440 + from;
    for (let i = 0; i < length; i += 1) mask[(base + i) % WEEK_MINUTES] = 1;
  }
  return mask;
}

function coversWindow(before: ScheduleInput | Schedule, after: ScheduleInput): boolean {
  const start = parseClockText(after.start);
  const end = parseClockText(after.end);
  if (start === null || end === null || start === end) return false;
  const was = weekMask(before.days, before.start, before.end);
  const now = weekMask(after.days, start, end);
  for (let i = 0; i < WEEK_MINUTES; i += 1) if (was[i] === 1 && now[i] !== 1) return false;
  return true;
}

function dropsTargets(before: TargetSpec, after: TargetSpec): boolean {
  const covered = (serviceId: string): boolean =>
    SERVICES.find((s) => s.id === serviceId)?.categories.some((c) =>
      after.categoryIds.includes(c),
    ) ?? false;
  const missing = (was: readonly string[], now: readonly string[]): boolean =>
    was.some((x) => !now.includes(x));
  return (
    missing(before.categoryIds, after.categoryIds) ||
    before.serviceIds.some((s) => !after.serviceIds.includes(s) && !covered(s)) ||
    missing(before.appIds, after.appIds) ||
    missing(before.customDomains, after.customDomains) ||
    missing(before.customProcesses, after.customProcesses)
  );
}

/**
 * Whether saving `after` over `before` weakens the schedule (the guardian's rule, conservative):
 * turning it off, losing a day or part of the window, blocking less, a milder mode, allowing
 * more in a whitelist, or another time zone. Names and reasons change nothing.
 */
export function scheduleEditWeakens(before: Schedule, after: ScheduleInput): boolean {
  if (before.enabled && !after.enabled) return true;
  if (before.timezone !== after.timezone) return true;
  if (MODE_RANK[after.mode] < MODE_RANK[before.mode]) return true;
  if (!coversWindow(before, after)) return true;
  const wasWhitelist = isWhitelistSchedule(before);
  const isWhitelist = isWhitelistSchedule(after);
  if (wasWhitelist) {
    if (!isWhitelist) return true;
    const more = (was: readonly string[], now: readonly string[]): boolean =>
      now.some((x) => !was.includes(x));
    return (
      more(before.allow.customDomains, after.allow.customDomains) ||
      more(before.allow.customProcesses, after.allow.customProcesses)
    );
  }
  // A whitelist blocks everything else: never weaker than a list of targets.
  return !isWhitelist && dropsTargets(before.targets, after.targets);
}

export type ScheduleProblem =
  | 'no_days'
  | 'bad_start'
  | 'bad_end'
  | 'same_time'
  | 'too_short'
  | 'no_targets'
  | 'name_long'
  | 'running'
  | 'starting_soon'
  | 'full';

/**
 * Why «Guardar» cannot send the editor now (`null`: it can): the input's own problems first,
 * then the guardian's guards for the schedule being edited. `count` is how many schedules exist.
 */
export function scheduleProblem(
  input: ScheduleInput,
  before: Schedule | null,
  nowMs: number,
  count: number,
): ScheduleProblem | null {
  if (before === null && count >= GUARDIAN_LIMITS.maxSchedules) return 'full';
  if (before !== null && scheduleRunning(before)) return 'running';
  if (input.days.length === 0) return 'no_days';
  const start = parseClockText(input.start);
  if (start === null) return 'bad_start';
  const end = parseClockText(input.end);
  if (end === null) return 'bad_end';
  if (start === end) return 'same_time';
  if (scheduleWindowMinutes(start, end) < GUARDIAN_LIMITS.blockMinMinutes) return 'too_short';
  if (!isWhitelistSchedule(input) && selectedCount(input.targets) === 0) return 'no_targets';
  if (input.name.trim().length > GUARDIAN_LIMITS.scheduleNameMaxLength) return 'name_long';
  if (
    before !== null &&
    scheduleFrozenStart(before, nowMs) !== null &&
    scheduleEditWeakens(before, input)
  ) {
    return 'starting_soon';
  }
  return null;
}

/** The copy of a `ScheduleProblem` (the start time of a frozen schedule for `starting_soon`). */
export function scheduleProblemText(
  problem: ScheduleProblem,
  before: Schedule | null,
  nowMs: number,
): string {
  const P = S.editor.problem;
  switch (problem) {
    case 'starting_soon': {
      const start = before ? scheduleFrozenStart(before, nowMs) : null;
      return P.startingSoon(start === null ? '' : formatClock(start));
    }
    case 'no_days':
      return P.noDays;
    case 'bad_start':
      return P.badStart;
    case 'bad_end':
      return P.badEnd;
    case 'same_time':
      return P.sameTime;
    case 'too_short':
      return P.tooShort;
    case 'no_targets':
      return P.noTargets;
    case 'name_long':
      return P.nameLong(GUARDIAN_LIMITS.scheduleNameMaxLength);
    case 'running':
      return P.running;
    case 'full':
      return P.full(GUARDIAN_LIMITS.maxSchedules);
  }
}

/** Why «Borrar» cannot delete it now, or `null` (a delete is always refused in the 10 min). */
export function scheduleDeleteLock(schedule: Schedule, nowMs: number): string | null {
  if (scheduleRunning(schedule)) return S.editor.problem.running;
  const start = scheduleFrozenStart(schedule, nowMs);
  return start === null ? null : S.editor.problem.startingSoonDelete(formatClock(start));
}

/** Hardcore and Examen: saving asks «¿Seguro?» with the consequence (`acknowledgeNoEmergency`). */
export function scheduleNeedsConsequence(input: Pick<ScheduleInput, 'mode'>): boolean {
  return input.mode === 'hardcore' || input.mode === 'exam';
}

/**
 * The body of `schedules:create` / `schedules:update`: times as `HH:MM`, days sorted, Examen as
 * a whitelist without targets (anything else as targets without an allow list), the name filled
 * in when empty, and the acknowledgement the in-place «¿Seguro?» gave.
 */
export function toScheduleRequest(input: ScheduleInput, acknowledged: boolean): ScheduleInput {
  const whitelist = isWhitelistSchedule(input);
  const name = input.name.trim();
  const cleaned: ScheduleInput = {
    name: name === '' ? scheduleAutoName(input) : name,
    enabled: input.enabled,
    days: [...new Set(input.days)].sort((a, b) => a - b),
    start: parseClockText(input.start) ?? input.start,
    end: parseClockText(input.end) ?? input.end,
    timezone: input.timezone,
    targets: whitelist ? emptyTargets() : cloneTargets(input.targets),
    whitelistOnly: whitelist,
    allow: whitelist
      ? {
          customDomains: [...input.allow.customDomains],
          customProcesses: [...input.allow.customProcesses],
        }
      : emptyAllow(),
    mode: whitelist ? 'exam' : input.mode,
    reason: input.reason.trim(),
    acknowledgeNoEmergency: acknowledged && scheduleNeedsConsequence(input),
  };
  return cleaned;
}

// ---------------------------------------------------------------------------------------
// Guardian answers
// ---------------------------------------------------------------------------------------

function detailString(error: UiError, key: string): string | null {
  const value = error.details?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The guardian's refusal of a schedule write, in words: the guards say when (from `details`),
 * the rest go through the shared error copy.
 */
export function scheduleErrorText(
  error: UiError,
  nowMs: number,
  op: 'save' | 'delete' = 'save',
): string {
  const E = S.editor.errors;
  if (error.kind === 'rejected') {
    switch (error.code) {
      case 'schedule_in_progress': {
        const endsAt = detailString(error, 'endsAt');
        const ends = endsAt === null ? Number.NaN : Date.parse(endsAt);
        return Number.isFinite(ends) ? E.inProgress(untilPhrase(ends, nowMs)) : S.running;
      }
      case 'schedule_starting_soon': {
        const startsAt = detailString(error, 'startsAt');
        const start = startsAt === null ? Number.NaN : Date.parse(startsAt);
        const time = Number.isFinite(start) ? formatClock(start) : '';
        return op === 'delete'
          ? S.editor.problem.startingSoonDelete(time)
          : S.editor.problem.startingSoon(time);
      }
      case 'too_many_targets':
        return E.tooMany;
      case 'invalid_timezone':
        return E.timezone;
      case 'not_found':
        return E.notFound;
      case 'validation_failed':
        return E.invalid;
      default:
        break;
    }
  }
  return errorCopy(error).text;
}

// ---------------------------------------------------------------------------------------
// The list after a write
// ---------------------------------------------------------------------------------------

/** `list` with `schedule` replaced (same id) or added at the end. */
export function upsertSchedule(list: readonly Schedule[], schedule: Schedule): Schedule[] {
  const index = list.findIndex((s) => s.id === schedule.id);
  if (index < 0) return [...list, schedule];
  return list.map((s, i) => (i === index ? schedule : s));
}

export function withoutSchedule(list: readonly Schedule[], id: string): Schedule[] {
  return list.filter((s) => s.id !== id);
}
