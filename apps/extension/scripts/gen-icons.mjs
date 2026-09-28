#!/usr/bin/env node
// Draws the extension icons (manifest `icons` and `action.default_icon`) into
// apps/extension/public/icons/. The PNGs are committed; rerun after changing the glyph or tokens.
//
//   node scripts/gen-icons.mjs           write every icon
//   node scripts/gen-icons.mjs --check   write nothing; exit 1 if any file is missing or differs
//
// The glyph is the app's own focus target (the same shape as the desktop tray icon with a
// block on, apps/desktop/scripts/gen-tray-icons.mjs): a `blue` disc with a `tile` ring cut
// into it. Light-theme tokens: the dark blue disc reads on light toolbars and the white ring
// keeps it visible on dark ones. The 128 px store icon draws 96 × 96 px with a 16 px
// transparent margin (Chrome Web Store guidance); the toolbar sizes use the whole box.
// Colors come only from packages/shared/src/design/tokens.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

const { colors } = await import('../../../packages/shared/src/design/tokens.ts');

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'public', 'icons');
const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

/** Sizes referenced by public/manifest.json, and the drawing size inside each. */
const SIZES = [
  { px: 16, art: 16 },
  { px: 32, art: 32 },
  { px: 48, art: 48 },
  { px: 128, art: 96 },
];

/** Glyph geometry in a 16-unit box (as the tray icon). */
const G = { c: 8, discR: 7.4, ringR: 3.9, ringW: 1.5 };

function glyph(px, art) {
  const box = (16 * px) / art;
  const pad = (box - 16) / 2;
  const { blue, tile } = colors.light;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="${-pad} ${-pad} ${box} ${box}">` +
    `<circle cx="${G.c}" cy="${G.c}" r="${G.discR}" fill="${blue}"/>` +
    `<circle cx="${G.c}" cy="${G.c}" r="${G.ringR}" fill="none" stroke="${tile}" stroke-width="${G.ringW}"/>` +
    `</svg>`
  );
}

function render(svg, px) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    background: 'rgba(0,0,0,0)', // allow-color (transparent canvas)
  })
    .render()
    .asPng();
}

let stale = 0;
if (!args.check) mkdirSync(outDir, { recursive: true });
for (const { px, art } of SIZES) {
  const file = join(outDir, `icon-${px}.png`);
  const png = render(glyph(px, art), px);
  if (args.check) {
    if (!existsSync(file) || !readFileSync(file).equals(png)) {
      console.error(`stale: ${relative(root, file)}`);
      stale += 1;
    }
    continue;
  }
  writeFileSync(file, png);
}

if (args.check) {
  if (stale > 0) {
    console.error(`${stale} icon(s) out of date: run npm run gen:icons -w apps/extension`);
    process.exit(1);
  }
  console.log('extension icons up to date');
} else {
  console.log(`wrote ${SIZES.length} icons to ${relative(root, outDir)}`);
}
