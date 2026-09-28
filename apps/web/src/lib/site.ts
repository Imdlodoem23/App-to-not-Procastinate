/**
 * Site-wide constants that are not copy: repository coordinates, external URLs, routes and the
 * few values the <head> needs as literals. User-facing strings live in src/content/copy.ts.
 *
 * Safe to import from client scripts: it has no dependencies (in particular it does not import
 * copy.ts, which would pull every string of the site into the browser bundle).
 */

/** GitHub repository that hosts the code, the issues and the release downloads. */
export const repo = {
  owner: 'Imdlodoem23',
  name: 'App-to-not-Procastinate',
} as const;

const repoUrl = `https://github.com/${repo.owner}/${repo.name}`;
const apiUrl = `https://api.github.com/repos/${repo.owner}/${repo.name}`;

export const site = {
  /** Source code (footer «Código fuente»). */
  repoUrl,
  /** Public issue tracker (footer «Informar de un problema»). */
  issuesUrl: `${repoUrl}/issues`,
  newIssueUrl: `${repoUrl}/issues/new`,
  /** Every release (for «Todas las versiones en GitHub»). */
  releasesUrl: `${repoUrl}/releases`,
  /** The latest published release page on GitHub. */
  latestReleaseUrl: `${repoUrl}/releases/latest`,
  /**
   * Base of the version-less download links: `${latestDownloadBase}Centrate.dmg`. Use
   * `downloadUrl()` from src/lib/downloads.ts instead of building them by hand.
   */
  latestDownloadBase: `${repoUrl}/releases/latest/download/`,
  licenseUrl: `${repoUrl}/blob/main/LICENSE`,
  api: {
    /** GET, public, CORS-enabled, 60 requests per hour per IP without a token. */
    latestRelease: `${apiUrl}/releases/latest`,
    /** GET, newest first (`?per_page=`), same limits. */
    releases: `${apiUrl}/releases`,
  },
  /**
   * Open Graph image (1200 × 630). A PNG, because most social networks do not show SVG
   * previews: scripts/render-og.mjs draws public/og.png from /og.svg (src/pages/og.svg.ts, built
   * from copy.ts). Re-run `npm run og -w apps/web` after a build when the hero copy changes.
   */
  ogImage: { path: '/og.png', type: 'image/png', width: 1200, height: 630 },
  /**
   * Browser UI color (<meta name="theme-color">). Same value as --palette-white in
   * src/styles/tokens.css: the page is light, with no automatic dark mode.
   */
  themeColor: '#ffffff',
} as const;

/** Internal routes (the pages built from src/pages). */
export const routes = {
  home: '/',
  download: '/descargar',
  changelog: '/novedades',
  privacy: '/privacidad',
} as const;

/** Which page a layout is rendering (drives the navigation bar's download pill). */
export type PageKey = 'home' | 'descargar' | 'novedades' | 'privacidad' | 'not-found';
