/**
 * /novedades in the browser. The page itself is built once, when the site is published
 * (release-history.ts), so a release that came out after that build is not on it yet. This asks
 * GitHub for the latest release (the shared, cached request from lib/downloads.ts) and, when
 * it is newer than the newest version built into the page, shows the one-line notice that links
 * to it. Everything else on the page stays static.
 *
 * Strings arrive through data attributes (templates from copy.ts); this module does not import
 * copy.ts. The version from GitHub is validated by parseRelease() and goes in with textContent.
 */
import { fetchLatestRelease } from '../../lib/downloads';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Version {
  core: [number, number, number];
  pre: string | null;
}

function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/**
 * Semantic version order: > 0 when `a` is newer than `b`, < 0 when older, 0 when equal, and
 * null when either is not a version. A pre-release comes before its release (1.2.0-beta.2 <
 * 1.2.0); pre-release labels compare with numeric parts as numbers (beta.10 > beta.9).
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] as number) - (right.core[i] as number);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return Math.sign(left.pre.localeCompare(right.pre, 'en', { numeric: true }));
}

/**
 * Shows `[data-newer-release]` when GitHub's latest release is newer than its
 * `data-built-version` (or when the page was built with no version at all), and hides the
 * `[data-stale-when-newer]` elements, whose text («no release yet») is then out of date.
 * Never rejects; a failed request leaves the page as it was built.
 */
export async function initNewerReleaseNotice(root: ParentNode = document): Promise<void> {
  const notice = root.querySelector<HTMLElement>('[data-newer-release]');
  const text = notice?.querySelector<HTMLElement>('[data-newer-text]');
  if (!notice || !text) return;

  const release = await fetchLatestRelease();
  if (!release) return;

  const built = notice.dataset.builtVersion ?? '';
  if (built !== '' && (compareVersions(release.version, built) ?? 0) <= 0) return;

  text.textContent = (text.dataset.template || '{version}').replace('{version}', release.version);
  notice.hidden = false;
  for (const stale of root.querySelectorAll<HTMLElement>('[data-stale-when-newer]')) {
    stale.hidden = true;
  }
}
