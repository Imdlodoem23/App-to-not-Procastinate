/**
 * Display names of catalog entries in a UI language. Spanish names are the catalog's own
 * `name`s; English ones come from ./i18n/en.ts, falling back to the catalog name for brand
 * names that do not change («YouTube», «Microsoft Word»). Unknown ids return the id, so a
 * stale id still shows something.
 */
import { DEFAULT_LOCALE, toLocale, type Locale } from '../i18n/locale';
import { STUDY_APP_WHITELIST, STUDY_WHITELIST } from './data/index';
import { CATALOG_NAMES_EN, type CatalogNames } from './i18n/en';
import { getApp, getCategory, getService } from './lookup';

type Section = keyof CatalogNames;

function localizedName(
  section: Section,
  id: string,
  catalogName: string | undefined,
  locale: Locale,
): string {
  if (toLocale(locale) === 'en') {
    const names: Readonly<Record<string, string>> = CATALOG_NAMES_EN[section];
    if (Object.hasOwn(names, id)) return names[id] ?? id;
  }
  return catalogName ?? id;
}

/** «Redes sociales» / «Social media». */
export function categoryName(id: string, locale: Locale = DEFAULT_LOCALE): string {
  return localizedName('categories', id, getCategory(id)?.name, locale);
}

/** A service's name: brand names are the same in every language («YouTube», «El País»). */
export function serviceName(id: string, _locale: Locale = DEFAULT_LOCALE): string {
  return getService(id)?.name ?? id;
}

/** An app of `APPS`: «Steam», «Juegos de PC populares» / «Popular PC games». */
export function appName(id: string, locale: Locale = DEFAULT_LOCALE): string {
  return localizedName('apps', id, getApp(id)?.name, locale);
}

/** A site group of the study whitelist: «Cuenta de Google» / «Google Account». */
export function studySiteName(id: string, locale: Locale = DEFAULT_LOCALE): string {
  const site = STUDY_WHITELIST.find((entry) => entry.id === id);
  return localizedName('studySites', id, site?.name, locale);
}

/** An app of the study whitelist: «Calculadora» / «Calculator». */
export function studyAppName(id: string, locale: Locale = DEFAULT_LOCALE): string {
  const app = STUDY_APP_WHITELIST.find((entry) => entry.id === id);
  return localizedName('studyApps', id, app?.name, locale);
}
