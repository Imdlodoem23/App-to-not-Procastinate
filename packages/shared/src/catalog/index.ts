export type {
  App,
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
  CATALOG_VERSION,
  CATEGORIES,
  CATEGORY_IDS,
  PROTECTED_PROCESS_NAMES,
  SERVICES,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
} from './data/index';
export {
  expandDomainVariants,
  isDomainAllowedInWhitelist,
  isSameOrSubdomain,
  isValidDomain,
  matchesHostPattern,
  normalizeDomain,
} from './domains';
export { isProtectedProcessName, isValidProcessName, processNameKey } from './processes';
export {
  findAppByProcessName,
  findServiceByDomain,
  findServiceByProcessName,
  findServiceByWindowTitle,
  getApp,
  getCategory,
  getService,
  isAlwaysAllowedHost,
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
