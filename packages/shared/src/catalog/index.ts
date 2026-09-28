export type {
  App,
  Browser,
  BrowserEngine,
  CatalogPlatform,
  CatalogSnapshot,
  Category,
  CategoryId,
  ProcessNames,
  ResolvedTargets,
  Service,
  StudySite,
  TargetSelection,
} from './types';
export {
  ALWAYS_ALLOWED_HOSTS,
  APPS,
  BROWSERS,
  CATALOG_VERSION,
  CATEGORIES,
  CATEGORY_IDS,
  MULTI_LABEL_SUFFIXES,
  PROTECTED_DOMAINS,
  PROTECTED_PROCESS_NAMES,
  SERVICES,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
} from './data/index';
export {
  expandDomainVariants,
  isDomainAllowedInWhitelist,
  isMultiLabelPublicSuffix,
  isSameOrSubdomain,
  isValidDomain,
  matchesHostPattern,
  normalizeDomain,
} from './domains';
export { isProtectedProcessName, isValidProcessName, processNameKey } from './processes';
export {
  findAppByProcessName,
  findBrowsersByProcessName,
  findServiceByDomain,
  findServiceByProcessName,
  findServiceByWindowTitle,
  getApp,
  getBrowser,
  getCategory,
  getService,
  isAlwaysAllowedHost,
  isProtectedDomain,
  servicesInCategory,
} from './lookup';
export type { AliasConflict, AliasEntry, AliasKind } from './aliases';
export {
  aliasKey,
  findAliasConflicts,
  findCategoryByAlias,
  findServiceByAlias,
  listAliases,
  normalizeAlias,
} from './aliases';
export {
  allDistractionTargets,
  isAllowedInStudyWhitelist,
  resolveTargets,
  studyWhitelistDomains,
  studyWhitelistHostPatterns,
  studyWhitelistProcesses,
} from './resolve';
export { catalogSnapshot } from './snapshot';
