#!/usr/bin/env node
// Checks the web's media folder against the budgets of PROMPT.md §11 («Presupuestos»), however
// it got there: a partial run (`--only`) keeps older manifest entries without encoding them
// again, and a file can be edited or left behind by hand. encode.mjs only checks what it encodes.
//
//   node scripts/marketing/check-budgets.mjs [--media <dir>] [--summary <file>]
//
// 1. Manifest: every file under the media folder (but manifest.json) is listed in
//    manifest.json, every listed file exists with the manifest's `bytes`, and every entry is
//    still in media.json (a video or still state dropped from it is a stale entry).
// 2. Files, with the budgets of media.json (never the manifest's): the hero video ≤ heroAv1 in
//    AV1 and ≤ heroOther in VP9 and H.264, every codec of a loop ≤ loop, and every AVIF or WebP
//    image (stills, posters, reduced-motion stills) ≤ image. A video is AV1 when its bytes say
//    so (like apps/web/tests/quality.spec.ts), whatever the manifest calls it.
// 3. First view, per language: the hero's poster plus its AV1 source (or, with reduced motion,
//    its still if heavier), plus the stills of media.json `firstViewStills` (the heavier of
//    AVIF and WebP), ≤ firstView. MB and KB are decimal, the stricter reading (DECISIONS.md).
//
// Prints a report; with --summary (the workflow passes $GITHUB_STEP_SUMMARY) it also appends it
// as Markdown. Exits 1 when a check fails. build-media.mjs runs it after encoding.

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONFIG = JSON.parse(readFileSync(join(HERE, 'media.json'), 'utf8'));
const DEFAULT_MEDIA = join(REPO_ROOT, 'apps', 'web', 'public', 'media');
const MANIFEST = 'manifest.json';
const IMAGE_EXTENSIONS = new Set(['.avif', '.webp']);
const THEMES = ['light', 'dark'];

const toPosix = (p) => p.split(sep).join('/');
const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
const extensionOf = (file) => file.slice(file.lastIndexOf('.')).toLowerCase();

/** Every file under `dir`, as POSIX paths relative to it. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => toPosix(relative(dir, join(d.parentPath, d.name))))
    .sort();
}

/** AV1 in MP4 (`av01` sample entry and `av1C` box) or WebM (`V_AV1` codec id). */
function isAv1(bytes) {
  return bytes.includes('V_AV1') || (bytes.includes('av01') && bytes.includes('av1C'));
}

/**
 * Checks `media` (default apps/web/public/media). Returns `{ ok, failures, lines }`: `lines`
 * is the Markdown report.
 */
export function checkBudgets({ media = DEFAULT_MEDIA } = {}) {
  const budgets = CONFIG.budgets;
  const failures = [];
  const fail = (message) => failures.push(message);
  const inRepo = relative(REPO_ROOT, media);
  const mediaName = inRepo.startsWith('..') ? toPosix(media) : toPosix(inRepo) || '.';
  const lines = [`### Media budgets (PROMPT.md §11)\n`, `Folder: \`${mediaName}\`\n`];
  const result = () => {
    lines.push('');
    if (failures.length === 0)
      lines.push('All within budget, and the manifest matches the folder.');
    else lines.push(`**${failures.length} problems:**\n`, ...failures.map((f) => `- ${f}`));
    return { ok: failures.length === 0, failures, lines };
  };

  if (!existsSync(media)) {
    lines.push('No media folder: nothing to check.');
    return { ok: true, failures, lines };
  }
  const onDisk = listFiles(media).filter((f) => f !== MANIFEST);
  const manifestFile = join(media, MANIFEST);
  if (!existsSync(manifestFile)) {
    for (const file of onDisk) fail(`${file}: not listed (there is no ${MANIFEST})`);
    lines.push(`No ${MANIFEST}: ${onDisk.length} unlisted files.`);
    return result();
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const videos = Array.isArray(manifest.videos) ? manifest.videos : [];
  const stills = Array.isArray(manifest.stills) ? manifest.stills : [];

  // URL (`/media/…`) of a manifest reference → path relative to the media folder.
  const base = `/${toPosix(media).split('/').pop()}/`;
  const listed = new Set();
  /** Registers a reference; returns its size on disk (`null` when it is missing). */
  const ref = (entryLabel, item, what) => {
    if (!item || typeof item.src !== 'string' || !item.src.startsWith(base)) {
      fail(`${entryLabel}: ${what} has no ${base}… src`);
      return null;
    }
    const file = item.src.slice(base.length);
    if (file.split('/').includes('..')) {
      fail(`${entryLabel}: ${what} points outside the media folder (${item.src})`);
      return null;
    }
    listed.add(file);
    const path = join(media, file);
    if (!existsSync(path)) {
      fail(`${file}: listed (${entryLabel} ${what}) but missing`);
      return null;
    }
    const bytes = statSync(path).size;
    if (bytes !== item.bytes) {
      fail(`${file}: ${bytes} bytes on disk, the manifest says ${item.bytes} (stale or edited)`);
    }
    if (IMAGE_EXTENSIONS.has(extensionOf(file)) && bytes > budgets.image) {
      fail(`${file}: ${kb(bytes)} > ${kb(budgets.image)} (images)`);
    }
    return bytes;
  };

  const specs = new Map(CONFIG.videos.map((v) => [v.id, v]));
  const stillStates = new Set(CONFIG.stills.map((s) => s.state));
  const langs = new Set();
  const perLang = new Map();
  const langTotals = (lang) => {
    if (!perLang.has(lang)) perLang.set(lang, { hero: null, stills: new Map() });
    return perLang.get(lang);
  };
  let largestImage = 0;
  let largestLoop = 0;
  const heroes = [];

  for (const video of videos) {
    const label = `${video.lang}/${video.id}`;
    langs.add(video.lang);
    const spec = specs.get(video.id);
    if (!spec) fail(`${label}: not in media.json (stale entry)`);
    const kind = spec?.kind ?? video.kind;
    /** Largest source per codec (`other`: not AV1 and not named VP9 or H.264). */
    const sizes = {};
    for (const source of video.sources ?? []) {
      const bytes = ref(label, source, `${source.codec ?? '?'} source`);
      if (bytes === null) continue;
      const file = source.src.slice(base.length);
      const av1 = isAv1(readFileSync(join(media, file)));
      if (source.codec === 'av1' && !av1) fail(`${file}: listed as AV1 but is not AV1`);
      const codec = av1 ? 'av1' : ['vp9', 'h264'].includes(source.codec) ? source.codec : 'other';
      const budget = kind === 'hero' ? (av1 ? budgets.heroAv1 : budgets.heroOther) : budgets.loop;
      if (bytes > budget) fail(`${file}: ${kb(bytes)} > ${kb(budget)} (${kind} ${codec})`);
      sizes[codec] = Math.max(sizes[codec] ?? 0, bytes);
      if (kind !== 'hero') largestLoop = Math.max(largestLoop, bytes);
    }
    const poster = ref(label, video.poster, 'poster');
    const stillAvif = ref(label, video.still?.avif, 'still (avif)');
    const stillWebp = ref(label, video.still?.webp, 'still (webp)');
    largestImage = Math.max(largestImage, poster ?? 0, stillAvif ?? 0, stillWebp ?? 0);
    if (kind === 'hero') {
      const hero = {
        lang: video.lang,
        sizes,
        poster,
        still: Math.max(stillAvif ?? 0, stillWebp ?? 0),
      };
      heroes.push(hero);
      if (langTotals(video.lang).hero) fail(`${label}: a second hero video for ${video.lang}`);
      langTotals(video.lang).hero = hero;
    }
  }

  for (const still of stills) {
    const label = `${still.lang}/stills/${still.state}-${still.theme}`;
    langs.add(still.lang);
    if (!stillStates.has(still.state) || !THEMES.includes(still.theme)) {
      fail(`${label}: not in media.json (stale entry)`);
    }
    const avif = ref(label, still.avif, 'avif');
    const webp = ref(label, still.webp, 'webp');
    largestImage = Math.max(largestImage, avif ?? 0, webp ?? 0);
    langTotals(still.lang).stills.set(
      `${still.state}-${still.theme}`,
      Math.max(avif ?? 0, webp ?? 0),
    );
  }

  for (const file of onDisk) {
    if (!listed.has(file)) fail(`${file}: on disk but not listed in ${MANIFEST}`);
  }

  // First view of each language.
  const firstViewStills = CONFIG.firstViewStills ?? [];
  const firstViews = [];
  for (const lang of [...langs].sort()) {
    const { hero, stills: langStills } = langTotals(lang);
    // The web lists AV1 first; without one, the heaviest source is what a browser may load.
    const video = hero ? (hero.sizes.av1 ?? Math.max(0, ...Object.values(hero.sizes))) : 0;
    const motion = hero ? (hero.poster ?? 0) + video : 0;
    const reduced = hero ? hero.still : 0;
    let aboveFold = 0;
    for (const key of firstViewStills) {
      const bytes = langStills.get(key);
      if (bytes === undefined) fail(`${lang}: first-view still ${key} is not in the manifest`);
      else aboveFold += bytes;
    }
    const total = Math.max(motion, reduced) + aboveFold;
    firstViews.push({ lang, motion, reduced, aboveFold, total });
    if (total > budgets.firstView) {
      fail(`${lang}: first view media ${kb(total)} > ${kb(budgets.firstView)}`);
    }
  }

  const totalBytes = [...listed.keys()]
    .filter((file) => existsSync(join(media, file)))
    .reduce((sum, file) => sum + statSync(join(media, file)).size, 0);

  lines.push(
    `Videos: ${videos.length}, stills: ${stills.length}; ${listed.size} files, ${kb(totalBytes)} in all.\n`,
  );
  lines.push('| Check | Size | Budget |', '| --- | --- | --- |');
  for (const hero of heroes) {
    const cell = (bytes) => (bytes === undefined ? '—' : kb(bytes));
    lines.push(`| ${hero.lang} hero AV1 | ${cell(hero.sizes.av1)} | ${kb(budgets.heroAv1)} |`);
    lines.push(
      `| ${hero.lang} hero VP9 / H.264 | ${cell(hero.sizes.vp9)} / ${cell(hero.sizes.h264)} | ${kb(budgets.heroOther)} |`,
    );
  }
  lines.push(`| Largest loop file | ${kb(largestLoop)} | ${kb(budgets.loop)} |`);
  lines.push(`| Largest image | ${kb(largestImage)} | ${kb(budgets.image)} |`);
  for (const view of firstViews) {
    const parts = [
      `poster + AV1 ${kb(view.motion)}`,
      `reduced-motion still ${kb(view.reduced)}`,
      `${firstViewStills.length} stills ${kb(view.aboveFold)}`,
    ];
    lines.push(
      `| ${view.lang} first view (${parts.join(', ')}) | ${kb(view.total)} | ${kb(budgets.firstView)} |`,
    );
  }
  return result();
}

function main() {
  const { values } = parseArgs({
    options: {
      media: { type: 'string' },
      summary: { type: 'string' },
    },
  });
  const result = checkBudgets({ media: resolve(values.media ?? DEFAULT_MEDIA) });
  const text = `${result.lines.join('\n')}\n`;
  console.log(text);
  if (values.summary) appendFileSync(values.summary, `${text}\n`);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
