/**
 * Daily limits in the app («YouTube máximo 30 minutos al día»; ARCHITECTURE §5.10, §10.13).
 * The guardian owns them (usage, the block when the allowance runs out, the 24 h wait of a
 * weakening change); this module holds what the app's surfaces share about them: the draft of
 * the main window's «Límite diario» card, its request, the words of a limit's progress and the
 * lookups from a limit block to its limit. Pure: no DOM, Node or Electron imports.
 */
import { SHARED_EN as PKG_EN, SHARED_ES as PKG_ES } from '@centrate/shared/i18n';
import type { SharedMessages as PkgMessages } from '@centrate/shared/i18n';
import {
  LIMIT_MODES,
  type Block,
  type DailyLimit,
  type IsoWeekday,
  type LimitMode,
  type TargetSpec,
} from '@centrate/shared/domain';
import {
  ALL_WEEKDAYS,
  GUARDIAN_LIMITS,
  emptyTargets,
  limitInputFromLimit,
  type DailyLimitInput,
  type GuardianStateResponse,
} from '@centrate/shared/guardian-api';
import { durationLabel, parseIntent, type ParseResult } from '@centrate/shared/parser';
import { targetsLabel } from './format';
import { localized } from './i18n';
import type { DraftSeed, LimitDraft, LimitEditorState } from './ui-state';

/**
 * The shared package's words for limits in the active locale: «Límite diario», «12 de 30 min
 * hoy», «Te quedan 5 min de YouTube hoy», «Límite diario de YouTube: bloqueado hasta las 0:00».
 */
export const LIMIT_TEXT: PkgMessages['dailyLimits'] = localized<PkgMessages['dailyLimits']>({
  es: PKG_ES.dailyLimits,
  en: PKG_EN.dailyLimits,
});

/** The mode a new limit starts with (the brief: «strict» by default, whatever the prefs say). */
export const DEFAULT_LIMIT_MODE: LimitMode = 'strict';
/** «Minutos al día» of a new limit opened without a phrase. */
export const DEFAULT_LIMIT_MINUTES = 30;
/** Quick picks of the editor: 15 min | 30 min | 1 h | 2 h. */
export const LIMIT_MINUTE_PRESETS = [15, 30, 60, 120] as const;

function cloneTargets(t: TargetSpec): TargetSpec {
  return {
    serviceIds: [...t.serviceIds],
    categoryIds: [...t.categoryIds],
    appIds: [...t.appIds],
    customDomains: [...t.customDomains],
    customProcesses: [...t.customProcesses],
  };
}

function sortedDays(days: readonly IsoWeekday[]): IsoWeekday[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

export function targetTotal(t: TargetSpec): number {
  return (
    t.serviceIds.length +
    t.categoryIds.length +
    t.appIds.length +
    t.customDomains.length +
    t.customProcesses.length
  );
}

/** The name a limit gets from what it limits: «YouTube», «Redes sociales», «YouTube, TikTok +1». */
export function limitAutoName(targets: TargetSpec): string {
  const name = targetsLabel(targets, false, 2);
  const max = GUARDIAN_LIMITS.limitNameMaxLength;
  return name.length <= max ? name : `${name.slice(0, max - 1).trimEnd()}…`;
}

/** The card's draft for a phrase the parser fully read as a daily limit; `null` otherwise. */
export function limitDraftFromParse(parse: ParseResult): LimitDraft | null {
  if (parse.kind !== 'limit' || !parse.complete || parse.dailyMinutes === undefined) return null;
  const targets: TargetSpec = {
    ...emptyTargets(),
    serviceIds: [...parse.serviceIds],
    categoryIds: [...parse.categoryIds],
    customDomains: [...parse.domains],
  };
  if (targetTotal(targets) === 0) return null;
  return {
    name: limitAutoName(targets),
    targets,
    dailyMinutes: parse.dailyMinutes,
    days: parse.days && parse.days.length > 0 ? sortedDays(parse.days) : [...ALL_WEEKDAYS],
    mode: DEFAULT_LIMIT_MODE,
    reason: '',
  };
}

export type LimitProblem = 'no_targets' | 'minutes' | 'no_days' | 'name_long';

/** Why a draft cannot be sent (`null`: it can). */
export function limitProblem(
  draft: Pick<LimitDraft, 'name' | 'targets' | 'dailyMinutes' | 'days'>,
): LimitProblem | null {
  if (targetTotal(draft.targets) === 0) return 'no_targets';
  if (
    !Number.isInteger(draft.dailyMinutes) ||
    draft.dailyMinutes < GUARDIAN_LIMITS.limitMinMinutes ||
    draft.dailyMinutes > GUARDIAN_LIMITS.limitMaxMinutes
  ) {
    return 'minutes';
  }
  if (draft.days.length === 0) return 'no_days';
  if (draft.name.trim().length > GUARDIAN_LIMITS.limitNameMaxLength) return 'name_long';
  return null;
}

/** Hardcore limits block with no emergency unlock: saving asks «¿Seguro?» first. */
export function limitNeedsConsequence(mode: LimitMode): boolean {
  return mode === 'hardcore';
}

/**
 * The body of `limits:create` / `limits:update`: the name filled in when empty, days sorted,
 * the reason trimmed, and the acknowledgement the «¿Seguro?» gave (Hardcore only).
 */
export function limitDraftToInput(draft: LimitDraft, acknowledged: boolean): DailyLimitInput {
  const name = draft.name.trim();
  return {
    name: name === '' ? limitAutoName(draft.targets) : name,
    enabled: true,
    targets: cloneTargets(draft.targets),
    dailyMinutes: draft.dailyMinutes,
    days: sortedDays(draft.days),
    mode: draft.mode,
    reason: draft.reason.trim().slice(0, GUARDIAN_LIMITS.reasonMaxLength),
    acknowledgeNoEmergency: acknowledged && limitNeedsConsequence(draft.mode),
  };
}

/**
 * «Minutos al día» as typed: a bare number of minutes («30»), or a duration the parser reads
 * («1 h», «1h30», «hora y media», «45 min»). `null` when it is not one. The range (5–720) is
 * checked apart (`limitProblem`), so the field can say what is wrong.
 */
export function parseLimitMinutes(text: string, nowMs: number): number | null {
  const clean = text.trim();
  if (clean === '') return null;
  if (/^\d{1,4}$/.test(clean)) return Number(clean);
  const parse = parseIntent(clean, { now: new Date(nowMs) });
  const duration = parse.chips.some((c) => c.kind === 'duration');
  if (!duration || parse.unparsed.length > 0 || parse.durationMinutes === undefined) return null;
  if (parse.serviceIds.length + parse.categoryIds.length + parse.domains.length > 0) return null;
  return parse.durationMinutes;
}

// ---------------------------------------------------------------------------------------
// A limit's day
// ---------------------------------------------------------------------------------------

/** Whole minutes used today (the guardian's `/v1/state` already floors them). */
export function usedMinutesToday(limit: Pick<DailyLimit, 'usedTodaySeconds'>): number {
  return Math.max(0, Math.floor(limit.usedTodaySeconds / 60));
}

/** Whole minutes left today, rounded up (0 once it ran out). */
export function remainingMinutesToday(limit: Pick<DailyLimit, 'remainingTodaySeconds'>): number {
  return Math.max(0, Math.ceil(limit.remainingTodaySeconds / 60));
}

/** Used share of today's allowance, 0…1 (the row's bar). */
export function limitUsageFraction(
  limit: Pick<DailyLimit, 'usedTodaySeconds' | 'dailyMinutes'>,
): number {
  if (limit.dailyMinutes <= 0) return 1;
  return Math.min(1, Math.max(0, limit.usedTodaySeconds / (limit.dailyMinutes * 60)));
}

/** It ran out today on a day it applies (the guardian blocks until midnight). */
export function limitReachedToday(limit: Pick<DailyLimit, 'reachedAt' | 'appliesToday'>): boolean {
  return limit.appliesToday && limit.reachedAt !== null;
}

/** Every limit of a state (guardians without `daily_limits` send none). */
export function stateLimits(state: GuardianStateResponse | null): DailyLimit[] {
  return state?.limits ?? [];
}

/** The state has an enabled limit (the app then reports foreground-app usage). */
export function hasEnabledLimit(state: GuardianStateResponse | null): boolean {
  return stateLimits(state).some((l) => l.enabled);
}

/** A block the guardian made because a daily limit ran out. */
export function isLimitBlock(block: Pick<Block, 'kind' | 'limitId'>): boolean {
  return block.kind === 'limit' || (block.limitId ?? null) !== null;
}

/** The limit behind a limit block (`null` when it is gone or not in this state). */
export function limitOfBlock(
  state: GuardianStateResponse | null,
  block: Pick<Block, 'limitId'>,
): DailyLimit | null {
  const id = block.limitId ?? null;
  if (id === null) return null;
  return stateLimits(state).find((l) => l.id === id) ?? null;
}

/** «YouTube» for a limit block: its limit's name, else what it blocks. */
export function limitBlockName(
  state: GuardianStateResponse | null,
  block: Pick<Block, 'limitId' | 'targets' | 'whitelistOnly'>,
): string {
  return limitOfBlock(state, block)?.name ?? targetsLabel(block.targets, block.whitelistOnly, 2);
}

/** `list` with `limit` replaced (same id) or added at the end (creation order). */
export function upsertLimit(list: readonly DailyLimit[], limit: DailyLimit): DailyLimit[] {
  const index = list.findIndex((l) => l.id === limit.id);
  if (index < 0) return [...list, limit];
  return list.map((l, i) => (i === index ? limit : l));
}

export function withoutLimit(list: readonly DailyLimit[], id: string): DailyLimit[] {
  return list.filter((l) => l.id !== id);
}

// ---------------------------------------------------------------------------------------
// The Bloqueos editor's state
// ---------------------------------------------------------------------------------------

/**
 * A new limit: the targets the form above names (or the seed's), 30 min a day (or the seed's
 * allowance), every day, Estricto. A seed comes from the main window («Editar…» on the
 * «Límite diario» card, or a limit phrase not fully understood).
 */
export function newLimitEditor(
  options: { targets?: TargetSpec | null; seed?: DraftSeed | null } = {},
): LimitEditorState {
  const seed = options.seed ?? null;
  const targets = seed?.targets ?? options.targets ?? null;
  const minutes =
    seed?.end?.kind === 'duration' &&
    seed.end.minutes >= GUARDIAN_LIMITS.limitMinMinutes &&
    seed.end.minutes <= GUARDIAN_LIMITS.limitMaxMinutes
      ? seed.end.minutes
      : DEFAULT_LIMIT_MINUTES;
  const mode: LimitMode =
    seed?.mode && (LIMIT_MODES as readonly string[]).includes(seed.mode)
      ? (seed.mode as LimitMode)
      : DEFAULT_LIMIT_MODE;
  return {
    id: null,
    input: {
      name: '',
      enabled: true,
      targets: targets
        ? cloneTargets(targets)
        : { serviceIds: [], categoryIds: [], appIds: [], customDomains: [], customProcesses: [] },
      dailyMinutes: minutes,
      days: [...ALL_WEEKDAYS],
      mode,
      reason: seed?.reason ?? '',
      acknowledgeNoEmergency: false,
    },
    minutesText: durationLabel(minutes),
    error: null,
  };
}

/** A saved limit in the editor (its effective definition; the pending change is apart). */
export function limitEditorFor(limit: DailyLimit): LimitEditorState {
  return {
    id: limit.id,
    input: limitInputFromLimit(limit, false),
    minutesText: durationLabel(limit.dailyMinutes),
    error: null,
  };
}
