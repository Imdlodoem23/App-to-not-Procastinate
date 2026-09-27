/**
 * Release history for /novedades, resolved once at BUILD time (server only: uses node:fs).
 *
 * 1. GitHub Releases (`site.api.releases`), with a 5 s timeout. An optional GITHUB_TOKEN in the
 *    build environment raises the API rate limit; it is only sent to api.github.com and never
 *    reaches the page.
 * 2. If that fails or there is no published release yet, the repository's CHANGELOG.md (Keep a
 *    Changelog: `## [1.2.0] - 2026-10-01`), read from disk.
 *
 * Every text from either source is untrusted: notes go through markdown-lite (no HTML) and
 * URLs through safeHref().
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { site } from '../../lib/site';
import { parseMarkdown, safeHref, type MdBlock } from './markdown-lite';

export interface ReleaseEntry {
  /** Fragment id on the page («v1.2.0», «sin-publicar»). */
  readonly anchor: string;
  /** «1.2.0», or null for the unreleased section of the changelog. */
  readonly version: string | null;
  /** Release title when it says more than the version («Céntrate 1.2: modo examen»). */
  readonly name: string | null;
  /** The changelog's own heading for an entry without a version («Sin publicar»). */
  readonly label: string | null;
  /** ISO date or date-time, or null. */
  readonly date: string | null;
  /** Release page on github.com, or null. */
  readonly url: string | null;
  /** The release GitHub serves as «latest». */
  readonly latest: boolean;
  readonly prerelease: boolean;
  readonly notes: MdBlock[];
}

export interface ReleaseHistory {
  /** Where the entries come from; 'none' = neither source could be read. */
  readonly source: 'github' | 'changelog' | 'none';
  /** Published versions, newest first. */
  readonly releases: ReleaseEntry[];
  /** Changes not released yet (CHANGELOG «[Sin publicar]»), shown only when there is no release. */
  readonly unreleased: ReleaseEntry | null;
}

const TIMEOUT_MS = 5000;
const VERSION = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isoDate(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function slug(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'version'
  );
}

/** The release title, unless it only repeats the product and the version («Céntrate v1.2.0»). */
function customName(name: unknown, version: string): string | null {
  if (typeof name !== 'string') return null;
  const title = name.trim();
  if (title === '') return null;
  const escaped = version.replace(/[.+]/g, '\\$&');
  const trivial = new RegExp(`^(?:c[eé]ntrate\\s*)?v?${escaped}$`, 'iu');
  return trivial.test(title) ? null : title.slice(0, 120);
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

/** Validates the GitHub payload (untrusted) into entries, newest first. */
export function parseGitHubReleases(data: unknown): ReleaseEntry[] {
  if (!Array.isArray(data)) return [];
  const entries = data.flatMap((item): ReleaseEntry[] => {
    if (!isRecord(item) || item.draft === true || typeof item.tag_name !== 'string') return [];
    const match = VERSION.exec(item.tag_name.trim());
    if (!match) return [];
    const version = match[1] as string;
    const url =
      typeof item.html_url === 'string' && item.html_url.startsWith('https://github.com/')
        ? safeHref(item.html_url)
        : null;
    return [
      {
        anchor: `v${slug(version)}`,
        version,
        name: customName(item.name, version),
        label: null,
        date: isoDate(item.published_at) ?? isoDate(item.created_at),
        url,
        latest: false,
        prerelease: item.prerelease === true,
        notes: parseMarkdown(typeof item.body === 'string' ? item.body.slice(0, 50_000) : ''),
      },
    ];
  });
  entries.sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? '') || 0);
  // «Latest» on GitHub is the newest release that is not a pre-release.
  const latest = entries.findIndex((entry) => !entry.prerelease);
  return entries.map((entry, index) => (index === latest ? { ...entry, latest: true } : entry));
}

async function fetchGitHubReleases(): Promise<ReleaseEntry[] | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'centrate-web-build',
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(`${site.api.releases}?per_page=30`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[novedades] GitHub Releases answered ${response.status}.`);
      return null;
    }
    return parseGitHubReleases(await response.json());
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[novedades] GitHub Releases could not be read (${reason}).`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG.md
// ---------------------------------------------------------------------------------------------

const ENTRY_HEADING = /^##(?!#)\s+(.+?)\s*$/;
// «[1.2.0] - 2026-10-01», «[1.2.0](url) – 2026-10-01», «1.2.0 - 2026-10-01», «[Sin publicar]».
const ENTRY_TITLE =
  /^(?:\[([^\]]+)\](?:\([^)]*\))?|(\S+))(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?(?:\s.*)?$/;

/** Splits a Keep a Changelog file into its entries. The text before the first `##` is dropped. */
export function parseChangelog(markdown: string): {
  releases: ReleaseEntry[];
  unreleased: ReleaseEntry | null;
} {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const releases: ReleaseEntry[] = [];
  let unreleased: ReleaseEntry | null = null;

  let i = lines.findIndex((line) => ENTRY_HEADING.test(line));
  while (i >= 0 && i < lines.length) {
    const heading = (ENTRY_HEADING.exec(lines[i] as string) as RegExpExecArray)[1] as string;
    const body: string[] = [];
    i += 1;
    // An entry ends at the next `##` or `#` heading (not inside a fenced code block).
    let fenced = false;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
      if (!fenced && (ENTRY_HEADING.test(line) || /^#\s/.test(line))) break;
      body.push(line);
      i += 1;
    }
    if (i < lines.length && /^#\s/.test(lines[i] as string)) i = -1;

    const title = ENTRY_TITLE.exec(heading);
    const raw = (title?.[1] ?? title?.[2] ?? heading).trim();
    const match = VERSION.exec(raw);
    const notes = parseMarkdown(body.join('\n'));
    const date = isoDate(title?.[3]);

    if (match) {
      const version = match[1] as string;
      releases.push({
        anchor: `v${slug(version)}`,
        version,
        name: null,
        label: null,
        date,
        url: null,
        latest: false,
        prerelease: version.includes('-'),
        notes,
      });
    } else if (!unreleased && notes.length > 0) {
      unreleased = {
        anchor: slug(raw),
        version: null,
        name: null,
        label: raw,
        date,
        url: null,
        latest: false,
        prerelease: false,
        notes,
      };
    }
  }

  const latest = releases.findIndex((entry) => !entry.prerelease);
  return {
    releases: releases.map((entry, index) =>
      index === latest ? { ...entry, latest: true } : entry,
    ),
    unreleased,
  };
}

/** CHANGELOG.md at the repository root: `../../CHANGELOG.md` from apps/web (the build's cwd). */
async function readChangelog(): Promise<string | null> {
  const candidates = [
    resolve(process.cwd(), '../../CHANGELOG.md'),
    // `astro build --root apps/web` run from the repository root.
    resolve(process.cwd(), 'CHANGELOG.md'),
  ];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      // Try the next location.
    }
  }
  console.warn('[novedades] CHANGELOG.md not found.');
  return null;
}

// ---------------------------------------------------------------------------------------------

let history: Promise<ReleaseHistory> | undefined;

/** The history shown on /novedades. Never rejects; resolved once per build. */
export function loadReleaseHistory(): Promise<ReleaseHistory> {
  history ??= (async (): Promise<ReleaseHistory> => {
    const fromGitHub = await fetchGitHubReleases();
    if (fromGitHub && fromGitHub.length > 0) {
      return { source: 'github', releases: fromGitHub, unreleased: null };
    }

    const markdown = await readChangelog();
    if (markdown === null) {
      // GitHub answered and there is simply no release yet: that is «empty», not an error.
      return { source: fromGitHub ? 'github' : 'none', releases: [], unreleased: null };
    }
    const { releases, unreleased } = parseChangelog(markdown);
    console.info(`[novedades] No release on GitHub to show: using CHANGELOG.md.`);
    return {
      source: 'changelog',
      releases,
      unreleased: releases.length === 0 ? unreleased : null,
    };
  })();
  return history;
}
