#!/usr/bin/env node
// Screenshot matrix of the desktop app (PROMPT §10 «Capturas con Playwright»): every harness
// state × {light, dark} × {1366×768 at 100 and 125 %, 1920×1080 at 100 and 150 %}, rendered by
// the built app on the harness's fake display, saved to docs/ui/ with a generated
// docs/ui/index.html that shows them side by side.
//
// Usage (from apps/desktop, after `npm run build`):
//   npm run capture [-- --states idle,typing] [--themes dark] [--presets 1366x768@125]
//                   [--out <dir>] [--index-only]
//
// - The shots are taken by the Playwright project `capture` (e2e/capture/screens.capture.ts),
//   which this script runs with CENTRATE_CAPTURE=1; one app per scale factor, in parallel.
// - Linux without a display: re-runs itself under
//   `xvfb-run -a -s "-screen 0 2880x1800x24"` (the default xvfb screen is 640×480×8).
// - `--index-only` rebuilds index.html from docs/ui/manifest.json without launching anything.
// - A full run (no filter) replaces every PNG in the output folder; a filtered run replaces
//   only the shots it takes and keeps the rest of the manifest.
//
// The G-Helper reference screenshots (GPL) are never copied into the repository: index.html
// names their local path in a comment and can show them next to ours from a file picker.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const DEFAULT_OUT = join(REPO_ROOT, 'docs', 'ui');
const MAIN_ENTRY = join(APP_DIR, 'out', 'main', 'index.js');
const XVFB_SCREEN = '-screen 0 2880x1800x24';
const GHELPER_SHOTS = [
  '/tmp/claude-0/g-helper/docs/screenshot.png',
  '/tmp/claude-0/g-helper/docs/screenshot-dark.png',
];
const THEME_LABELS = { light: 'Claro', dark: 'Oscuro' };
const PRESET_ORDER = ['1920x1080@100', '1920x1080@150', '1366x768@100', '1366x768@125'];

function parseArgs(argv) {
  const options = { states: '', themes: '', presets: '', out: DEFAULT_OUT, indexOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.split(/=(.*)/s, 2);
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (argv[i] === undefined) throw new Error(`${name} needs a value`);
      return argv[i];
    };
    if (name === '--states') options.states = value();
    else if (name === '--themes') options.themes = value();
    else if (name === '--presets') options.presets = value();
    else if (name === '--out') options.out = resolve(value());
    else if (name === '--index-only') options.indexOnly = true;
    else if (name === '--help' || name === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n\n')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** Linux without a display: run again under xvfb (the flag avoids a loop). */
function ensureDisplay() {
  if (process.platform !== 'linux') return;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.CENTRATE_UNDER_XVFB) return;
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
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

function runCapture(options) {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `${relative(REPO_ROOT, MAIN_ENTRY)} is missing: run \`npm run build -w apps/desktop\` first.`,
    );
  }
  const filtered = Boolean(options.states || options.themes || options.presets);
  mkdirSync(options.out, { recursive: true });
  if (!filtered) {
    for (const file of readdirSync(options.out)) {
      if (file.endsWith('.png') || /^manifest\..+\.json$/.test(file))
        rmSync(join(options.out, file));
    }
  }
  const require = createRequire(join(APP_DIR, 'package.json'));
  const cli = join(dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
  const env = {
    ...process.env,
    CENTRATE_CAPTURE: '1',
    CENTRATE_CAPTURE_OUT: options.out,
    E2E_STATES: options.states,
    CENTRATE_CAPTURE_THEMES: options.themes,
    CENTRATE_CAPTURE_PRESETS: options.presets,
  };
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '-c', 'playwright.config.ts', '--project', 'capture', '--reporter', 'list'],
    { cwd: APP_DIR, stdio: 'inherit', env },
  );
  return result.status ?? 1;
}

/** Merges the per-worker manifests into manifest.json (new shots replace old ones). */
function mergeManifest(out) {
  const path = join(out, 'manifest.json');
  const entries = new Map();
  const keyOf = (e) => `${e.state}|${e.theme}|${e.preset}`;
  if (existsSync(path)) {
    for (const entry of JSON.parse(readFileSync(path, 'utf8')).entries ?? []) {
      if (entry.shots.every((s) => existsSync(join(out, s.file)))) entries.set(keyOf(entry), entry);
    }
  }
  for (const file of readdirSync(out)) {
    if (!/^manifest\..+\.json$/.test(file)) continue;
    for (const entry of JSON.parse(readFileSync(join(out, file), 'utf8')))
      entries.set(keyOf(entry), entry);
    rmSync(join(out, file));
  }
  const list = [...entries.values()];
  writeFileSync(
    path,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), entries: list }, null, 2)}\n`,
  );
  return list;
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const fileUrl = (name) => encodeURIComponent(name).replace(/%40/g, '@');

function figure(entry) {
  const shots = entry.shots
    .map((shot) => {
      const width = Math.round(shot.width / entry.scaleFactor);
      const height = Math.round(shot.height / entry.scaleFactor);
      const what = shot.window === 'main' ? 'ventana principal' : `ventana ${entry.window}`;
      const alt = `${entry.label}: ${what}, tema ${THEME_LABELS[entry.theme].toLowerCase()}, ${entry.presetLabel}`;
      return `<a href="${fileUrl(shot.file)}"><img src="${fileUrl(shot.file)}" width="${width}" height="${height}" loading="lazy" alt="${escapeHtml(alt)}"></a>`;
    })
    .join('');
  const density = entry.density === 'compact' ? ' · compacta' : '';
  return `<figure data-theme-shot="${entry.theme}"><div class="shots">${shots}</div><figcaption>${THEME_LABELS[entry.theme]}${density}</figcaption></figure>`;
}

function renderIndex(entries, out) {
  const states = [];
  const byState = new Map();
  for (const entry of entries) {
    if (!byState.has(entry.state)) {
      byState.set(entry.state, []);
      states.push({ id: entry.state, label: entry.label, window: entry.window });
    }
    byState.get(entry.state).push(entry);
  }
  const presets = PRESET_ORDER.filter((p) => entries.some((e) => e.preset === p));
  const presetLabel = (p) => entries.find((e) => e.preset === p)?.presetLabel ?? p;
  const tokensHref = relative(
    out,
    join(REPO_ROOT, 'packages', 'shared', 'src', 'design', 'tokens.css'),
  )
    .split('\\')
    .join('/');

  const sections = states
    .map((state) => {
      const rows = presets
        .map((preset) => {
          const shots = byState
            .get(state.id)
            .filter((e) => e.preset === preset)
            .sort((a, b) => (a.theme === b.theme ? 0 : a.theme === 'light' ? -1 : 1));
          if (shots.length === 0) return '';
          return `<div class="preset" data-preset="${preset}"><h3>${escapeHtml(presetLabel(preset))}</h3><div class="pair">${shots.map(figure).join('')}</div></div>`;
        })
        .join('');
      const where = state.window === 'main' ? '' : ` · ventana ${escapeHtml(state.window)}`;
      return `<section class="state" id="${state.id}"><h2>${escapeHtml(state.label)} <code>${state.id}</code><span class="where">${where}</span></h2>${rows}</section>`;
    })
    .join('\n');

  const presetRadios = [...presets, 'all']
    .map((p, i) => {
      const label = p === 'all' ? 'Todas' : presetLabel(p);
      return `<label><input type="radio" name="preset" value="${p}"${i === 0 ? ' checked' : ''}> ${escapeHtml(label)}</label>`;
    })
    .join('');
  const nav = states.map((s) => `<a href="#${s.id}">${escapeHtml(s.label)}</a>`).join('');
  const generated = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Céntrate · capturas de la interfaz</title>
<!--
  Generated by apps/desktop/scripts/ui-capture.mjs; do not edit.
  G-Helper reference screenshots, to compare against (GPL-3.0: never copied into this repo):
${GHELPER_SHOTS.map((p) => `    ${p}`).join('\n')}
  Open them next to this page, or load them with «Referencia G-Helper» (read from disk only).
-->
<link rel="stylesheet" href="${tokensHref}">
<style>
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-sans); font-size: var(--font-size-13); line-height: var(--line-height-13); }
  header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: var(--size-border) solid var(--border); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
  h1 { margin: 0; font-size: var(--font-size-20); line-height: var(--line-height-20); font-weight: var(--font-weight-semibold); }
  p, .muted { margin: 0; color: var(--fg-muted); }
  .controls { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); align-items: center; }
  .controls fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); align-items: center; }
  .controls legend { float: left; font-weight: var(--font-weight-semibold); margin-right: var(--space-2); padding: 0; }
  nav { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); font-size: var(--font-size-12); }
  a { color: var(--accent-text); }
  main { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
  .state { scroll-margin-top: 160px; }
  .state h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-15); line-height: var(--line-height-15); font-weight: var(--font-weight-semibold); }
  .state h2 code { font-weight: var(--font-weight-normal); color: var(--fg-muted); font-size: var(--font-size-12); margin-left: var(--space-2); }
  .where { font-weight: var(--font-weight-normal); color: var(--fg-muted); font-size: var(--font-size-12); }
  .preset { margin-bottom: var(--space-3); }
  .preset h3 { margin: 0 0 var(--space-1); font-size: var(--font-size-12); line-height: var(--line-height-12); font-weight: var(--font-weight-normal); color: var(--fg-muted); }
  .pair { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: flex-end; }
  figure { margin: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  .shots { display: flex; gap: 6px; align-items: flex-end; }
  .shots img { display: block; outline: var(--size-border) solid var(--border); }
  figcaption { font-size: var(--font-size-12); color: var(--fg-muted); }
  #reference { position: fixed; right: var(--space-4); bottom: var(--space-4); max-width: 45vw; max-height: 70vh; overflow: auto; background: var(--tile); border: var(--size-border) solid var(--border); padding: var(--space-2); display: flex; gap: var(--space-2); align-items: flex-end; }
  #reference[hidden] { display: none; }
  #reference img { display: block; max-width: 100%; }
  body[data-theme-filter="light"] [data-theme-shot="dark"], body[data-theme-filter="dark"] [data-theme-shot="light"] { display: none; }
</style>
</head>
<body data-preset-filter="${presets[0] ?? 'all'}" data-theme-filter="both">
<header>
  <h1>Capturas de la interfaz.</h1>
  <p>${states.length} estados en claro y oscuro, en ${presets.length} pantallas, a tamaño real (DIP; el enlace abre la captura a píxel de pantalla). Generado el ${generated} UTC con <code>npm run capture -w apps/desktop</code>.</p>
  <form class="controls" onsubmit="return false">
    <fieldset><legend>Pantalla</legend>${presetRadios}</fieldset>
    <fieldset><legend>Tema</legend>
      <label><input type="radio" name="theme" value="both" checked> Los dos</label>
      <label><input type="radio" name="theme" value="light"> Claro</label>
      <label><input type="radio" name="theme" value="dark"> Oscuro</label>
    </fieldset>
    <fieldset><legend>Referencia G-Helper</legend>
      <input type="file" id="reference-files" accept="image/*" multiple aria-describedby="reference-help">
      <span id="reference-help" class="muted">docs/screenshot.png y screenshot-dark.png de tu copia de G-Helper; no se guardan en ningún sitio.</span>
    </fieldset>
  </form>
  <nav aria-label="Estados">${nav}</nav>
</header>
<main>
${sections}
</main>
<aside id="reference" aria-label="Referencia G-Helper" hidden></aside>
<script>
  const body = document.body;
  const applyPreset = (value) => {
    body.dataset.presetFilter = value;
    for (const el of document.querySelectorAll('.preset')) el.hidden = value !== 'all' && el.dataset.preset !== value;
  };
  for (const input of document.querySelectorAll('input[name="preset"]')) input.addEventListener('change', () => applyPreset(input.value));
  for (const input of document.querySelectorAll('input[name="theme"]')) input.addEventListener('change', () => { body.dataset.themeFilter = input.value; });
  applyPreset(body.dataset.presetFilter);
  const reference = document.getElementById('reference');
  document.getElementById('reference-files').addEventListener('change', (event) => {
    reference.replaceChildren();
    for (const file of event.target.files) {
      const img = document.createElement('img');
      img.alt = 'G-Helper: ' + file.name;
      img.src = URL.createObjectURL(file);
      reference.append(img);
    }
    reference.hidden = reference.childElementCount === 0;
  });
</script>
</body>
</html>
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let status = 0;
  if (!options.indexOnly) {
    ensureDisplay();
    status = runCapture(options);
  }
  const entries = mergeManifest(options.out);
  const index = join(options.out, 'index.html');
  writeFileSync(index, renderIndex(entries, options.out));
  const shots = entries.reduce((n, e) => n + e.shots.length, 0);
  console.log(`${shots} screenshots, ${relative(process.cwd(), index)}`);
  process.exit(status);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
