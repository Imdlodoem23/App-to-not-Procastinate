import type { CategoryId } from '../types';

/**
 * English display names of catalog entries whose `name` is Spanish. The catalog data (and
 * the snapshot the guardian embeds) keeps the Spanish names; brand names (YouTube,
 * El País, Microsoft Word…) are the same in every language and are not listed here. Any
 * entry added to the catalog with a Spanish name needs its English name here (a test
 * checks it). Conventions: en-US spelling, sentence case.
 */
export interface CatalogNames {
  readonly categories: Readonly<Record<CategoryId, string>>;
  /** `APPS` by id. */
  readonly apps: Readonly<Record<string, string>>;
  /** `STUDY_WHITELIST` by id. */
  readonly studySites: Readonly<Record<string, string>>;
  /** `STUDY_APP_WHITELIST` by id. */
  readonly studyApps: Readonly<Record<string, string>>;
}

export const CATALOG_NAMES_EN: CatalogNames = Object.freeze({
  categories: Object.freeze({
    social: 'Social media',
    video: 'Video and streaming',
    games: 'Games',
    messaging: 'Messaging',
    shopping: 'Shopping',
    news: 'News and sports',
  }),
  apps: Object.freeze({
    'popular-pc-games': 'Popular PC games',
  }),
  studySites: Object.freeze({
    'google-workspace': 'Google Docs, Drive, Slides and Sheets',
    'google-account': 'Google Account',
    'google-scholar': 'Google Scholar',
    rae: 'RAE (Spanish dictionary)',
    translators: 'Translators and dictionaries',
    'school-platforms': 'School platforms',
    publishers: 'Digital textbooks from publishers',
    'class-tools': 'Classroom tools',
  }),
  studyApps: Object.freeze({
    browsers: 'Browsers',
    iwork: 'Pages, Numbers and Keynote',
    calculator: 'Calculator',
    'text-editor': 'Text editor',
  }),
});
