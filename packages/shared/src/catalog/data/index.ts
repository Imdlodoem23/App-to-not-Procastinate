import type { App, Browser, Category, Service, StudySite } from '../types';
import { ALWAYS_ALLOWED_HOST_DATA } from './always-allowed';
import { APP_DATA } from './apps';
import { BROWSER_DATA } from './browsers';
import { CATEGORY_DATA } from './categories';
import { GAMES_SERVICES } from './games';
import { MESSAGING_SERVICES } from './messaging';
import { NEWS_SERVICES } from './news';
import { OPT_IN_SERVICES } from './opt-in';
import { PROTECTED_DOMAIN_DATA } from './protected-domains';
import { PROTECTED_PROCESS_DATA } from './protected';
import { MULTI_LABEL_SUFFIX_DATA } from './public-suffixes';
import { SHOPPING_SERVICES } from './shopping';
import { SOCIAL_SERVICES } from './social';
import { STUDY_APP_DATA, STUDY_SITE_DATA } from './study';
import { VIDEO_SERVICES } from './video';

export { CATEGORY_IDS } from './categories';

/**
 * Bump whenever catalog data changes. The guardian embeds the snapshot together with this
 * number, so stale generated data is easy to spot.
 */
export const CATALOG_VERSION = 3;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CATEGORIES: readonly Category[] = deepFreeze(CATEGORY_DATA);

export const SERVICES: readonly Service[] = deepFreeze([
  ...SOCIAL_SERVICES,
  ...VIDEO_SERVICES,
  ...GAMES_SERVICES,
  ...MESSAGING_SERVICES,
  ...SHOPPING_SERVICES,
  ...NEWS_SERVICES,
  ...OPT_IN_SERVICES,
]);

export const APPS: readonly App[] = deepFreeze(APP_DATA);

/** Default study whitelist, grouped by site. Each domain also allows its subdomains. */
export const STUDY_WHITELIST: readonly StudySite[] = deepFreeze(STUDY_SITE_DATA);

/** Default study apps (process names per platform). */
export const STUDY_APP_WHITELIST: readonly App[] = deepFreeze(STUDY_APP_DATA);

/** Processes the guardian must never kill. */
export const PROTECTED_PROCESS_NAMES: readonly string[] = deepFreeze(PROTECTED_PROCESS_DATA);

/**
 * Hosts that are never blocked in any mode, together with their subdomains (see
 * ./always-allowed.ts). Whitelist mode allows them too.
 */
export const ALWAYS_ALLOWED_HOSTS: readonly string[] = deepFreeze(ALWAYS_ALLOWED_HOST_DATA);

/** Browsers the guardian recognises by process name (see ./browsers.ts). */
export const BROWSERS: readonly Browser[] = deepFreeze(BROWSER_DATA);

/**
 * Domains no block may list, each with its subdomains: OS updates and time, the
 * guardian's time calibration, Céntrate's own hosts and localhost (see
 * ./protected-domains.ts).
 */
export const PROTECTED_DOMAINS: readonly string[] = deepFreeze(PROTECTED_DOMAIN_DATA);

/** Two-label public suffixes such as `co.uk` and `com.br` (see ./public-suffixes.ts). */
export const MULTI_LABEL_SUFFIXES: readonly string[] = deepFreeze(MULTI_LABEL_SUFFIX_DATA);
