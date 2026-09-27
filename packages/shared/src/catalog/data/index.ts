import type { App, Category, Service, StudySite } from '../types';
import { APP_DATA } from './apps';
import { CATEGORY_DATA } from './categories';
import { GAMES_SERVICES } from './games';
import { MESSAGING_SERVICES } from './messaging';
import { NEWS_SERVICES } from './news';
import { OPT_IN_SERVICES } from './opt-in';
import { PROTECTED_PROCESS_DATA } from './protected';
import { SHOPPING_SERVICES } from './shopping';
import { SOCIAL_SERVICES } from './social';
import { STUDY_APP_DATA, STUDY_SITE_DATA } from './study';
import { VIDEO_SERVICES } from './video';

export { CATEGORY_IDS } from './categories';

/**
 * Bump whenever catalog data changes. The guardian embeds the snapshot together with this
 * number, so stale generated data is easy to spot.
 */
export const CATALOG_VERSION = 1;

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
