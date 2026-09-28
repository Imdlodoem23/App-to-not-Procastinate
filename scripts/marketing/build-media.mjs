#!/usr/bin/env node
// Regenerates the web's media from the real app (PROMPT.md §11 «Material visual»): stills of
// the curated harness states in both themes and frame-by-frame videos of the key flows,
// encoded to AV1, VP9 and H.264 with WebP posters, within the budgets of media.json.
//
//   node scripts/marketing/build-media.mjs [--langs es,en] [--only hero,stills]
//        [--work <dir>] [--media <dir>] [--skip-capture] [--skip-encode] [--any-font]
//        [--no-licenses]
//
// 1. Capture (Playwright, scripts/marketing/playwright.config.ts), once per language:
//    - stills.desktop.ts, hero.desktop.ts, extend-undo.desktop.ts: the built Electron app in
//      harness mode (CENTRATE_HARNESS, fake guardian, frozen clock) at
//      --force-device-scale-factor=2; services show catalog monograms, never favicons.
//    - blocked-page.extension.ts: apps/extension/dist/blocked.html in Chromium with a stubbed
//      extension API and Playwright's fake clock.
//    Output: <work>/<lang>/{stills,frames/<video>}. On Linux without a display the script
//    re-runs itself under `xvfb-run -s "-screen 0 5120x2880x24"` (room for 2x windows).
// 2. Encode (encode.mjs): apps/web/public/media/ (English in media/en/), manifest.json, and
//    the lossless masters in <work>/masters (the workflow uploads them; never committed).
// 3. ASSET-LICENSES.json: the generated-media entry is upserted (others are kept as they are).
//
// Needs: `npm run build -w apps/desktop` and `npm run build -w apps/extension` first; ffmpeg
// with libsvtav1, libvpx-vp9, libx264, libaom-av1 and libwebp; a font of the brief's stack
// (Linux: fonts-noto-core or fonts-ubuntu; `--any-font` downgrades the check to a warning).
// Chromium: Playwright's (`npx playwright install chromium`) or PW_CHROMIUM_PATH.
//
// --only takes `stills` and the video ids of media.json; a partial run keeps the other entries
// of manifest.json. --langs defaults to `es` (the parser reads Spanish phrases, and the English
// UI is captured with `--langs es,en`).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CONFIG,
  DEFAULT_MEDIA,
  REPO_ROOT,
  checkFfmpeg,
  encodeAll,
  recordLicenses,
} from './encode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const XVFB_SCREEN = '-screen 0 5120x2880x24';
const LANGS = ['es', 'en'];
const DESKTOP_JOBS = ['stills', 'hero', 'extend-undo'];
const EXTENSION_JOBS = ['blocked-page'];
const JOBS = ['stills', ...CONFIG.videos.map((v) => v.id)];

function options() {
  const { values } = parseArgs({
    options: {
      langs: { type: 'string', default: 'es' },
      only: { type: 'string', default: '' },
      work: { type: 'string', default: join(tmpdir(), 'centrate-marketing') },
      media: { type: 'string', default: DEFAULT_MEDIA },
      'skip-capture': { type: 'boolean', default: false },
      'skip-encode': { type: 'boolean', default: false },
      'any-font': { type: 'boolean', default: false },
      'no-licenses': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(
      readHeader()
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    process.exit(0);
  }
  const list = (text) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const langs = list(values.langs);
  const only = list(values.only);
  const badLang = langs.filter((l) => !LANGS.includes(l));
  const badJob = only.filter((j) => !JOBS.includes(j));
  if (langs.length === 0 || badLang.length) throw new Error(`--langs: use ${LANGS.join(', ')}`);
  if (badJob.length) throw new Error(`--only: unknown ${badJob.join(', ')} (${JOBS.join(', ')})`);
  return {
    ...values,
    langs,
    only,
    work: resolve(values.work),
    media: resolve(values.media),
  };
}

/** The comment block at the top of this file, without the shebang. */
function readHeader() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n\n')[0]
    .split('\n')
    .slice(1);
}

const wanted = (only, job) => only.length === 0 || only.includes(job);

/** The builds the wanted jobs need. */
function checkBuilds(only) {
  const missing = [];
  if (DESKTOP_JOBS.some((j) => wanted(only, j))) {
    if (!existsSync(join(REPO_ROOT, 'apps', 'desktop', 'out', 'main', 'index.js'))) {
      missing.push('npm run build -w apps/desktop');
    }
  }
  if (EXTENSION_JOBS.some((j) => wanted(only, j))) {
    if (!existsSync(join(REPO_ROOT, 'apps', 'extension', 'dist', 'blocked.html'))) {
      missing.push('npm run build -w apps/extension');
    }
  }
  if (missing.length) throw new Error(`Build first: ${missing.join(' && ')}`);
}

/** Linux without a display: run again under xvfb with a screen big enough for 2x windows. */
function ensureDisplay() {
  if (process.platform !== 'linux') return;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.CENTRATE_UNDER_XVFB) return;
  if (spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error) {
    throw new Error('No display and no xvfb-run: install xvfb or run with a display.');
  }
  const result = spawnSync(
    'xvfb-run',
    [
      '-a',
      '-s',
      XVFB_SCREEN,
      process.execPath,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, CENTRATE_UNDER_XVFB: '1' } },
  );
  process.exit(result.status ?? 1);
}

function capture(opts) {
  const require = createRequire(join(HERE, 'package.json'));
  const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  for (const lang of opts.langs) {
    const out = join(opts.work, lang);
    rmSync(out, { recursive: true, force: true });
    console.log(`\nCapture (${lang}) → ${out}`);
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '-c', join(HERE, 'playwright.config.ts')],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          MARKETING_OUT: out,
          MARKETING_LANG: lang,
          MARKETING_ONLY: opts.only.join(','),
          MARKETING_ANY_FONT: opts['any-font'] ? '1' : '',
          MARKETING_TEST_RESULTS: join(opts.work, 'test-results', lang),
        },
      },
    );
    if (result.status !== 0) throw new Error(`capture (${lang}) failed`);
  }
}

function kb(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

function report(manifest, media) {
  console.log(`\nMedia in ${relative(process.cwd(), media) || '.'}:`);
  for (const v of manifest.videos) {
    const files = v.sources.map((s) => `${s.codec} ${kb(s.bytes)}/${kb(s.budget)}`).join(', ');
    console.log(
      `  ${v.lang}/${v.id}: ${v.width}×${v.height}, ${(v.durationMs / 1000).toFixed(1)} s · ${files} · poster ${kb(v.poster.bytes)}`,
    );
  }
  const largest = Math.max(0, ...manifest.stills.map((s) => Math.max(s.avif.bytes, s.webp.bytes)));
  console.log(
    `  ${manifest.stills.length} stills (largest ${kb(largest)}/${kb(manifest.budgets.image)})`,
  );
}

async function main() {
  const opts = options();
  if (!opts['skip-encode']) checkFfmpeg();
  if (!opts['skip-capture']) {
    checkBuilds(opts.only);
    ensureDisplay();
    capture(opts);
  }
  if (opts['skip-encode']) return;
  const manifest = await encodeAll({ work: opts.work, media: opts.media });
  if (!opts['no-licenses']) await recordLicenses(manifest);
  report(manifest, opts.media);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
