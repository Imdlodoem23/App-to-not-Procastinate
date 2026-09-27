import {
  ALWAYS_ALLOWED_HOSTS,
  APPS,
  CATALOG_VERSION,
  CATEGORIES,
  PROTECTED_PROCESS_NAMES,
  SERVICES,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
} from './data/index';
import type { App, CatalogSnapshot } from './types';

function copyApp(app: App): CatalogSnapshot['apps'][number] {
  return {
    id: app.id,
    name: app.name,
    processes: {
      win: [...app.processes.win],
      mac: [...app.processes.mac],
      linux: [...app.processes.linux],
    },
  };
}

/**
 * A plain, JSON-serializable copy of the whole catalog. Optional fields are always
 * present (empty list or `false`) so typed consumers such as the Go guardian get a
 * stable shape. The guardian embeds this as generated JSON; never edit that file by hand.
 */
export function catalogSnapshot(): CatalogSnapshot {
  return {
    version: CATALOG_VERSION,
    categories: CATEGORIES.map((category) => ({
      id: category.id,
      name: category.name,
      aliases: [...category.aliases],
      appIds: [...(category.appIds ?? [])],
    })),
    services: SERVICES.map((service) => ({
      id: service.id,
      name: service.name,
      categories: [...service.categories],
      domains: [...service.domains],
      appIds: [...(service.appIds ?? [])],
      aliases: [...service.aliases],
      monogram: service.monogram,
      educationalCapable: service.educationalCapable ?? false,
      titleHints: [...(service.titleHints ?? [])],
      excludedSubdomains: [...(service.excludedSubdomains ?? [])],
    })),
    apps: APPS.map(copyApp),
    studyWhitelist: STUDY_WHITELIST.map((site) => ({
      id: site.id,
      name: site.name,
      domains: [...site.domains],
      hostPatterns: [...(site.hostPatterns ?? [])],
    })),
    studyAppWhitelist: STUDY_APP_WHITELIST.map(copyApp),
    protectedProcesses: [...PROTECTED_PROCESS_NAMES],
    alwaysAllowedHosts: [...ALWAYS_ALLOWED_HOSTS],
  };
}
