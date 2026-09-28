#!/usr/bin/env node
// Draws the tray icons (PROMPT §10 «Icono de la bandeja», docs/DESKTOP.md §8.6) into
// apps/desktop/resources/assets/tray/, which electron-builder already packages as
// <resources>/assets/tray/. The PNGs are committed; rerun after changing the glyph or tokens.
//
//   node scripts/gen-tray-icons.mjs           write every icon
//   node scripts/gen-tray-icons.mjs --check   write nothing; exit 1 if any file is missing
//                                             or differs (CI freshness check)
//
// Our own glyph (never G-Helper's): a focus target. At rest an outlined ring with a centre
// dot, monochrome; with a block a filled disc with a cut-out ring, in the mode's accent
// (blue Normal, orange Estricto, red Hardcore/Examen/castigo, green Study Mode). The shape
// changes too, so the state never depends on color alone. The camera dot is a red disc in
// the top-right corner, cut out of the glyph. Colors come only from tokens.ts; macOS's idle
// icon is a template image (only its alpha matters).
//
// Names and sizes come from src/main/tray/icons.ts (imported through Node's TypeScript
// type stripping: Node >= 22.18).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

// apps/desktop has no "type": "module", so Node warns that it reparses icons.ts as ESM.
// That is expected here: drop just that warning.
const printWarning = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  for (const listener of printWarning) listener(warning);
});

const { colors } = await import('../../../packages/shared/src/design/tokens.ts');
const { TRAY_ICON_ACCENT, TRAY_ICON_DIR, TRAY_ICON_SIZES, trayIconFileName, trayIconSet } =
  await import('../src/main/tray/icons.ts');

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'resources', ...TRAY_ICON_DIR);
const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

/** Glyph geometry in a 16-unit box (drawn at 16, 20, 24 and 32 px). */
const G = {
  c: 8,
  ringR: 6.1,
  ringW: 1.8,
  dotR: 2.2,
  discR: 7.4,
  cutR: 3.9,
  cutW: 1.5,
  camCx: 12.9,
  camCy: 3.1,
  camR: 2.9,
  camGap: 1.2,
};

function glyph({ filled, fill, camera, cameraFill }) {
  const shapes = filled
    ? `<circle cx="${G.c}" cy="${G.c}" r="${G.discR}" fill="${fill}" mask="url(#cut)"/>`
    : `<circle cx="${G.c}" cy="${G.c}" r="${G.ringR}" fill="none" stroke="${fill}" stroke-width="${G.ringW}"/>` +
      `<circle cx="${G.c}" cy="${G.c}" r="${G.dotR}" fill="${fill}"/>`;
  const cameraCut = camera
    ? `<circle cx="${G.camCx}" cy="${G.camCy}" r="${G.camR + G.camGap}" fill="black"/>`
    : '';
  const ringCut = filled
    ? `<circle cx="${G.c}" cy="${G.c}" r="${G.cutR}" fill="none" stroke="black" stroke-width="${G.cutW}"/>`
    : '';
  const cameraDot = camera
    ? `<circle cx="${G.camCx}" cy="${G.camCy}" r="${G.camR}" fill="${cameraFill}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">` +
    `<rect width="16" height="16" fill="white"/>${ringCut}${cameraCut}</mask></defs>` +
    `<g mask="url(#cut)">${shapes}</g>${cameraDot}</svg>`
  );
}

function spec(icon) {
  // `light` / `dark` is the surface the icon sits on; the template only needs alpha.
  const theme = icon.variant === 'dark' ? colors.dark : colors.light;
  const token = TRAY_ICON_ACCENT[icon.key];
  return {
    filled: icon.key !== 'idle',
    fill: theme[token],
    camera: icon.camera,
    cameraFill: theme.red,
  };
}

function render(svg, px) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    shapeRendering: 2,
    background: 'rgba(0,0,0,0)', // allow-color (transparent canvas)
  })
    .render()
    .asPng();
}

let stale = 0;
let written = 0;
if (!args.check) mkdirSync(outDir, { recursive: true });
for (const icon of trayIconSet()) {
  const svg = glyph(spec(icon));
  for (const size of TRAY_ICON_SIZES) {
    const file = join(outDir, trayIconFileName(icon, size.suffix));
    const png = render(svg, size.px);
    if (args.check) {
      if (!existsSync(file) || !readFileSync(file).equals(png)) {
        console.error(`stale: ${relative(root, file)}`);
        stale += 1;
      }
      continue;
    }
    writeFileSync(file, png);
    written += 1;
  }
}

if (args.check) {
  if (stale > 0) {
    console.error(`${stale} tray icon(s) out of date: run npm run gen:tray-icons -w apps/desktop`);
    process.exit(1);
  }
  console.log('tray icons up to date');
} else {
  console.log(`wrote ${written} tray icons to ${relative(root, outDir)}`);
}
