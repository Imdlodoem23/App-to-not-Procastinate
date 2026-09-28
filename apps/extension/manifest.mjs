// The manifest each engine gets from the one in public/ (build.mjs, package.mjs,
// sign-firefox.mjs).
//
// Incognito: Chromium only loads an extension's own pages in incognito tabs in "split" mode
// (with "spanning" the redirect to blocked.html ends on the browser's error page, so the
// user sees no reason, time left or points and no attempt is reported). Firefox has no
// split mode (it treats "split" as "not_allowed") and shows extension pages in private
// windows with "spanning". src/background/index.ts runs the incognito instance of split
// mode as a follower of the main one.

/** @typedef {'chromium' | 'firefox'} Engine */

/** @type {readonly Engine[]} */
export const ENGINES = Object.freeze(['chromium', 'firefox']);

/** @type {Readonly<Record<Engine, { incognito: 'split' | 'spanning' }>>} */
const SETTINGS = Object.freeze({
  chromium: { incognito: 'split' },
  firefox: { incognito: 'spanning' },
});

/**
 * @param {unknown} value
 * @returns {value is Engine}
 */
export function isEngine(value) {
  return typeof value === 'string' && ENGINES.includes(/** @type {Engine} */ (value));
}

/**
 * The manifest for `engine`, from the one in public/ (not modified).
 * @param {Record<string, unknown>} manifest
 * @param {Engine} engine
 * @returns {Record<string, unknown>}
 */
export function manifestFor(manifest, engine) {
  return { ...manifest, incognito: SETTINGS[engine].incognito };
}
