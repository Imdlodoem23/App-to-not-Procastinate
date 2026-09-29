#!/usr/bin/env node
// Draws the tray icons (PROMPT §10 «Icono de la bandeja», docs/DESKTOP.md §8.6, docs/brand.md
// «Tamaños y recortes») into apps/desktop/resources/assets/tray/, which electron-builder already
// packages as <resources>/assets/tray/. The PNGs are committed; rerun after changing a brand
// master or the tokens.
//
//   node scripts/gen-tray-icons.mjs           write every icon
//   node scripts/gen-tray-icons.mjs --check   write nothing; exit 1 if any file is missing
//                                             or differs (CI freshness check)
//
// Both glyphs come from the brand masters (scripts/brand-masters.mjs), never from G-Helper's
// or any other brand's icon, and the shape changes with the state, so the state never depends
// on color alone:
// - At rest: assets/brand/icon-mono.svg, the «C» with the dot in its mouth, in the theme's `fg`
//   (light and dark taskbars) or black (macOS template image, only its alpha matters).
// - With a block: a filled disc in the mode's accent (blue Normal, orange Estricto, red
//   Hardcore/Examen/castigo, green Study Mode) with the mark of assets/brand/icon.svg, cropped
//   to its plate, cut out of it.
// The camera dot is a red disc in the top-right corner, cut out of the glyph. Colors come only
// from tokens.ts.
//
// Names and sizes come from src/main/tray/icons.ts (imported through Node's TypeScript
// type stripping: Node >= 22.18).

import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  APP_MASTER,
  MONO_MASTER,
  REPO_ROOT,
  markElements,
  paintMono,
  plateTransform,
  readMaster,
  renderPng,
  syncOutputs,
} from '../../../scripts/brand-masters.mjs';

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

const outDir = relative(REPO_ROOT, join(import.meta.dirname, '..', 'resources', ...TRAY_ICON_DIR));
const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const mono = readMaster(MONO_MASTER);
const app = readMaster(APP_MASTER);

/**
 * Active glyph geometry in the 16-unit box: the disc, and the camera dot with the gap cut
 * around it. The mark cut out of the disc is the app icon's, plate mapped onto the box.
 */
const G = { c: 8, discR: 7.5, camCx: 12.9, camCy: 3.1, camR: 2.9, camGap: 1.2 };
const BLACK = '#000000'; // allow-color (mask ink and template image: only alpha counts)
const WHITE = '#FFFFFF'; // allow-color (mask: keep)

/** At rest: the monochrome master in one color. */
function idleGlyph(fill) {
  return paintMono(mono, fill);
}

/** With a block: the accent disc with the brand mark (and the camera gap) cut out. */
function activeGlyph({ fill, camera, cameraFill }) {
  const cut = markElements(app, ['ring', 'dot'], {
    ring: { stroke: BLACK },
    dot: { fill: BLACK },
  });
  const cameraCut = camera
    ? `<circle cx="${G.camCx}" cy="${G.camCy}" r="${G.camR + G.camGap}" fill="${BLACK}"/>`
    : '';
  const cameraDot = camera
    ? `<circle cx="${G.camCx}" cy="${G.camCy}" r="${G.camR}" fill="${cameraFill}"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">` +
    `<rect width="16" height="16" fill="${WHITE}"/>` +
    `<g transform="${plateTransform(app, 16)}">${cut}</g>${cameraCut}</mask></defs>` +
    `<circle cx="${G.c}" cy="${G.c}" r="${G.discR}" fill="${fill}" mask="url(#cut)"/>` +
    `${cameraDot}</svg>`
  );
}

function glyph(icon) {
  if (icon.variant === 'template') return idleGlyph(BLACK);
  // `light` / `dark` is the surface the icon sits on.
  const theme = icon.variant === 'dark' ? colors.dark : colors.light;
  const fill = theme[TRAY_ICON_ACCENT[icon.key]];
  if (icon.key === 'idle') return idleGlyph(fill);
  return activeGlyph({ fill, camera: icon.camera, cameraFill: theme.red });
}

const outputs = new Map();
for (const icon of trayIconSet()) {
  const svg = glyph(icon);
  for (const size of TRAY_ICON_SIZES) {
    outputs.set(`${outDir}/${trayIconFileName(icon, size.suffix)}`, renderPng(svg, size.px));
  }
}

syncOutputs(outputs, {
  check: args.check,
  what: 'tray icons',
  command: 'npm run gen:tray-icons -w apps/desktop',
});
