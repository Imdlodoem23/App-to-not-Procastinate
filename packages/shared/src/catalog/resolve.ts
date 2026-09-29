import {
  ALWAYS_ALLOWED_HOSTS,
  CATEGORY_IDS,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
} from './data/index';
import { expandDomainVariants, isDomainAllowedInWhitelist, isSameOrSubdomain } from './domains';
import { getApp, getCategory, getService, isAlwaysAllowedHost, servicesInCategory } from './lookup';
import { isProtectedProcessName, isValidProcessName, processNameKey } from './processes';
import type { CatalogPlatform, ResolvedTargets, Service, TargetSelection } from './types';

function compareProcessNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Expands a selection into the concrete hosts and process names to block on `platform`.
 *
 * - Categories add every service in them (plus category-wide apps such as popular PC
 *   games); services add their domains, apps and `excludedSubdomains`.
 * - Custom domains are normalized and expanded with `expandDomainVariants`; invalid ones
 *   are dropped.
 * - Always-allowed hosts (`ALWAYS_ALLOWED_HOSTS`, such as accounts.youtube.com) are never
 *   returned in `domains`, even when typed as custom domains; when one sits under a
 *   returned domain it is listed in `excludedDomains`.
 * - A service's excluded subdomain is dropped from `excludedDomains` when the user typed
 *   it (or a host under it) as a custom domain: what the user names explicitly is blocked.
 * - Custom process names are trimmed; invalid and protected names (system processes,
 *   Céntrate itself) are dropped.
 * - Unknown service, category and app ids are ignored.
 * - Domains are unique and sorted. Processes are unique (case-insensitively on Windows and
 *   macOS, keeping the first spelling) and sorted.
 */
export function resolveTargets(
  selection: TargetSelection,
  platform: CatalogPlatform,
): ResolvedTargets {
  const domains = new Set<string>();
  const excluded = new Set<string>();
  const appIds = new Set<string>();
  const processes = new Map<string, string>();

  const addService = (service: Service): void => {
    for (const domain of service.domains) domains.add(domain);
    for (const host of service.excludedSubdomains ?? []) excluded.add(host);
    for (const appId of service.appIds ?? []) appIds.add(appId);
  };
  const addProcess = (name: string): void => {
    if (!isValidProcessName(name) || isProtectedProcessName(name)) return;
    const key = processNameKey(name, platform);
    if (!processes.has(key)) processes.set(key, name);
  };

  for (const categoryId of selection.categoryIds ?? []) {
    const category = getCategory(categoryId);
    if (!category) continue;
    servicesInCategory(category.id).forEach(addService);
    for (const appId of category.appIds ?? []) appIds.add(appId);
  }
  for (const serviceId of selection.serviceIds ?? []) {
    const service = getService(serviceId);
    if (service) addService(service);
  }
  for (const raw of selection.domains ?? []) {
    for (const domain of expandDomainVariants(raw)) domains.add(domain);
  }
  for (const appId of selection.appIds ?? []) appIds.add(appId);
  for (const appId of appIds) {
    const app = getApp(appId);
    if (app) app.processes[platform].forEach(addProcess);
  }
  for (const raw of selection.processNames ?? []) {
    if (typeof raw === 'string') addProcess(raw.trim());
  }

  for (const domain of domains) if (isAlwaysAllowedHost(domain)) domains.delete(domain);
  for (const host of excluded) {
    for (const domain of domains) {
      if (isSameOrSubdomain(domain, host)) {
        excluded.delete(host);
        break;
      }
    }
  }
  for (const host of ALWAYS_ALLOWED_HOSTS) {
    for (const domain of domains) {
      if (isSameOrSubdomain(host, domain)) {
        excluded.add(host);
        break;
      }
    }
  }

  return {
    domains: [...domains].sort(),
    excludedDomains: [...excluded].sort(),
    processes: [...processes.values()].sort(compareProcessNames),
  };
}

/** Every category's domains and processes: what the level-1 punishment blocks. */
export function allDistractionTargets(platform: CatalogPlatform): ResolvedTargets {
  return resolveTargets({ categoryIds: CATEGORY_IDS }, platform);
}

/** The default study whitelist as a flat, unique, sorted domain list. */
export function studyWhitelistDomains(): string[] {
  return [...new Set(STUDY_WHITELIST.flatMap((site) => site.domains))].sort();
}

/** The default study whitelist's host patterns (see `StudySite.hostPatterns`), unique. */
export function studyWhitelistHostPatterns(): string[] {
  return [...new Set(STUDY_WHITELIST.flatMap((site) => site.hostPatterns ?? []))].sort();
}

const DEFAULT_STUDY_DOMAINS: readonly string[] = studyWhitelistDomains();
const DEFAULT_STUDY_PATTERNS: readonly string[] = studyWhitelistHostPatterns();

/**
 * True when whitelist mode (punishment level 2, exam mode) allows `domain`: an
 * always-allowed host, a default study domain or host pattern, or one of `extraDomains`
 * (the user's additions, `settings.studyWhitelist.extraDomains`). Subdomains of allowed
 * domains are allowed too; URLs work.
 */
export function isAllowedInStudyWhitelist(
  domain: string,
  extraDomains: Iterable<string> = [],
): boolean {
  return (
    isAlwaysAllowedHost(domain) ||
    isDomainAllowedInWhitelist(domain, DEFAULT_STUDY_DOMAINS, DEFAULT_STUDY_PATTERNS) ||
    isDomainAllowedInWhitelist(domain, extraDomains)
  );
}

/** The default study apps' process names for `platform`, unique and sorted. */
export function studyWhitelistProcesses(platform: CatalogPlatform): string[] {
  const names = new Map<string, string>();
  for (const app of STUDY_APP_WHITELIST) {
    for (const name of app.processes[platform]) {
      const key = processNameKey(name, platform);
      if (!names.has(key)) names.set(key, name);
    }
  }
  return [...names.values()].sort(compareProcessNames);
}
