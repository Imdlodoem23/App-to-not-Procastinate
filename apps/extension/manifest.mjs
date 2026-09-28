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

/** Chromium-only keys Firefox does not know (web-ext lint warns about them). */
const CHROMIUM_ONLY_KEYS = Object.freeze(['key', 'minimum_chrome_version']);

/**
 * The manifest for `engine`, from the one in public/ (not modified).
 *
 * Chromium keeps `key` by default: it pins the id the guardian embeds
 * (`dlabilkpafinafimngfclcfmeghilcah`) for the unpacked install. `{ store: true }` drops it:
 * the Chrome Web Store and Edge Add-ons refuse a manifest with `key` and assign their own
 * id, which the guardian only accepts once an admin lists it in `config.json`
 * `extraExtensionIds` (docs/ARCHITECTURE.md §9.4). Firefox never gets the Chromium-only keys.
 * @param {Record<string, unknown>} manifest
 * @param {Engine} engine
 * @param {{ store?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
export function manifestFor(manifest, engine, options = {}) {
  const result = { ...manifest, incognito: SETTINGS[engine].incognito };
  const drop = engine === 'firefox' ? CHROMIUM_ONLY_KEYS : options.store ? ['key'] : [];
  for (const name of drop) delete result[name];
  return result;
}
