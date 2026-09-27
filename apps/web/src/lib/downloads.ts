/**
 * Downloads: fixed, version-less links to the latest GitHub release, operating system
 * detection for the download buttons, and the current version from the GitHub API.
 *
 * Works on the server (Astro frontmatter: links and file names for the static HTML) and in the
 * browser (vanilla <script>s). Nothing here touches `navigator`, `window` or storage at import
 * time, and it does not import copy.ts: pass strings to scripts through data attributes.
 *
 * Typical use in a component:
 *
 *   ---
 *   import { downloadUrl } from '../lib/downloads';
 *   ---
 *   <a href={downloadUrl('windows')} data-download>…</a>
 *   <span data-latest-version={copy.ui.version}>{copy.ui.versionFallback}</span>
 *   <script>
 *     import { detectPlatform, hydrateLatestVersion } from '../lib/downloads';
 *     const { os, arm } = detectPlatform(); // 'windows' | 'mac' | 'linux' | 'other'
 *     void hydrateLatestVersion();
 *   </script>
 */
import { repo, site } from './site';

/** The five files every release publishes, with names that never change. */
export const assetFiles = {
  windows: 'Centrate-Setup.exe',
  mac: 'Centrate.dmg',
  deb: 'Centrate.deb',
  appImage: 'Centrate.AppImage',
  extension: 'Centrate-extension.zip',
} as const;

export type AssetKey = keyof typeof assetFiles;

export const assetKeys = Object.keys(assetFiles) as AssetKey[];

/** Link that always downloads the file from the latest published release. */
export function downloadUrl(key: AssetKey): string {
  return `${site.latestDownloadBase}${assetFiles[key]}`;
}

/** Every download link, by asset. */
export const downloadUrls: Readonly<Record<AssetKey, string>> = Object.fromEntries(
  assetKeys.map((key) => [key, downloadUrl(key)]),
) as Record<AssetKey, string>;

// ---------------------------------------------------------------------------------------------
// Operating system
// ---------------------------------------------------------------------------------------------

/** Desktop systems Céntrate ships for, plus everything else (phones, tablets, ChromeOS…). */
export type OS = 'windows' | 'mac' | 'linux' | 'other';

export interface Platform {
  os: OS;
  /**
   * CPU hint: true = ARM (on macOS, Apple Silicon), false = x86 (Intel/AMD), null = unknown.
   * Browsers hide it on purpose: macOS Safari and Firefox always say «Intel», so on a Mac this
   * is only known in Chromium browsers, and only after `detectPlatformDetailed()`. The .dmg is
   * universal, so nothing depends on it; use it only to phrase a hint.
   */
  arm: boolean | null;
  /** Phone or tablet (always `os: 'other'`): offer /descargar instead of a file. */
  mobile: boolean;
}

/** What the static HTML assumes before any script runs (Windows is the priority, brief § 1). */
export const DEFAULT_OS: OS = 'windows';

/** The file a single «Descargar» button offers for each system; null = link to /descargar. */
export const primaryAsset: Readonly<Record<OS, AssetKey | null>> = {
  windows: 'windows',
  mac: 'mac',
  linux: 'deb',
  other: null,
};

/** User-Agent Client Hints (Chromium only; not in TypeScript's DOM lib yet). */
interface UADataValues {
  architecture?: string;
  bitness?: string;
  platform?: string;
}
interface NavigatorUAData {
  readonly mobile: boolean;
  readonly platform: string;
  getHighEntropyValues(hints: string[]): Promise<UADataValues>;
}
type NavigatorLike = Pick<Navigator, 'userAgent'> &
  Partial<Pick<Navigator, 'platform' | 'maxTouchPoints'>> & {
    userAgentData?: NavigatorUAData;
  };

/** The browser's navigator; undefined on the server (Node also has a `navigator`, saying Linux). */
function currentNavigator(): NavigatorLike | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  return navigator as NavigatorLike;
}

/**
 * Best guess of the visitor's system, synchronously, from the User-Agent (and its client hints
 * where the browser has them). Call it in the browser; on the server it returns `DEFAULT_OS`.
 */
export function detectPlatform(nav: NavigatorLike | undefined = currentNavigator()): Platform {
  if (!nav) return { os: DEFAULT_OS, arm: null, mobile: false };

  const ua = nav.userAgent ?? '';
  const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''}`;
  const touchMac = /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1; // iPadOS «desktop» mode
  const mobile =
    nav.userAgentData?.mobile === true ||
    touchMac ||
    /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua);

  if (mobile) return { os: 'other', arm: null, mobile: true };

  // Order matters: Android and ChromeOS also say «Linux».
  let os: OS = 'other';
  if (/CrOS|Chrome OS|ChromeOS|Android/i.test(`${ua} ${hint}`)) os = 'other';
  else if (/Win/i.test(hint) || /Windows NT|Win64|WOW64/i.test(ua)) os = 'windows';
  else if (/Mac/i.test(hint) || /Macintosh|Mac OS X/i.test(ua)) os = 'mac';
  else if (/Linux|X11|Ubuntu|Debian|Fedora/i.test(`${ua} ${hint}`)) os = 'linux';

  // Only Linux (and Windows on ARM in some browsers) put the CPU in the User-Agent.
  let arm: boolean | null = null;
  if (/aarch64|arm64|armv\d/i.test(ua)) arm = true;
  else if (os !== 'mac' && /x86_64|x64|amd64|Win64|WOW64|i686/i.test(ua)) arm = false;

  return { os, arm, mobile: false };
}

/**
 * Same as `detectPlatform()`, refined with high-entropy client hints where available (Chromium):
 * that is the only way to tell Apple Silicon from Intel in a browser. Never rejects.
 */
export async function detectPlatformDetailed(
  nav: NavigatorLike | undefined = currentNavigator(),
): Promise<Platform> {
  const base = detectPlatform(nav);
  const uaData = nav?.userAgentData;
  if (!uaData || base.mobile || typeof uaData.getHighEntropyValues !== 'function') return base;
  try {
    const values = await uaData.getHighEntropyValues(['architecture', 'bitness']);
    const architecture = values.architecture?.toLowerCase();
    if (architecture === 'arm') return { ...base, arm: true };
    if (architecture === 'x86') return { ...base, arm: false };
  } catch {
    // Hints refused or unsupported: keep the User-Agent guess.
  }
  return base;
}

// ---------------------------------------------------------------------------------------------
// Latest release (GitHub API)
// ---------------------------------------------------------------------------------------------

export interface ReleaseAsset {
  name: string;
  /** Bytes. */
  size: number;
  /** Direct download URL on github.com. */
  url: string;
}

export interface LatestRelease {
  /** «1.2.0» (the tag without its leading «v»). */
  version: string;
  tag: string;
  /** ISO 8601, or null for a release without a publication date. */
  publishedAt: string | null;
  /** Release page on github.com. */
  htmlUrl: string;
  /** Release notes in Markdown, as published (untrusted: never inject as HTML). */
  body: string;
  assets: ReleaseAsset[];
}

export interface FetchReleaseOptions {
  /** Gives up after this long and resolves with null. Default: 5000 ms. */
  timeoutMs?: number;
}

export const LATEST_RELEASE_API = site.api.latestRelease;

const CACHE_KEY = `centrate:latest-release:${repo.owner}/${repo.name}`;
const CACHE_TTL_MS = 15 * 60 * 1000;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

let pending: Promise<LatestRelease | null> | undefined;

/**
 * The latest published release, or null if GitHub cannot be reached in time, the repository has
 * no release yet, or the rate limit is spent. Never rejects. One request per page: concurrent
 * callers share it, and the answer is kept in sessionStorage for 15 minutes.
 */
export function fetchLatestRelease(
  options: FetchReleaseOptions = {},
): Promise<LatestRelease | null> {
  pending ??= loadLatestRelease(options.timeoutMs ?? 5000);
  return pending;
}

/** Just the version number («1.2.0»), or null. Never rejects. */
export async function fetchLatestVersion(options?: FetchReleaseOptions): Promise<string | null> {
  return (await fetchLatestRelease(options))?.version ?? null;
}

/**
 * Fills every `[data-latest-version]` element under `root` once the version is known. The
 * attribute holds the template (`copy.ui.version`, «Versión {version}»); the element's own
 * content is the fallback (`copy.ui.versionFallback`) and stays if the request fails. Reserve
 * the width in CSS so the swap does not move the layout.
 */
export async function hydrateLatestVersion(root: ParentNode = document): Promise<string | null> {
  const targets = root.querySelectorAll<HTMLElement>('[data-latest-version]');
  if (targets.length === 0) return null;
  const version = await fetchLatestVersion();
  if (version) {
    for (const el of targets) {
      const template = el.dataset.latestVersion || '{version}';
      el.textContent = template.replace('{version}', version);
      el.dataset.versionLoaded = '';
    }
  }
  return version;
}

async function loadLatestRelease(timeoutMs: number): Promise<LatestRelease | null> {
  if (typeof fetch !== 'function') return null;
  const cached = readCache();
  if (cached) return cached;

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Without AbortController support the race still ends on time.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller?.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
      deadline,
    ]);
    if (!response?.ok) return null;
    const release = parseRelease(await response.json());
    if (release) writeCache(release);
    return release;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validates the GitHub payload (untrusted input) and keeps only what the site uses. */
export function parseRelease(data: unknown): LatestRelease | null {
  if (!isRecord(data) || data.draft === true || typeof data.tag_name !== 'string') return null;
  const version = data.tag_name.trim().replace(/^v(?=\d)/i, '');
  if (!VERSION_RE.test(version)) return null;

  const htmlUrl =
    typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/')
      ? data.html_url
      : site.latestReleaseUrl;
  const publishedAt =
    typeof data.published_at === 'string' && !Number.isNaN(Date.parse(data.published_at))
      ? data.published_at
      : null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(data.assets)) {
    for (const asset of data.assets) {
      if (
        isRecord(asset) &&
        typeof asset.name === 'string' &&
        typeof asset.size === 'number' &&
        typeof asset.browser_download_url === 'string' &&
        asset.browser_download_url.startsWith('https://github.com/')
      ) {
        assets.push({ name: asset.name, size: asset.size, url: asset.browser_download_url });
      }
    }
  }
  return {
    version,
    tag: data.tag_name,
    publishedAt,
    htmlUrl,
    body: typeof data.body === 'string' ? data.body : '',
    assets,
  };
}

// The cache stores the GitHub field names, so what comes back goes through parseRelease() again.
function readCache(): LatestRelease | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry: unknown = JSON.parse(raw);
    if (!isRecord(entry) || typeof entry.at !== 'number' || Date.now() - entry.at > CACHE_TTL_MS) {
      return null;
    }
    return parseRelease(entry.release);
  } catch {
    return null;
  }
}

function writeCache(release: LatestRelease): void {
  const stored = {
    tag_name: release.tag,
    html_url: release.htmlUrl,
    published_at: release.publishedAt,
    body: release.body,
    assets: release.assets.map((a) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.url,
    })),
  };
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release: stored }));
  } catch {
    // Storage blocked or full: the next page asks GitHub again.
  }
}
