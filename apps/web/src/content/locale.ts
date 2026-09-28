/**
 * The copy of each language, for Astro components and pages (never for client scripts: it
 * would put every string of the site in the bundle). Components call `copyFor(Astro.url)`.
 *
 * At build time, the English copy is checked against the Spanish original: the same keys in
 * the same order, the same {placeholders} and [links](…), and no empty strings. A mismatch
 * stops the build with the list of differences.
 */
import { es, translationProblems, type Copy } from './copy';
import { en } from './copy.en';
import { langFromPath, type Lang } from '../lib/i18n';

const byLang: Record<Lang, Copy> = { es, en };

const problems = translationProblems(es, en);
if (problems.length > 0) {
  throw new Error(`copy.en.ts does not match copy.ts:\n- ${problems.join('\n- ')}`);
}

export function getCopy(lang: Lang): Copy {
  return byLang[lang];
}

/** The copy of the page being rendered, from its URL (/en… is English). */
export function copyFor(url: URL): Copy {
  return byLang[langFromPath(url.pathname)];
}
