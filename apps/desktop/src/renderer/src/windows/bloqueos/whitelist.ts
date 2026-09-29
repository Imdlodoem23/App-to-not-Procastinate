/**
 * The study whitelist editor of «Modo examen» (PROMPT §9 «Modo examen: lista blanca + Hardcore»,
 * §10 «Ventanas de detalle › Bloqueos»; ARCHITECTURE §5.8, §8.8 «Settings»). Exam blocks, exam
 * schedules and the level-2 punishment allow the catalog's study sites and apps plus the user's
 * extras, `settings.studyWhitelist` in the guardian's settings. Pure.
 *
 * Rules that come from the guardian:
 * - `settings:put` replaces the **whole** settings: the body starts from the effective values
 *   with every pending change applied (`targetSettings`), else a PUT would cancel an unrelated
 *   pending change («setting the effective value again cancels it»);
 * - adding an entry weakens the whitelist, so it waits 24 h (`pending`, with its `effectiveAt`
 *   estimate); removing one applies at once, also from a pending list;
 * - nothing that is a distraction may be allowed (`findAllowDistraction`, 422
 *   `allow_distraction` with the reason), nor what the system needs (`protected_target`).
 *
 * The same checks run here before sending, with the shared helpers, so the reason shows at once.
 */
import {
  getApp,
  getService,
  isAllowedInStudyWhitelist,
  isAlwaysAllowedHost,
  isProtectedDomain,
  isProtectedProcessName,
  isSameOrSubdomain,
  isValidProcessName,
  normalizeDomain,
  processNameKey,
  studyWhitelistProcesses,
  type CatalogPlatform,
} from '@centrate/shared/catalog';
import type { GuardianSettings, PendingSettingChange } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  findAllowDistraction,
  type AllowDistraction,
  type SettingsResponse,
} from '@centrate/shared/guardian-api';
import { appLabel } from '../../../../shared/format';
import type { UiError } from '../../../../shared/ui-state';
import { errorCopy } from '../../i18n/errors';
import { fold } from './catalog';
import { BLOQUEOS } from './i18n';
import { whenLabel } from './time';

const W = BLOQUEOS.exam.whitelist;

export type SettingsData =
  | { status: 'loading' }
  | { status: 'ready'; value: SettingsResponse }
  | { status: 'error'; error: UiError };

export type WhitelistKind = 'domain' | 'process';

/** The two lists the whitelist editor edits. */
export interface WhitelistLists {
  domains: string[];
  processes: string[];
}

const PATHS = {
  domains: 'studyWhitelist.extraDomains',
  processes: 'studyWhitelist.extraProcesses',
} as const;

function pendingOf<F extends PendingSettingChange['field']>(
  pending: readonly PendingSettingChange[],
  field: F,
): Extract<PendingSettingChange, { field: F }> | undefined {
  return pending.find((p): p is Extract<PendingSettingChange, { field: F }> => p.field === field);
}

function cloneSettings(s: GuardianSettings): GuardianSettings {
  return {
    ...s,
    punishment: { ...s.punishment },
    studyWhitelist: {
      extraDomains: [...s.studyWhitelist.extraDomains],
      extraProcesses: [...s.studyWhitelist.extraProcesses],
    },
  };
}

/**
 * The settings as they will be once every pending change applies: what a `settings:put` sends
 * for everything it does not mean to change (so it keeps each pending change as it is).
 */
export function targetSettings(response: SettingsResponse): GuardianSettings {
  const out = cloneSettings(response.settings);
  for (const change of response.pending) {
    switch (change.field) {
      case 'timezone':
        out.timezone = change.value;
        break;
      case 'dailyGoalMinutes':
        out.dailyGoalMinutes = change.value;
        break;
      case 'attemptPenalties':
        out.attemptPenalties = change.value;
        break;
      case 'closeBrowsersWithoutExtension':
        out.closeBrowsersWithoutExtension = change.value;
        break;
      case 'serverTimeCheck':
        out.serverTimeCheck = change.value;
        break;
      case 'studyWhitelist.extraDomains':
        out.studyWhitelist.extraDomains = [...change.value];
        break;
      case 'studyWhitelist.extraProcesses':
        out.studyWhitelist.extraProcesses = [...change.value];
        break;
    }
  }
  return out;
}

/** The extras once the pending additions apply. */
export function whitelistLists(response: SettingsResponse): WhitelistLists {
  const target = targetSettings(response).studyWhitelist;
  return { domains: [...target.extraDomains], processes: [...target.extraProcesses] };
}

export interface WhitelistEntryView {
  kind: WhitelistKind;
  value: string;
  /** «wikipedia.org», «geogebra.org · desde mañana 17:10». */
  label: string;
  /** «Quitar geogebra.org (se permitirá mañana 17:10)». */
  removeLabel: string;
  /** When a pending addition applies («mañana 17:10»), `null` when it already does. */
  pendingWhen: string | null;
}

function entryViews(
  kind: WhitelistKind,
  effective: readonly string[],
  target: readonly string[],
  pending: { effectiveAt: string } | undefined,
  nowMs: number,
): WhitelistEntryView[] {
  const when = pending ? whenLabel(Date.parse(pending.effectiveAt), nowMs) : null;
  const all = [...effective, ...target.filter((v) => !effective.includes(v))];
  return all.map((value) => {
    const waiting = !effective.includes(value) && when !== null;
    const label = value;
    return {
      kind,
      value,
      label: waiting && when ? W.pendingChip(label, when) : label,
      removeLabel: waiting && when ? W.removePending(label, when) : W.remove(label),
      pendingWhen: waiting ? when : null,
    };
  });
}

export interface WhitelistView {
  status: SettingsData['status'];
  error: UiError | null;
  /** «Tu lista blanca: 3 extras · 1 esperando». */
  title: string;
  entries: WhitelistEntryView[];
  /** At the limits: the fields refuse more. */
  full: { domains: boolean; processes: boolean };
}

export function whitelistView(data: SettingsData, nowMs: number): WhitelistView {
  if (data.status !== 'ready') {
    return {
      status: data.status,
      error: data.status === 'error' ? data.error : null,
      title: data.status === 'loading' ? W.loading : W.unavailable,
      entries: [],
      full: { domains: false, processes: false },
    };
  }
  const r = data.value;
  const effective = r.settings.studyWhitelist;
  const target = whitelistLists(r);
  const entries = [
    ...entryViews(
      'domain',
      effective.extraDomains,
      target.domains,
      pendingOf(r.pending, PATHS.domains),
      nowMs,
    ),
    ...entryViews(
      'process',
      effective.extraProcesses,
      target.processes,
      pendingOf(r.pending, PATHS.processes),
      nowMs,
    ),
  ];
  const waiting = entries.filter((e) => e.pendingWhen !== null).length;
  return {
    status: 'ready',
    error: null,
    title: W.title(entries.length - waiting, waiting),
    entries,
    full: {
      domains: target.domains.length >= GUARDIAN_LIMITS.maxWhitelistExtraDomains,
      processes: target.processes.length >= GUARDIAN_LIMITS.maxWhitelistExtraProcesses,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Checks before sending
// ---------------------------------------------------------------------------------------

export type WhitelistCheck = { ok: true; value: string } | { ok: false; error: string };

/** Why the guardian would refuse to allow this entry (`findAllowDistraction`), in words. */
export function allowDistractionText(
  found: Pick<AllowDistraction, 'reason' | 'serviceId' | 'appId'>,
  value: string,
): string {
  const D = W.distraction;
  const service = found.serviceId ? (getService(found.serviceId)?.name ?? found.serviceId) : null;
  switch (found.reason) {
    case 'service_domain':
      return D.serviceDomain(value, service ?? value);
    case 'parent_of_service_domain':
      return D.parentOfService(value, service ?? value);
    case 'public_suffix':
      return D.publicSuffix(value);
    case 'distraction_app':
      return D.app(found.appId && getApp(found.appId) ? appLabel(found.appId) : value);
  }
}

/** A web for the whitelist: canonical, not already allowed, never a distraction. */
export function checkWhitelistDomain(input: string, lists: WhitelistLists): WhitelistCheck {
  const domain = normalizeDomain(input);
  if (domain === null) return { ok: false, error: W.invalidDomain };
  if (isProtectedDomain(domain)) return { ok: false, error: W.protectedDomain };
  const found = findAllowDistraction(
    { domains: [domain], processes: [] },
    { domains: PATHS.domains, processes: PATHS.processes },
  );
  if (found) return { ok: false, error: allowDistractionText(found, domain) };
  if (isAlwaysAllowedHost(domain) || isAllowedInStudyWhitelist(domain)) {
    return { ok: false, error: W.studyDefault };
  }
  if (lists.domains.includes(domain)) return { ok: false, error: W.duplicate };
  const parent = lists.domains.find((d) => isSameOrSubdomain(domain, d));
  if (parent) return { ok: false, error: W.coveredBy(parent) };
  if (lists.domains.length >= GUARDIAN_LIMITS.maxWhitelistExtraDomains) {
    return { ok: false, error: W.maxDomains(GUARDIAN_LIMITS.maxWhitelistExtraDomains) };
  }
  return { ok: true, value: domain };
}

/** An app for the whitelist: a plain process name, not a distraction, not already allowed. */
export function checkWhitelistProcess(
  input: string,
  lists: WhitelistLists,
  platform: CatalogPlatform,
): WhitelistCheck {
  const name = input.trim();
  if (!isValidProcessName(name)) return { ok: false, error: W.invalidApp };
  if (isProtectedProcessName(name)) return { ok: false, error: W.protectedApp };
  const found = findAllowDistraction(
    { domains: [], processes: [name] },
    { domains: PATHS.domains, processes: PATHS.processes },
  );
  if (found) return { ok: false, error: allowDistractionText(found, name) };
  const key = processNameKey(name, platform);
  if (studyWhitelistProcesses(platform).some((p) => processNameKey(p, platform) === key)) {
    return { ok: false, error: W.studyDefault };
  }
  if (lists.processes.some((p) => processNameKey(p, platform) === key)) {
    return { ok: false, error: W.duplicate };
  }
  if (lists.processes.length >= GUARDIAN_LIMITS.maxWhitelistExtraProcesses) {
    return { ok: false, error: W.maxApps(GUARDIAN_LIMITS.maxWhitelistExtraProcesses) };
  }
  return { ok: true, value: name };
}

/**
 * Running programs worth offering for the whitelist while typing: they match and pass every
 * check (no distraction, nothing the system or the study list already allows), at most `limit`.
 * Nothing while the box is empty.
 */
export function whitelistSuggestions(
  query: string,
  running: readonly string[],
  lists: WhitelistLists,
  platform: CatalogPlatform,
  limit: number = 4,
): string[] {
  const q = fold(query);
  if (q === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of running) {
    if (out.length >= limit) break;
    if (!fold(name).includes(q)) continue;
    const key = processNameKey(name, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    if (checkWhitelistProcess(name, lists, platform).ok) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The body of `settings:put`
// ---------------------------------------------------------------------------------------

function withList(
  response: SettingsResponse,
  kind: WhitelistKind,
  edit: (list: string[]) => string[],
): GuardianSettings {
  const out = targetSettings(response);
  if (kind === 'domain') out.studyWhitelist.extraDomains = edit(out.studyWhitelist.extraDomains);
  else out.studyWhitelist.extraProcesses = edit(out.studyWhitelist.extraProcesses);
  return out;
}

export function withWhitelistEntry(
  response: SettingsResponse,
  kind: WhitelistKind,
  value: string,
): GuardianSettings {
  return withList(response, kind, (list) => (list.includes(value) ? list : [...list, value]));
}

export function withoutWhitelistEntry(
  response: SettingsResponse,
  kind: WhitelistKind,
  value: string,
): GuardianSettings {
  return withList(response, kind, (list) => list.filter((v) => v !== value));
}

// ---------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------

export interface WhitelistNotice {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
}

/** What happened after an addition: allowed now, or waiting its 24 h («desde mañana 17:10»). */
export function addedNotice(
  after: SettingsResponse,
  kind: WhitelistKind,
  value: string,
  nowMs: number,
): WhitelistNotice {
  const effective =
    kind === 'domain'
      ? after.settings.studyWhitelist.extraDomains
      : after.settings.studyWhitelist.extraProcesses;
  if (effective.includes(value)) return { text: W.added(value), tone: 'green' };
  const pending = pendingOf(after.pending, kind === 'domain' ? PATHS.domains : PATHS.processes);
  const when = pending ? whenLabel(Date.parse(pending.effectiveAt), nowMs) : null;
  return { text: when ? W.addedPending(value, when) : W.added(value), tone: 'muted' };
}

export function removedNotice(value: string): WhitelistNotice {
  return { text: W.removed(value), tone: 'green' };
}

/** The guardian's refusal of a whitelist change, in words (with the reason when it gives one). */
export function whitelistErrorText(error: UiError, value: string): string {
  if (error.kind === 'rejected') {
    if (error.code === 'allow_distraction') {
      const d = error.details ?? {};
      const reason = d['reason'];
      if (
        reason === 'service_domain' ||
        reason === 'parent_of_service_domain' ||
        reason === 'public_suffix' ||
        reason === 'distraction_app'
      ) {
        const serviceId = typeof d['serviceId'] === 'string' ? d['serviceId'] : null;
        const appId = typeof d['appId'] === 'string' ? d['appId'] : null;
        return allowDistractionText({ reason, serviceId, appId }, value);
      }
      return W.distraction.generic(value);
    }
    if (error.code === 'protected_target') return W.protectedDomain;
    if (error.code === 'validation_failed') return W.invalidList;
  }
  return errorCopy(error).text;
}
