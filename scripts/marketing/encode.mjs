#!/usr/bin/env node
// Encodes what the marketing specs captured (PROMPT.md §11 «Material visual») into the web's
// media folder, within the budgets of media.json:
//
//   <work>/<lang>/frames/<video>/timeline.json + PNGs   (hero.desktop.ts, …)
//   <work>/<lang>/stills/index.json + PNGs               (stills.desktop.ts)
//     → apps/web/public/media/[en/]<video>-av1.mp4       AV1 (SVT-AV1), bt709, 4:2:0
//       apps/web/public/media/[en/]<video>-vp9.webm      VP9
//       apps/web/public/media/[en/]<video>-h264.mp4      H.264 High, bt709, 4:2:0
//       apps/web/public/media/[en/]<video>-poster.webp   first frame (poster attribute)
//       apps/web/public/media/[en/]<video>-still.{avif,webp}  the `stillAt` frame (reduced motion)
//       apps/web/public/media/[en/]stills/<state>-<theme>.{avif,webp}
//       apps/web/public/media/manifest.json              sizes, types, codecs, alt texts
//     → <work>/masters/[en/]<video>.mkv                  lossless master (FFV1, RGB)
//
// Frames: every PNG is padded to the video's canvas (the largest frame) with the web surface
// the video sits on (media.json `backdrop` → apps/web/src/styles/tokens.css), anchored at the
// bottom for desktop windows (Windows grows the window upwards) and centered otherwise; then a
// numbered sequence of hard links plays each PNG for its run of frames. The master and the web
// encodings are all made from that sequence. Colour: RGB → Y'CbCr with the BT.709 matrix,
// limited range, tagged bt709 (AVIF stills: 4:4:4, full range, sRGB transfer).
//
// Budgets: each encoding starts at a quality CRF and steps it up until the file fits (hero:
// AV1 ≤ 0.4 MB, VP9 and H.264 ≤ 1.2 MB; loops ≤ 0.5 MB; images ≤ 120 KB); it fails if the
// last step is still over. A partial run (some jobs only) keeps the manifest entries of the
// others; entries whose video or still state left media.json are dropped, and files of
// replaced or dropped entries that are no longer produced are removed. check-budgets.mjs then
// checks the whole folder (build-media.mjs and the workflow run it).
//
//   node scripts/marketing/encode.mjs --work <dir> [--media <dir>] [--masters <dir>]
//
// Normally run by build-media.mjs. Needs ffmpeg and ffprobe with libsvtav1, libvpx-vp9,
// libx264, libaom-av1 and libwebp (Ubuntu 24.04: `apt-get install ffmpeg`).

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const CONFIG = JSON.parse(readFileSync(join(HERE, 'media.json'), 'utf8'));
export const DEFAULT_MEDIA = join(REPO_ROOT, 'apps', 'web', 'public', 'media');
const WEB_TOKENS = join(REPO_ROOT, 'apps', 'web', 'src', 'styles', 'tokens.css');
/** Web surface → the token that paints it (apps/web/src/styles/tokens.css). */
const BACKDROP_TOKENS = {
  light: '--palette-white',
  alt: '--palette-snow',
  dark: '--palette-black',
};

export const REQUIRED_ENCODERS = ['libsvtav1', 'libvpx-vp9', 'libx264', 'libaom-av1', 'libwebp'];

/** Video Y'CbCr: BT.709 matrix, limited range, 4:2:0 (what every browser decodes). */
const TO_YUV420 =
  'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p';
const VIDEO_TAGS = [
  ...['-colorspace', 'bt709', '-color_primaries', 'bt709'],
  ...['-color_trc', 'bt709', '-color_range', 'tv'],
];
/** Still AVIF: 4:4:4 keeps coloured UI text sharp; full range, sRGB transfer. */
const TO_YUV444 =
  'scale=out_color_matrix=bt709:out_range=pc:flags=accurate_rnd+full_chroma_int,format=yuv444p';
const IMAGE_TAGS = [
  ...['-colorspace', 'bt709', '-color_primaries', 'bt709'],
  ...['-color_trc', 'iec61966-2-1', '-color_range', 'pc'],
];

/**
 * The web encodings, in the order the web lists its <source>s (the browser takes the first
 * it plays). `crf`: [first, last, step]; a keyframe every 10 s (short clips: one).
 */
const VIDEO_CODECS = [
  {
    name: 'av1',
    suffix: '-av1.mp4',
    mime: 'video/mp4',
    crf: [32, 62, 3],
    args: (crf, gop) => [
      ...['-c:v', 'libsvtav1', '-preset', '4', '-crf', String(crf), '-g', String(gop)],
      ...['-svtav1-params', 'tune=0', '-movflags', '+faststart'],
    ],
  },
  {
    name: 'vp9',
    suffix: '-vp9.webm',
    mime: 'video/webm',
    crf: [34, 60, 3],
    args: (crf, gop) => [
      ...['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-g', String(gop)],
      ...['-deadline', 'good', '-cpu-used', '1', '-row-mt', '1'],
    ],
  },
  {
    name: 'h264',
    suffix: '-h264.mp4',
    mime: 'video/mp4',
    crf: [22, 40, 2],
    args: (crf, gop) => [
      ...['-c:v', 'libx264', '-preset', 'veryslow', '-tune', 'animation', '-crf', String(crf)],
      // Level 4.0 plays on every H.264 decoder of the last decade (x264 trims refs to fit).
      ...['-profile:v', 'high', '-level:v', '4.0', '-g', String(gop), '-movflags', '+faststart'],
    ],
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * ffmpeg with the output file last in `args`. Bit-exact muxing and encoding: no random
 * container ids, no version strings, so the same frames give the same bytes (a re-run that
 * changes nothing opens no pull request).
 */
function ffmpeg(args) {
  const out = args.at(-1);
  const exact = ['-fflags', '+bitexact', '-flags:v', '+bitexact'];
  return run('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    ...args.slice(0, -1),
    ...exact,
    out,
  ]);
}

/** Throws unless ffmpeg and ffprobe exist and have every encoder the pipeline uses. */
export function checkFfmpeg() {
  let encoders;
  try {
    encoders = run('ffmpeg', ['-hide_banner', '-encoders']);
    run('ffprobe', ['-version']);
  } catch (error) {
    throw new Error(`ffmpeg and ffprobe are required (apt-get install ffmpeg): ${error.message}`, {
      cause: error,
    });
  }
  const missing = REQUIRED_ENCODERS.filter((name) => !new RegExp(`\\s${name}\\s`).test(encoders));
  if (missing.length > 0) throw new Error(`ffmpeg lacks encoders: ${missing.join(', ')}`);
}

/** `#rrggbb` of a web token (the backdrop colours come from the site's own palette). */
function webToken(name) {
  const css = readFileSync(WEB_TOKENS, 'utf8');
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!match) throw new Error(`${name} (a #rrggbb value) not found in ${WEB_TOKENS}`);
  return match[1].toLowerCase();
}

const even = (n) => n + (n % 2);
const toPosix = (p) => p.split('\\').join('/');

/**
 * Where the media folder is and the URL the web serves it at (apps/web/public is the site
 * root, so apps/web/public/media is `/media`). Set by `encodeAll`.
 */
const target = { media: DEFAULT_MEDIA, urlBase: '/media' };

/** `/media/…`: the URL of a file of the media folder. */
function mediaUrl(file) {
  return `${target.urlBase}/${toPosix(relative(target.media, file))}`;
}

/** The file behind a `/media/…` URL. */
function mediaFile(src) {
  return join(target.media, src.slice(target.urlBase.length + 1));
}

function describe(file, extra = {}) {
  return { src: mediaUrl(file), bytes: statSync(file).size, ...extra };
}

/** Steps the CRF until `encode(crf)` writes a file ≤ `budget` bytes; returns the CRF. */
function underBudget(label, out, budget, [first, last, step], encode) {
  let bytes = 0;
  for (let crf = first; crf <= last; crf += step) {
    encode(crf);
    bytes = statSync(out).size;
    if (bytes <= budget) return crf;
  }
  throw new Error(
    `${label}: ${bytes} bytes at CRF ${last}, over the ${budget}-byte budget (PROMPT.md §11). ` +
      'Shorten the clip or lower its resolution.',
  );
}

/** WebP: lossless when it fits the budget (sharpest for UI), else lossy from quality 92 down. */
function webp(png, out, budget, label) {
  const input = ['-i', png, '-frames:v', '1', '-c:v', 'libwebp'];
  ffmpeg([...input, '-lossless', '1', '-compression_level', '6', out]);
  if (statSync(out).size <= budget) return { lossless: true };
  // underBudget raises its value; here that value is how far below 100 the quality goes.
  const drop = underBudget(label, out, budget, [8, 60, 4], (value) =>
    ffmpeg([...input, '-quality', String(100 - value), out]),
  );
  return { lossless: false, quality: 100 - drop };
}

/** AVIF still (libaom, 4:4:4) from CRF 22 up until it fits. */
function avif(png, out, budget, label) {
  const crf = underBudget(label, out, budget, [22, 54, 4], (value) =>
    ffmpeg([
      ...['-i', png, '-frames:v', '1', '-vf', TO_YUV444, '-c:v', 'libaom-av1'],
      ...['-still-picture', '1', '-cpu-used', '6', '-row-mt', '1', '-crf', String(value)],
      ...IMAGE_TAGS,
      out,
    ]),
  );
  return { crf };
}

/** RFC 6381 codecs parameter of an encoded file (what `<source type>` needs). */
function codecsOf(file, codec) {
  if (codec === 'vp9') return 'vp9';
  const probe = JSON.parse(
    run('ffprobe', [
      ...['-v', 'error', '-select_streams', 'v:0'],
      ...['-show_entries', 'stream=profile,level', '-of', 'json', file],
    ]),
  );
  const stream = probe.streams?.[0] ?? {};
  if (codec === 'h264') {
    const profile = { Baseline: '42', Main: '4d', High: '64' }[stream.profile] ?? '64';
    return `avc1.${profile}00${Number(stream.level ?? 40)
      .toString(16)
      .padStart(2, '0')}`;
  }
  const profile = { Main: 0, High: 1, Professional: 2 }[stream.profile] ?? 0;
  const level = Number(stream.level) >= 0 ? Number(stream.level) : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}M.08`;
}

/** Output folder of a language: the site's default (es) at the root, others in `<lang>/`. */
function langDir(base, lang) {
  return lang === 'es' ? base : join(base, lang);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Pads `png` to the canvas with `color`, or hard-links it when it is already that size. */
function padFrame(src, dest, size, canvas, anchor, color) {
  if (size.width === canvas.width && size.height === canvas.height) {
    linkOrCopy(src, dest);
    return;
  }
  const y = anchor === 'bottom' ? 'oh-ih' : '(oh-ih)/2';
  ffmpeg([
    ...['-i', src, '-frames:v', '1'],
    ...['-vf', `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:${y}:color=${color},format=rgb24`],
    dest,
  ]);
}

function linkOrCopy(src, dest) {
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

function encodeVideo({ spec, timeline, framesDir, tmp, mediaDir, mastersRoot }) {
  const mastersDir = langDir(mastersRoot, timeline.lang);
  const label = `${timeline.lang}/${spec.id}`;
  const sizes = Object.values(timeline.sizes);
  const canvas = {
    width: even(Math.max(...sizes.map((s) => s.width))),
    height: even(Math.max(...sizes.map((s) => s.height))),
  };
  const color = webToken(BACKDROP_TOKENS[timeline.backdrop]);
  const padded = join(tmp, 'padded');
  const seq = join(tmp, 'seq');
  mkdirSync(padded, { recursive: true });
  mkdirSync(seq, { recursive: true });
  for (const [file, size] of Object.entries(timeline.sizes)) {
    padFrame(join(framesDir, file), join(padded, file), size, canvas, timeline.anchor, color);
  }

  // The sequence, and the moments the web may sync to (labels, window height changes).
  let frame = 0;
  const marks = {};
  const heights = [];
  const frameMs = (n) => Math.round((n * 1_000) / timeline.fps);
  for (const runItem of timeline.runs) {
    if (runItem.label) marks[runItem.label] = frameMs(frame);
    const cssHeight = Math.round(timeline.sizes[runItem.file].height / timeline.scaleFactor);
    if (heights.at(-1)?.cssHeight !== cssHeight) heights.push({ atMs: frameMs(frame), cssHeight });
    for (let i = 0; i < runItem.count; i += 1) {
      frame += 1;
      linkOrCopy(join(padded, runItem.file), join(seq, `${String(frame).padStart(5, '0')}.png`));
    }
  }
  const input = ['-framerate', String(timeline.fps), '-i', join(seq, '%05d.png')];
  const durationMs = frameMs(frame);
  const gop = Math.min(frame, timeline.fps * 10);

  // Lossless master (kept out of the repository: the workflow uploads it as an artifact).
  mkdirSync(mastersDir, { recursive: true });
  const master = join(mastersDir, `${spec.id}.mkv`);
  ffmpeg([...input, '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gbrp', master]);

  mkdirSync(mediaDir, { recursive: true });
  const sources = [];
  for (const codec of VIDEO_CODECS) {
    const out = join(mediaDir, `${spec.id}${codec.suffix}`);
    const budget =
      spec.kind === 'hero'
        ? codec.name === 'av1'
          ? CONFIG.budgets.heroAv1
          : CONFIG.budgets.heroOther
        : CONFIG.budgets.loop;
    const crf = underBudget(`${label} ${codec.name}`, out, budget, codec.crf, (value) =>
      ffmpeg([...input, '-an', '-vf', TO_YUV420, ...codec.args(value, gop), ...VIDEO_TAGS, out]),
    );
    sources.push(
      describe(out, {
        type: `${codec.mime}; codecs="${codecsOf(out, codec.name)}"`,
        codec: codec.name,
        crf,
        budget,
      }),
    );
    console.log(`  ${relative(REPO_ROOT, out)}: ${statSync(out).size} B (CRF ${crf})`);
  }

  const image = CONFIG.budgets.image;
  const firstFrame = join(seq, '00001.png');
  const poster = join(mediaDir, `${spec.id}-poster.webp`);
  const posterInfo = webp(firstFrame, poster, image, `${label} poster`);
  const stillRun = timeline.runs.find((r) => r.label === spec.stillAt);
  if (!stillRun) throw new Error(`${label}: no frame labelled «${spec.stillAt}» (stillAt)`);
  const stillPng = join(padded, stillRun.file);
  const stillAvif = join(mediaDir, `${spec.id}-still.avif`);
  const stillWebp = join(mediaDir, `${spec.id}-still.webp`);
  avif(stillPng, stillAvif, image, `${label} still avif`);
  webp(stillPng, stillWebp, image, `${label} still webp`);

  return {
    id: spec.id,
    lang: timeline.lang,
    kind: spec.kind,
    theme: timeline.theme,
    alt: spec.alt[timeline.lang],
    width: canvas.width,
    height: canvas.height,
    cssWidth: canvas.width / timeline.scaleFactor,
    cssHeight: canvas.height / timeline.scaleFactor,
    fps: timeline.fps,
    frames: frame,
    durationMs,
    backdrop: timeline.backdrop,
    backdropColor: color,
    anchor: timeline.anchor,
    font: timeline.font,
    marks,
    windowHeights: heights,
    sources,
    poster: describe(poster, posterInfo),
    still: { avif: describe(stillAvif), webp: describe(stillWebp) },
    master: toPosix(relative(mastersRoot, master)),
  };
}

function encodeStills({ index, stillsDir, mediaDir }) {
  const out = join(mediaDir, 'stills');
  mkdirSync(out, { recursive: true });
  const budget = CONFIG.budgets.image;
  return index.entries.map((entry) => {
    const png = join(stillsDir, entry.file);
    const base = entry.file.replace(/\.png$/, '');
    const avifFile = join(out, `${base}.avif`);
    const webpFile = join(out, `${base}.webp`);
    const label = `${index.lang}/stills/${base}`;
    const avifInfo = avif(png, avifFile, budget, `${label}.avif`);
    const webpInfo = webp(png, webpFile, budget, `${label}.webp`);
    return {
      state: entry.state,
      theme: entry.theme,
      lang: index.lang,
      window: entry.window,
      alt: entry.alt,
      width: entry.width,
      height: entry.height,
      cssWidth: entry.width / index.scaleFactor,
      cssHeight: entry.height / index.scaleFactor,
      font: index.font,
      avif: describe(avifFile, avifInfo),
      webp: describe(webpFile, webpInfo),
    };
  });
}

/** Every file a manifest entry points to. */
function filesOf(entry) {
  const refs = [
    ...(entry.sources ?? []),
    entry.poster,
    entry.still?.avif,
    entry.still?.webp,
    entry.avif,
    entry.webp,
  ].filter(Boolean);
  return refs.map((ref) => mediaFile(ref.src));
}

const videoKey = (v) => `video|${v.lang}|${v.id}`;
const stillKey = (s) => `still|${s.lang}|${s.state}|${s.theme}`;

async function formatJson(file, value) {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(file)) ?? {};
  const text = await prettier.format(JSON.stringify(value), { ...options, filepath: file });
  writeFileSync(file, text);
}

/**
 * Encodes every capture in `work` into `media` and merges `media/manifest.json`. Returns the
 * manifest.
 */
export async function encodeAll({
  work,
  media = DEFAULT_MEDIA,
  masters = join(work, 'masters'),
  urlBase = `/${basename(media)}`,
}) {
  checkFfmpeg();
  target.media = media;
  target.urlBase = urlBase;
  const manifestFile = join(media, 'manifest.json');
  const previous = existsSync(manifestFile) ? readJson(manifestFile) : { videos: [], stills: [] };
  const videos = new Map((previous.videos ?? []).map((v) => [videoKey(v), v]));
  const stills = new Map((previous.stills ?? []).map((s) => [stillKey(s), s]));
  const replaced = [];
  // Entries of videos and still states media.json no longer has: nothing would replace them.
  const videoIds = new Set(CONFIG.videos.map((v) => v.id));
  const stillStates = new Set(CONFIG.stills.map((s) => s.state));
  for (const [map, current] of [
    [videos, (v) => videoIds.has(v.id)],
    [stills, (s) => stillStates.has(s.state)],
  ]) {
    for (const [key, entry] of map) {
      if (current(entry)) continue;
      console.log(`Dropping ${key.replaceAll('|', ' ')}: not in media.json any more`);
      replaced.push(entry);
      map.delete(key);
    }
  }
  const langs = readdirSync(work)
    .filter((d) => /^[a-z]{2}$/.test(d))
    .sort();
  if (langs.length === 0)
    throw new Error(`${work} holds no captures (<lang>/frames, <lang>/stills)`);

  for (const lang of langs) {
    const root = join(work, lang);
    const mediaDir = langDir(media, lang);
    const framesRoot = join(root, 'frames');
    for (const spec of CONFIG.videos) {
      const framesDir = join(framesRoot, spec.id);
      const timelineFile = join(framesDir, 'timeline.json');
      if (!existsSync(timelineFile)) continue;
      console.log(`${lang}/${spec.id}`);
      const tmp = join(work, 'tmp', lang, spec.id);
      rmSync(tmp, { recursive: true, force: true });
      const entry = encodeVideo({
        spec,
        timeline: readJson(timelineFile),
        framesDir,
        tmp,
        mediaDir,
        mastersRoot: masters,
      });
      rmSync(tmp, { recursive: true, force: true });
      const old = videos.get(videoKey(entry));
      if (old) replaced.push(old);
      videos.set(videoKey(entry), entry);
    }
    const indexFile = join(root, 'stills', 'index.json');
    if (existsSync(indexFile)) {
      console.log(`${lang}/stills`);
      const index = readJson(indexFile);
      // A stills run replaces the whole set of its language (states may have been dropped).
      for (const [key, entry] of stills) {
        if (entry.lang === lang) {
          replaced.push(entry);
          stills.delete(key);
        }
      }
      for (const entry of encodeStills({ index, stillsDir: join(root, 'stills'), mediaDir })) {
        stills.set(stillKey(entry), entry);
      }
    }
  }

  const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const manifest = {
    $comment:
      'Generated by scripts/marketing/build-media.mjs from the real app (PROMPT.md §11 «Material visual»); do not edit. Sizes in device pixels (cssWidth/cssHeight at the capture scale). Videos: list `sources` in order as <source src type>; the canvas is the largest window of the clip, smaller frames sit on `backdropColor` at `anchor`; `marks` and `windowHeights` are in ms from the start. `master`: the lossless FFV1 file in the workflow artifact «marketing-masters» (never committed).',
    scaleFactor: CONFIG.scaleFactor,
    budgets: CONFIG.budgets,
    videos: [...videos.values()].sort((a, b) => byKey(videoKey(a), videoKey(b))),
    stills: [...stills.values()].sort((a, b) => byKey(stillKey(a), stillKey(b))),
  };

  // Files of replaced entries that the new ones do not produce any more.
  const kept = new Set([...manifest.videos, ...manifest.stills].flatMap(filesOf));
  for (const file of replaced.flatMap(filesOf)) {
    if (!kept.has(file) && existsSync(file)) rmSync(file);
  }
  mkdirSync(media, { recursive: true });
  await formatJson(manifestFile, manifest);
  return manifest;
}

/** Every file of the manifest, relative to the repository (ASSET-LICENSES.json). */
export function manifestFiles(manifest) {
  const files = [...manifest.videos, ...manifest.stills].flatMap(filesOf);
  files.push(join(target.media, 'manifest.json'));
  return [...new Set(files.map((f) => toPosix(relative(REPO_ROOT, f))))].sort();
}

/** Licences of the families a capture can render in (apps/desktop/e2e/support/fonts.ts). */
const FONT_LICENSES = {
  'Noto Sans': 'OFL-1.1',
  Selawik: 'OFL-1.1',
  Ubuntu: 'Ubuntu Font Licence 1.0',
};

/** Upserts the generated-media entry of ASSET-LICENSES.json (other entries untouched). */
export async function recordLicenses(manifest, file = join(REPO_ROOT, 'ASSET-LICENSES.json')) {
  const files = manifestFiles(manifest);
  const manifestDir = `${toPosix(relative(REPO_ROOT, target.media))}/`;
  const licenses = readJson(file);
  const name = 'Céntrate marketing media (generated)';
  const fonts = [
    ...new Set([...manifest.videos, ...manifest.stills].map((e) => e.font).filter(Boolean)),
  ].sort();
  const entry = {
    name,
    kind: 'video and images',
    source:
      'generated from the real app by scripts/marketing (Electron harness with fixture data and a fake clock, and the extension blocked page); no third-party footage, no Apple or G-Helper material, service icons are neutral monograms',
    license: 'MIT',
    copyright: 'Copyright (c) 2026 Imdlodoem23 and Céntrate contributors',
    licenseText: 'LICENSE',
    typefaces: fonts.map(
      (family) =>
        `${family}${FONT_LICENSES[family] ? ` (${FONT_LICENSES[family]})` : ''}: font of the capture runner, only rendered into the pixels; no font file is shipped`,
    ),
    generator: 'scripts/marketing/build-media.mjs (.github/workflows/marketing-assets.yml)',
    files: [`${manifestDir} (${files.length} files, each listed with its size in manifest.json)`],
    usedBy: [
      'apps/web: the website serves apps/web/public/media/ (manifest.json lists every file)',
    ],
  };
  const assets = Array.isArray(licenses.assets) ? licenses.assets : [];
  const at = assets.findIndex((a) => a?.name === name);
  if (at >= 0) assets[at] = entry;
  else assets.push(entry);
  licenses.assets = assets;
  await formatJson(file, licenses);
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      media: { type: 'string' },
      masters: { type: 'string' },
      'no-licenses': { type: 'boolean', default: false },
    },
  });
  if (!values.work) throw new Error('--work <dir> is required (the folder the specs wrote to)');
  const work = resolve(values.work);
  const media = resolve(values.media ?? DEFAULT_MEDIA);
  const manifest = await encodeAll({
    work,
    media,
    masters: resolve(values.masters ?? join(work, 'masters')),
  });
  if (!values['no-licenses']) await recordLicenses(manifest);
  console.log(`${manifest.videos.length} videos, ${manifest.stills.length} stills in ${media}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
