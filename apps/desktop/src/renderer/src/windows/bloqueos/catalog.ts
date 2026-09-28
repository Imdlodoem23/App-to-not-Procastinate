/**
 * «Qué bloquear» of the Bloqueos form (PROMPT §4 «Formulario avanzado»): the catalog as
 * category groups with checkboxes (plus «Otros», the opt-in services no category includes),
 * the catalog search, custom domains validated with the shared `normalizeDomain`, and desktop
 * apps (catalog apps or plain process names) with suggestions from the running processes.
 *
 * Every function takes a `TargetSpec` and returns a new one; nothing here invents targets.
 * Pure: no DOM, Node or Electron imports.
 */
import {
  APPS,
  CATEGORIES,
  SERVICES,
  findAppByProcessName,
  findServiceByDomain,
  getApp,
  isAlwaysAllowedHost,
  isProtectedDomain,
  isProtectedProcessName,
  isValidProcessName,
  normalizeDomain,
  processNameKey,
  type App,
  type CatalogPlatform,
  type CategoryId,
  type Service,
} from '@centrate/shared/catalog';
import type { TargetSpec } from '@centrate/shared/domain';
import { GUARDIAN_LIMITS } from '@centrate/shared/guardian-api';
import { categoryName } from '../../../../shared/format';
import type { Platform } from '../../../../shared/ui-state';
import { BLOQUEOS } from './i18n';

const T = BLOQUEOS.targets;

/** `process.platform` style → the catalog's process-name platform. */
export function toCatalogPlatform(platform: Platform): CatalogPlatform {
  return platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
}

/** Search key: no accents, lowercase, single spaces. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** How many things the form blocks (services, categories, apps, domains, processes). */
export function selectedCount(targets: TargetSpec): number {
  return (
    targets.serviceIds.length +
    targets.categoryIds.length +
    targets.appIds.length +
    targets.customDomains.length +
    targets.customProcesses.length
  );
}

// ---------------------------------------------------------------------------------------
// Catalog groups and search
// ---------------------------------------------------------------------------------------

export type GroupId = CategoryId | 'otros';

export interface ServiceOption {
  id: string;
  name: string;
  /** 1–2 letters (the catalog has no favicons yet). */
  monogram: string;
  checked: boolean;
  /** Name of the checked category that already blocks it (the checkbox is then locked). */
  includedBy: string | null;
}

export interface CatalogGroup {
  id: GroupId;
  name: string;
  /** `null` for «Otros» (not a category: it has no checkbox of its own). */
  categoryId: CategoryId | null;
  checked: boolean;
  services: ServiceOption[];
  /** Services picked one by one (they open the group by default). */
  picked: number;
}

function serviceOption(service: Service, targets: TargetSpec): ServiceOption {
  const covering = service.categories.find((c) => targets.categoryIds.includes(c));
  const includedBy = covering ? categoryName(covering) : null;
  return {
    id: service.id,
    name: service.name,
    monogram: service.monogram,
    checked: includedBy !== null || targets.serviceIds.includes(service.id),
    includedBy,
  };
}

function groupOf(
  id: GroupId,
  name: string,
  categoryId: CategoryId | null,
  services: readonly Service[],
  targets: TargetSpec,
): CatalogGroup {
  return {
    id,
    name,
    categoryId,
    checked: categoryId !== null && targets.categoryIds.includes(categoryId),
    services: services.map((s) => serviceOption(s, targets)),
    picked: services.filter((s) => targets.serviceIds.includes(s.id)).length,
  };
}

/** The six categories in catalog order, then «Otros». */
export function catalogGroups(targets: TargetSpec): CatalogGroup[] {
  const groups = CATEGORIES.map((category) =>
    groupOf(
      category.id,
      categoryName(category.id),
      category.id,
      SERVICES.filter((s) => s.categories.includes(category.id)),
      targets,
    ),
  );
  const optIn = SERVICES.filter((s) => s.categories.length === 0);
  return [...groups, groupOf('otros', T.otros, null, optIn, targets)];
}

export interface CatalogSearch {
  categories: CatalogGroup[];
  services: ServiceOption[];
}

function rank(names: readonly string[], q: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const key = fold(name);
    if (key === q) return 0;
    if (key.startsWith(q)) best = Math.min(best, 1);
    else if (key.split(/[\s.+-]/).some((word) => word.startsWith(q))) best = Math.min(best, 2);
    else if (key.includes(q)) best = Math.min(best, 3);
  }
  return best;
}

/**
 * Catalog matches for the search box (names and aliases, accents ignored; with a dot, the
 * service's hosts too). `null` when the box is empty: the groups show instead.
 */
export function searchCatalog(
  query: string,
  targets: TargetSpec,
  limit: number = 12,
): CatalogSearch | null {
  const q = fold(query);
  if (q === '') return null;
  const categories = CATEGORIES.map((c) => ({
    c,
    r: rank([categoryName(c.id), c.name, ...c.aliases], q),
  }))
    .filter((x) => Number.isFinite(x.r))
    .sort((a, b) => a.r - b.r)
    .map(({ c }) =>
      groupOf(
        c.id,
        categoryName(c.id),
        c.id,
        SERVICES.filter((s) => s.categories.includes(c.id)),
        targets,
      ),
    );
  const services = SERVICES.map((s, index) => {
    const names = [s.name, ...s.aliases];
    let r = rank(names, q);
    if (!Number.isFinite(r) && q.includes('.') && s.domains.some((d) => d.includes(q))) r = 4;
    return { s, r, index };
  })
    .filter((x) => Number.isFinite(x.r))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .slice(0, limit)
    .map(({ s }) => serviceOption(s, targets));
  return { categories, services };
}

/** Check or uncheck a category; checking it drops the services it already covers. */
export function withCategory(targets: TargetSpec, id: CategoryId, on: boolean): TargetSpec {
  if (on) {
    if (targets.categoryIds.includes(id)) return targets;
    const categoryIds = CATEGORIES.map((c) => c.id).filter(
      (c) => c === id || targets.categoryIds.includes(c),
    );
    const serviceIds = targets.serviceIds.filter(
      (sid) => !SERVICES.find((s) => s.id === sid)?.categories.includes(id),
    );
    return { ...targets, categoryIds, serviceIds };
  }
  if (!targets.categoryIds.includes(id)) return targets;
  return { ...targets, categoryIds: targets.categoryIds.filter((c) => c !== id) };
}

/** Check or uncheck one service (a service covered by a checked category stays as it is). */
export function withService(targets: TargetSpec, id: string, on: boolean): TargetSpec {
  const service = SERVICES.find((s) => s.id === id);
  if (!service) return targets;
  if (service.categories.some((c) => targets.categoryIds.includes(c))) return targets;
  const has = targets.serviceIds.includes(id);
  if (on === has) return targets;
  return {
    ...targets,
    serviceIds: on ? [...targets.serviceIds, id] : targets.serviceIds.filter((s) => s !== id),
  };
}

// ---------------------------------------------------------------------------------------
// Custom domains and apps
// ---------------------------------------------------------------------------------------

export type EntryResult =
  { ok: true; targets: TargetSpec; note: string | null } | { ok: false; error: string };

/**
 * Add what the user typed in «Dominios propios». A catalog host marks its service instead
 * (it blocks every host of the service, not only the one typed).
 */
export function addCustomDomain(targets: TargetSpec, input: string): EntryResult {
  const domain = normalizeDomain(input);
  if (domain === null) return { ok: false, error: T.domains.invalid };
  if (isProtectedDomain(domain) || isAlwaysAllowedHost(domain)) {
    return { ok: false, error: T.domains.protected };
  }
  const service = findServiceByDomain(domain);
  if (service) {
    if (serviceOption(service, targets).checked) return { ok: false, error: T.domains.duplicate };
    return {
      ok: true,
      targets: withService(targets, service.id, true),
      note: T.domains.catalog(domain, service.name),
    };
  }
  if (targets.customDomains.includes(domain)) return { ok: false, error: T.domains.duplicate };
  if (targets.customDomains.length >= GUARDIAN_LIMITS.maxCustomDomains) {
    return { ok: false, error: T.domains.max(GUARDIAN_LIMITS.maxCustomDomains) };
  }
  return {
    ok: true,
    targets: { ...targets, customDomains: [...targets.customDomains, domain] },
    note: null,
  };
}

function appByName(name: string): App | undefined {
  const key = fold(name);
  return APPS.find((a) => fold(a.name) === key);
}

/** Add a catalog app (by name or process name) or a plain process name. */
export function addProcessEntry(
  targets: TargetSpec,
  input: string,
  platform: CatalogPlatform,
): EntryResult {
  const name = input.trim();
  const app = appByName(name) ?? findAppByProcessName(name, platform);
  if (app) {
    if (targets.appIds.includes(app.id)) return { ok: false, error: T.apps.duplicate };
    if (targets.appIds.length >= GUARDIAN_LIMITS.maxIdsPerList) {
      return { ok: false, error: T.apps.max(GUARDIAN_LIMITS.maxIdsPerList) };
    }
    return { ok: true, targets: { ...targets, appIds: [...targets.appIds, app.id] }, note: null };
  }
  if (!isValidProcessName(name)) return { ok: false, error: T.apps.invalid };
  if (isProtectedProcessName(name)) return { ok: false, error: T.apps.protected };
  const key = processNameKey(name, platform);
  if (targets.customProcesses.some((p) => processNameKey(p, platform) === key)) {
    return { ok: false, error: T.apps.duplicate };
  }
  if (targets.customProcesses.length >= GUARDIAN_LIMITS.maxCustomProcesses) {
    return { ok: false, error: T.apps.max(GUARDIAN_LIMITS.maxCustomProcesses) };
  }
  return {
    ok: true,
    targets: { ...targets, customProcesses: [...targets.customProcesses, name] },
    note: null,
  };
}

export type AppSuggestion =
  { kind: 'app'; id: string; label: string } | { kind: 'process'; name: string; label: string };

/**
 * Suggestions under «Apps del ordenador»: catalog apps whose name matches, then running
 * processes that match (a running catalog app is offered by its name). With an empty box,
 * only the catalog apps that are running now. Protected processes and entries already in the
 * form are never offered.
 */
export function appSuggestions(
  query: string,
  running: readonly string[],
  targets: TargetSpec,
  platform: CatalogPlatform,
  limit: number = 5,
): AppSuggestion[] {
  const q = fold(query);
  const out: AppSuggestion[] = [];
  const seenApps = new Set(targets.appIds);
  const seenProcesses = new Set(targets.customProcesses.map((p) => processNameKey(p, platform)));
  const pushApp = (app: App): void => {
    if (seenApps.has(app.id)) return;
    seenApps.add(app.id);
    out.push({ kind: 'app', id: app.id, label: app.name });
  };
  if (q !== '') {
    for (const app of APPS) {
      if (Number.isFinite(rank([app.name], q))) pushApp(app);
    }
  }
  for (const name of running) {
    if (!isValidProcessName(name) || isProtectedProcessName(name)) continue;
    const app = findAppByProcessName(name, platform);
    if (app) {
      if (q === '' || Number.isFinite(rank([app.name, name], q))) pushApp(app);
      continue;
    }
    if (q === '' || !fold(name).includes(q)) continue;
    const key = processNameKey(name, platform);
    if (seenProcesses.has(key)) continue;
    seenProcesses.add(key);
    out.push({ kind: 'process', name, label: name });
  }
  return out.slice(0, limit);
}

export interface EntryView {
  kind: 'domain' | 'app' | 'process';
  /** Domain, app id or process name. */
  key: string;
  label: string;
}

/** The removable entries under «Dominios propios» and «Apps del ordenador». */
export function customEntries(targets: TargetSpec): { domains: EntryView[]; apps: EntryView[] } {
  return {
    domains: targets.customDomains.map((d) => ({ kind: 'domain', key: d, label: d })),
    apps: [
      ...targets.appIds.map((id): EntryView => ({
        kind: 'app',
        key: id,
        label: getApp(id)?.name ?? id,
      })),
      ...targets.customProcesses.map((p): EntryView => ({ kind: 'process', key: p, label: p })),
    ],
  };
}

export function withoutEntry(
  targets: TargetSpec,
  entry: Pick<EntryView, 'kind' | 'key'>,
): TargetSpec {
  switch (entry.kind) {
    case 'domain':
      return { ...targets, customDomains: targets.customDomains.filter((d) => d !== entry.key) };
    case 'app':
      return { ...targets, appIds: targets.appIds.filter((a) => a !== entry.key) };
    case 'process':
      return {
        ...targets,
        customProcesses: targets.customProcesses.filter((p) => p !== entry.key),
      };
  }
}

/** Apply a suggestion (the same checks as typing it). */
export function addSuggestion(
  targets: TargetSpec,
  suggestion: AppSuggestion,
  platform: CatalogPlatform,
): EntryResult {
  if (suggestion.kind === 'app') {
    const app = getApp(suggestion.id);
    if (!app) return { ok: false, error: T.apps.invalid };
    if (targets.appIds.includes(app.id)) return { ok: false, error: T.apps.duplicate };
    return { ok: true, targets: { ...targets, appIds: [...targets.appIds, app.id] }, note: null };
  }
  return addProcessEntry(targets, suggestion.name, platform);
}
