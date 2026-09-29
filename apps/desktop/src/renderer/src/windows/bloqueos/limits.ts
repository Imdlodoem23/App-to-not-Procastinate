/**
 * «Límites diarios» of the Bloqueos window (ARCHITECTURE §5.10; «YouTube máximo 30 minutos al
 * día»): one row per limit, «YouTube · 30 min al día» with today's progress («12 de 30 min
 * hoy»), «Bloqueado hasta mañana» once it ran out, and the pending change of a softening edit
 * («Cambio pendiente: 1 h al día desde mañana 17:00») with «Cancelar cambio»; then «Nuevo
 * límite» or the editor in place (name, minutes a day, days, what to limit, what happens when
 * it runs out, «Tu motivo»). Pure: no DOM, Node or Electron imports.
 *
 * The guardian decides: stricter parts of an edit apply at once, softer ones wait 24 h, a
 * deletion always waits, and nothing ever ends today's limit block. The editor says so before
 * saving (`limitEditWeakens`), so nothing surprises the user after «Guardar».
 */
import { getService, type CategoryId } from '@centrate/shared/catalog';
import type {
  DailyLimit,
  DailyLimitDefinition,
  IsoWeekday,
  TargetSpec,
} from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  limitModeRank,
  splitLimitChange,
  type DailyLimitInput,
} from '@centrate/shared/guardian-api';
import type { Accent } from '@centrate/shared/design/tokens';
import { modeLabel } from '../../../../shared/format';
import {
  LIMIT_TEXT,
  limitAutoName,
  limitNeedsConsequence,
  limitProblem,
  limitReachedToday,
  limitUsageFraction,
  parseLimitMinutes,
  targetTotal,
  usedMinutesToday,
} from '../../../../shared/limits';
import type { LimitEditorState, UiError } from '../../../../shared/ui-state';
import { errorCopy } from '../../i18n/errors';
import { BLOQUEOS } from './i18n';
import type { ScheduleChip } from './schedule-editor';
import { whenLabel } from './time';

const L = BLOQUEOS.limits;

export type LimitsData =
  | { status: 'loading' }
  | { status: 'ready'; list: readonly DailyLimit[] }
  | { status: 'error'; error: UiError };

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

/**
 * The rows: the fetched list (exact, creation order) with each limit replaced by the
 * snapshot's when that one is as new (its usage moves every minute), plus limits the snapshot
 * has and the list does not yet (made from the main window's card).
 */
export function mergeLimits(
  fetched: readonly DailyLimit[],
  live: readonly DailyLimit[] | undefined,
): DailyLimit[] {
  if (!live) return [...fetched];
  const byId = new Map(live.map((l) => [l.id, l]));
  const out = fetched.map((f) => {
    const s = byId.get(f.id);
    return s && Date.parse(s.updatedAt) >= Date.parse(f.updatedAt) ? s : f;
  });
  const known = new Set(fetched.map((f) => f.id));
  for (const l of live) if (!known.has(l.id)) out.push(l);
  return out;
}

/** The first instant of the next local day: a softening change applies then at the earliest. */
export function nextMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** When a softening change made now would apply (the guardian's own time is authoritative). */
export function pendingEstimate(nowMs: number): number {
  return Math.max(nowMs + GUARDIAN_LIMITS.limitWeakeningDelayMs, nextMidnight(nowMs));
}

/** What a pending change softens, in a few words («1 h al día», «modo Normal», «menos cosas»). */
export function pendingWhat(before: DailyLimitDefinition, after: DailyLimitDefinition): string {
  const W = L.pendingWhat;
  const parts: string[] = [];
  if (before.enabled && !after.enabled) parts.push(W.disabled);
  if (after.dailyMinutes > before.dailyMinutes) {
    parts.push(W.minutes(LIMIT_TEXT.perDay(after.dailyMinutes)));
  }
  if (before.days.some((d) => !after.days.includes(d)))
    parts.push(W.days(LIMIT_TEXT.days(after.days)));
  if (limitModeRank(after.mode) < limitModeRank(before.mode))
    parts.push(W.mode(modeLabel(after.mode)));
  const lists = [
    'serviceIds',
    'categoryIds',
    'appIds',
    'customDomains',
    'customProcesses',
  ] as const;
  if (
    lists.some((k) =>
      (before.targets[k] as readonly string[]).some(
        (x) => !(after.targets[k] as readonly string[]).includes(x),
      ),
    )
  ) {
    parts.push(W.targets);
  }
  return parts.length > 0 ? parts.join(', ') : W.other;
}

export interface LimitRowView {
  id: DailyLimit['id'];
  /** «YouTube · 30 min al día». */
  title: string;
  name: string;
  /** A single service's catalog monogram (its icon), else `null` (a category or custom glyph). */
  monogram: string | null;
  categoryId: CategoryId | null;
  /** «12 de 30 min hoy» and the bar (red once used up, orange near the end). */
  usage: { value: number; text: string; tone: Accent; label: string };
  /** «Bloqueado hasta mañana», «Hoy no cuenta para bloquear», «Desactivado». */
  state: { text: string; tone: 'red' | 'muted' } | null;
  /** «Todos los días · Estricto», or what the row is doing now. */
  description: string;
  /** «Cambio pendiente: 1 h al día desde mañana 17:00», «Se borrará mañana 17:00…». */
  pending: string | null;
  editing: boolean;
  saving: boolean;
  editKey: string | undefined;
  /** «Cancelar cambio» (only while a change waits). */
  cancelKey: string | undefined;
}

export function limitRow(
  limit: DailyLimit,
  nowMs: number,
  options: {
    editing?: boolean;
    saving?: boolean;
    editKey?: string | undefined;
    cancelKey?: string | undefined;
  } = {},
): LimitRowView {
  const reached = limitReachedToday(limit);
  const fraction = limitUsageFraction(limit);
  const used = usedMinutesToday(limit);
  const service =
    limit.targets.serviceIds.length === 1 && targetTotal(limit.targets) === 1
      ? getService(limit.targets.serviceIds[0] ?? '')
      : undefined;
  const category =
    !service && limit.targets.categoryIds.length > 0
      ? (limit.targets.categoryIds[0] ?? null)
      : null;
  const pending = limit.pendingChange;
  const pendingText = pending
    ? pending.definition === null
      ? L.pendingDelete(whenLabel(Date.parse(pending.effectiveAt), nowMs))
      : L.pending(
          pendingWhat(limit, pending.definition),
          whenLabel(Date.parse(pending.effectiveAt), nowMs),
        )
    : null;
  const state: LimitRowView['state'] = !limit.enabled
    ? { text: L.disabled, tone: 'muted' }
    : reached
      ? { text: LIMIT_TEXT.blockedUntilTomorrow, tone: 'red' }
      : !limit.appliesToday
        ? { text: L.notToday, tone: 'muted' }
        : null;
  return {
    id: limit.id,
    title: L.row(limit.name, LIMIT_TEXT.perDay(limit.dailyMinutes)),
    name: limit.name,
    monogram: service ? service.monogram : null,
    categoryId: category,
    usage: {
      value: reached ? 1 : fraction,
      text: LIMIT_TEXT.usedToday(used, limit.dailyMinutes),
      tone: reached ? 'red' : fraction >= 0.8 ? 'orange' : 'blue',
      label: L.usageLabel(limit.name),
    },
    state,
    description: options.saving
      ? L.saving
      : options.editing
        ? L.editing
        : L.desc(LIMIT_TEXT.days(limit.days), modeLabel(limit.mode)),
    pending: pendingText,
    editing: options.editing === true,
    saving: options.saving === true,
    editKey: options.editKey,
    cancelKey: pending ? options.cancelKey : undefined,
  };
}

// ---------------------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------------------

function cloneTargets(t: TargetSpec): TargetSpec {
  return {
    serviceIds: [...t.serviceIds],
    categoryIds: [...t.categoryIds],
    appIds: [...t.appIds],
    customDomains: [...t.customDomains],
    customProcesses: [...t.customProcesses],
  };
}

export function withLimitDay(
  input: DailyLimitInput,
  day: IsoWeekday,
  on: boolean,
): DailyLimitInput {
  const has = input.days.includes(day);
  if (has === on) return input;
  const days = on ? [...input.days, day] : input.days.filter((d) => d !== day);
  return { ...input, days: [...new Set(days)].sort((a, b) => a - b) };
}

/** Remove one extra target (a chip): a service, an app, a domain or a process. */
export function withoutLimitTarget(input: DailyLimitInput, chip: ScheduleChip): DailyLimitInput {
  const t = input.targets;
  const drop = (list: readonly string[]): string[] => list.filter((x) => x !== chip.key);
  switch (chip.kind) {
    case 'service':
      return { ...input, targets: { ...t, serviceIds: drop(t.serviceIds) } };
    case 'app':
      return { ...input, targets: { ...t, appIds: drop(t.appIds) } };
    case 'domain':
      return { ...input, targets: { ...t, customDomains: drop(t.customDomains) } };
    case 'process':
      return { ...input, targets: { ...t, customProcesses: drop(t.customProcesses) } };
  }
}

/** The minutes the editor would send (`null` while «Minutos al día» is not a duration). */
export function editorMinutes(editor: LimitEditorState, nowMs: number): number | null {
  return parseLimitMinutes(editor.minutesText, nowMs);
}

export type LimitEditorProblem =
  'full' | 'minutes_text' | 'minutes' | 'no_targets' | 'no_days' | 'name_long';

export function limitEditorProblem(
  editor: LimitEditorState,
  nowMs: number,
  count: number,
): LimitEditorProblem | null {
  if (editor.id === null && count >= GUARDIAN_LIMITS.maxLimits) return 'full';
  const minutes = editorMinutes(editor, nowMs);
  if (minutes === null) return 'minutes_text';
  const problem = limitProblem({ ...editor.input, dailyMinutes: minutes });
  switch (problem) {
    case null:
      return null;
    case 'minutes':
      return 'minutes';
    case 'no_targets':
      return 'no_targets';
    case 'no_days':
      return 'no_days';
    case 'name_long':
      return 'name_long';
  }
}

export function limitEditorProblemText(problem: LimitEditorProblem): string {
  const P = L.editor.problem;
  switch (problem) {
    case 'full':
      return P.full(GUARDIAN_LIMITS.maxLimits);
    case 'minutes_text':
      return P.minutesText;
    case 'minutes':
      return P.minutes;
    case 'no_targets':
      return P.noTargets;
    case 'no_days':
      return P.noDays;
    case 'name_long':
      return P.nameLong(GUARDIAN_LIMITS.limitNameMaxLength);
  }
}

/**
 * The body of `limits:create` / `limits:update`: the typed minutes, the name filled in when
 * empty, days sorted, the reason trimmed and the acknowledgement of the «¿Seguro?».
 */
export function toLimitRequest(
  editor: LimitEditorState,
  nowMs: number,
  acknowledged: boolean,
): DailyLimitInput {
  const input = editor.input;
  const name = input.name.trim();
  return {
    name: name === '' ? limitAutoName(input.targets) : name,
    enabled: input.enabled,
    targets: cloneTargets(input.targets),
    dailyMinutes: editorMinutes(editor, nowMs) ?? input.dailyMinutes,
    days: [...new Set(input.days)].sort((a, b) => a - b),
    mode: input.mode,
    reason: input.reason.trim().slice(0, GUARDIAN_LIMITS.reasonMaxLength),
    acknowledgeNoEmergency: acknowledged && limitNeedsConsequence(input.mode),
  };
}

/** Saving `after` over `before` leaves something waiting 24 h (the guardian's split). */
export function limitEditWeakens(before: DailyLimit, after: DailyLimitInput): boolean {
  return splitLimitChange(before, after).pending !== null;
}

/** «YouTube · 30 min al día» (the editor's title and the saved line). */
export function limitSummary(input: DailyLimitInput, minutes: number | null): string {
  const name = input.name.trim() || limitAutoName(input.targets);
  return minutes === null ? name : L.row(name, LIMIT_TEXT.perDay(minutes));
}

/** The guardian's refusal of a limit write, in words. */
export function limitErrorText(error: UiError): string {
  const E = L.editor.errors;
  if (error.kind === 'rejected') {
    switch (error.code) {
      case 'too_many_targets':
        return E.tooMany;
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
