#!/usr/bin/env node
// Checks that every unpacked build electron-builder left in release/ carries what
// electron-builder.yml copies with `extraResources`, so an installer can never ship without the
// offline focus sounds (PROMPT §9 «Sonidos … que funcionan sin internet») or the Study Mode
// models. The release workflow runs it right after packaging, on Windows, macOS and Linux.
//
// - Every extraResources entry: each source file its filter selects is packaged under `to`
//   (same size for sounds/ and models/). A missing source is a warning (the guardian binary,
//   for instance, only exists after scripts/build-guardian.mjs).
// - sounds/ and models/ must have an entry: the app reads them through src/main/app/paths.ts.
// - models/: the packaged manifest.json and every model it lists. The MediaPipe runtime is
//   checked when packages/study-ai/scripts/fetch-models.mjs copied it before packaging;
//   otherwise it is reported as a warning (Study Mode stays off until it is bundled).
//
// Unpacked builds: <name>-unpacked/resources (Windows, Linux) and mac*/<app>.app/Contents/Resources.
//
//   node scripts/check-packaged-resources.mjs [releaseDir] [--desktop-dir DIR]
//     releaseDir     default: <desktop-dir>/release
//     --desktop-dir  folder holding electron-builder.yml and resources/ (default: apps/desktop)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

// electron-builder reads its YAML config with js-yaml (app-builder-lib), so this does too.
const { load: loadYaml } = createRequire(import.meta.url)('js-yaml');

/** Folders whose files must also keep their size (they are data the app reads). */
const SIZE_CHECKED = new Set(['sounds', 'models']);
/** Folders the app needs whatever the config says (src/main/app/paths.ts). */
const REQUIRED_TARGETS = ['sounds', 'models'];

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'desktop-dir': { type: 'string' } },
});
const desktopDir = resolve(args['desktop-dir'] ?? join(import.meta.dirname, '..'));
const releaseDir = resolve(positionals[0] ?? join(desktopDir, 'release'));
const annotate = process.env.GITHUB_ACTIONS === 'true';

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];
const error = (/** @type {string} */ msg) => errors.push(msg);
const warn = (/** @type {string} */ msg) => warnings.push(msg);

/**
 * The glob subset electron-builder filters use here (`*`, `**`, `?`), matched like minimatch
 * against a path relative to `from`, with `/` separators.
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  if (/[!{}[\]]/.test(pattern)) throw new Error(`unsupported filter pattern: ${pattern}`);
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = /** @type {string} */ (pattern[i]);
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Names electron-builder's copyDir always skips (builder-util fs.ts). */
const NEVER_COPIED = new Set(['.DS_Store', '.gitkeep']);

/** Every file under `dir`, as `/`-separated paths relative to it. @param {string} dir */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (NEVER_COPIED.has(entry.name)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Resources folders of the unpacked builds in `dir`. @param {string} dir */
function unpackedResources(dir) {
  /** @type {string[]} */
  const roots = [];
  if (!existsSync(dir)) return roots;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.endsWith('-unpacked')) {
      roots.push(join(full, 'resources'));
    } else if (entry.name.startsWith('mac') && !entry.name.endsWith('-temp')) {
      for (const app of readdirSync(full)) {
        if (app.endsWith('.app')) roots.push(join(full, app, 'Contents', 'Resources'));
      }
    }
  }
  return roots;
}

/**
 * Source → packaged pairs of every extraResources entry, as `{ source, target, sized }`
 * (target relative to the resources folder).
 */
function expectedFiles() {
  const config = /** @type {{ extraResources?: unknown }} */ (
    loadYaml(readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8'))
  );
  const entries = Array.isArray(config.extraResources) ? config.extraResources : [];
  /** @type {{ source: string, target: string, sized: boolean }[]} */
  const files = [];
  const targets = new Set();
  for (const raw of entries) {
    const entry = typeof raw === 'string' ? { from: raw, to: raw } : raw;
    const from = String(entry.from);
    const to = String(entry.to ?? entry.from).replace(/\/+$/, '');
    targets.add(to);
    const source = join(desktopDir, from);
    const sized = SIZE_CHECKED.has(to.split('/')[0] ?? '');
    if (!existsSync(source)) {
      warn(`${from} does not exist at packaging time; skipped`);
      continue;
    }
    if (statSync(source).isFile()) {
      files.push({ source, target: to, sized });
      continue;
    }
    const filters = (Array.isArray(entry.filter) ? entry.filter : [entry.filter ?? '**/*']).map(
      (p) => globToRegExp(String(p)),
    );
    for (const rel of listFiles(source)) {
      if (filters.some((re) => re.test(rel))) {
        files.push({ source: join(source, rel), target: `${to}/${rel}`, sized });
      }
    }
  }
  for (const required of REQUIRED_TARGETS) {
    if (!targets.has(required)) {
      error(`electron-builder.yml has no extraResources entry with "to: ${required}"`);
    }
  }
  return files;
}

/** @param {string} root @param {ReturnType<typeof expectedFiles>} files */
function checkRoot(root, files) {
  const label = relative(releaseDir, root) || root;
  let ok = 0;
  for (const { source, target, sized } of files) {
    const packaged = join(root, ...target.split('/'));
    if (!existsSync(packaged)) {
      error(`${label}: missing ${target}`);
    } else if (sized && statSync(packaged).size !== statSync(source).size) {
      error(
        `${label}: ${target} is ${statSync(packaged).size} bytes, expected ${statSync(source).size}`,
      );
    } else ok++;
  }

  const wavs = existsSync(join(root, 'sounds'))
    ? readdirSync(join(root, 'sounds')).filter((f) => f.endsWith('.wav'))
    : [];
  if (wavs.length === 0) error(`${label}: no sounds/*.wav`);

  const manifestPath = join(root, 'models', 'manifest.json');
  if (!existsSync(manifestPath)) {
    error(`${label}: missing models/manifest.json`);
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const model of manifest.models ?? []) {
      if (!existsSync(join(root, 'models', model.file))) {
        error(`${label}: missing models/${model.file} (listed in manifest.json)`);
      }
    }
    const wasm = manifest.wasm;
    for (const file of wasm?.files ?? []) {
      const rel = `${wasm.dir}/${file.file}`;
      if (!existsSync(join(root, 'models', ...rel.split('/')))) {
        warn(
          `${label}: models/${rel} is not bundled (run packages/study-ai/scripts/fetch-models.mjs before packaging; Study Mode needs it)`,
        );
      }
    }
  }
  console.log(`${label}: ${ok}/${files.length} files, ${wavs.length} sounds`);
}

const roots = unpackedResources(releaseDir);
if (roots.length === 0) error(`no unpacked build in ${releaseDir}`);
const files = expectedFiles();
for (const root of roots) checkRoot(root, files);

for (const msg of warnings) console.warn(annotate ? `::warning::${msg}` : `warning: ${msg}`);
for (const msg of errors) console.error(annotate ? `::error::${msg}` : `error: ${msg}`);
if (errors.length > 0) process.exit(1);
console.log(`Packaged resources OK in ${roots.length} build(s).`);
