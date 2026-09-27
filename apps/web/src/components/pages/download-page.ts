/**
 * /descargar in the browser: points the header button at the visitor's system and fills in
 * what only the GitHub API knows (version, date, file sizes, SHA-256 digests). Everything has
 * a static fallback in the HTML, so a failed request changes nothing.
 *
 * Strings arrive through data attributes (templates from copy.ts); this module does not import
 * copy.ts, so the page bundle stays small. All values from GitHub go in with textContent.
 */
import {
  assetFiles,
  assetKeys,
  detectPlatform,
  downloadUrl,
  fetchLatestRelease,
  type AssetKey,
  type LatestRelease,
  type ReleaseAsset,
} from '../../lib/downloads';

interface PrimaryOption {
  label: string;
  href: string;
}

const MIB = 1024 * 1024;
const megabytes = new Intl.NumberFormat('es-ES', {
  style: 'unit',
  unit: 'megabyte',
  maximumFractionDigits: 1,
});
const kilobytes = new Intl.NumberFormat('es-ES', {
  style: 'unit',
  unit: 'kilobyte',
  maximumFractionDigits: 0,
});
const longDate = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** «84,2 MB», «312 kB» (binary units, like GitHub shows them). */
export function formatSize(bytes: number): string {
  return bytes >= MIB
    ? megabytes.format(bytes / MIB)
    : kilobytes.format(Math.max(1, Math.round(bytes / 1024)));
}

/** «sha256:…» from the asset, when the API gives one (hex, 64 characters), else null. */
function digestOf(asset: ReleaseAsset): string | null {
  if (!('digest' in asset)) return null;
  const value: unknown = asset.digest;
  if (typeof value !== 'string') return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim());
  return match ? (match[1] as string).toLowerCase() : null;
}

function isOption(value: unknown): value is PrimaryOption {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PrimaryOption).label === 'string' &&
    typeof (value as PrimaryOption).href === 'string'
  );
}

/** The header button: the visitor's system, or the «for computers» note on phones. */
function setupPrimary(root: HTMLElement): void {
  const button = root.querySelector<HTMLAnchorElement>('[data-primary-button]');
  const note = root.querySelector<HTMLElement>('[data-mobile-note]');
  let options: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(root.dataset.options ?? '{}');
    if (typeof parsed === 'object' && parsed !== null) options = parsed as Record<string, unknown>;
  } catch {
    // Keep the static button.
  }

  const { os } = detectPlatform();
  const option = options[os];
  if (button && isOption(option)) {
    button.textContent = option.label;
    button.href = option.href;
    return;
  }
  if (os === 'other' && button && note) {
    button.hidden = true;
    note.hidden = false;
  }
}

function fillVersion(root: HTMLElement, release: LatestRelease): void {
  const version = root.querySelector<HTMLElement>('[data-release-version]');
  if (version) {
    version.textContent = (version.dataset.template ?? '{version}').replace(
      '{version}',
      release.version,
    );
  }
  const date = root.querySelector<HTMLElement>('[data-release-date]');
  if (date && release.publishedAt) {
    const when = new Date(release.publishedAt);
    const time = document.createElement('time');
    time.dateTime = release.publishedAt;
    time.textContent = longDate.format(when);
    const [before = '', after = ''] = (date.dataset.template ?? '{date}').split('{date}');
    date.replaceChildren(before, time, after);
    date.hidden = false;
  }
}

function findAsset(release: LatestRelease, key: AssetKey): ReleaseAsset | undefined {
  return release.assets.find((asset) => asset.name === assetFiles[key]);
}

function fillSizes(release: LatestRelease): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-asset-size]')) {
    const key = el.dataset.assetSize as AssetKey;
    if (!(key in assetFiles)) continue;
    const asset = findAsset(release, key);
    const value = el.querySelector('[data-asset-size-value]');
    if (asset && value) {
      value.textContent = formatSize(asset.size);
      delete el.dataset.empty;
    }
  }
}

/** The table of published files: name, size and, when GitHub has it, the SHA-256. */
function fillSums(release: LatestRelease): void {
  const wrapper = document.querySelector<HTMLElement>('[data-sums]');
  const body = wrapper?.querySelector('tbody');
  if (!wrapper || !body) return;

  const rows = assetKeys.flatMap((key) => {
    const asset = findAsset(release, key);
    return asset ? [{ key, asset, digest: digestOf(asset) }] : [];
  });
  if (rows.length === 0) return;
  const withDigests = rows.some((row) => row.digest !== null);
  const hashLabel = wrapper.dataset.hashLabel ?? '';
  const sizeLabel = wrapper.dataset.sizeLabel ?? '';
  const unavailable = wrapper.dataset.unavailable ?? '';

  body.replaceChildren(
    ...rows.map(({ key, asset, digest }) => {
      const tr = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      const link = document.createElement('a');
      link.className = 'link';
      link.href = downloadUrl(key);
      link.textContent = asset.name;
      name.append(link);

      const size = document.createElement('td');
      size.dataset.label = sizeLabel;
      size.textContent = formatSize(asset.size);
      tr.append(name, size);

      if (withDigests) {
        const hash = document.createElement('td');
        hash.className = 'sums-hash';
        hash.dataset.label = hashLabel;
        hash.textContent = digest ?? unavailable;
        tr.append(hash);
      }
      return tr;
    }),
  );
  wrapper.toggleAttribute('data-with-digests', withDigests);
  wrapper.hidden = false;
}

export function initDownloadPage(): void {
  const primary = document.querySelector<HTMLElement>('[data-primary-download]');
  if (primary) setupPrimary(primary);

  void fetchLatestRelease().then((release) => {
    if (!release) return;
    if (primary) fillVersion(primary, release);
    fillSizes(release);
    fillSums(release);
  });
}
