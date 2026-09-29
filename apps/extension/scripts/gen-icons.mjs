#!/usr/bin/env node
// Draws the extension icons (manifest `icons` and `action.default_icon`) into
// apps/extension/public/icons/. The PNGs are committed; rerun after changing the brand master or
// the tokens.
//
//   node scripts/gen-icons.mjs           write every icon
//   node scripts/gen-icons.mjs --check   write nothing; exit 1 if any file is missing or differs
//
// The icon is the app's own (docs/brand.md): assets/brand/icon.svg cropped to its plate, as the
// Windows and Linux icons and the favicon are, painted through scripts/brand-masters.mjs with
// the light-theme tokens (the icon is the same in both themes). So the toolbar shows the same
// mark as the taskbar or the dock, and never the tray's «block active» disc. The 128 px store
// icon draws the plate at 96 × 96 px with a 16 px transparent margin (Chrome Web Store
// guidance); the toolbar sizes use the whole box. Colors come only from
// packages/shared/src/design/tokens.ts.

import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  APP_MASTER,
  REPO_ROOT,
  cropToPlate,
  paintAppIcon,
  readMaster,
  renderPng,
  syncOutputs,
} from '../../../scripts/brand-masters.mjs';

const { colors } = await import('../../../packages/shared/src/design/tokens.ts');

const outDir = relative(REPO_ROOT, join(import.meta.dirname, '..', 'public', 'icons'));
const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

/** Sizes referenced by public/manifest.json, and the plate's size inside each. */
const SIZES = [
  { px: 16, art: 16 },
  { px: 32, art: 32 },
  { px: 48, art: 48 },
  { px: 128, art: 96 },
];

const painted = paintAppIcon(readMaster(APP_MASTER), colors.light);

const outputs = new Map();
for (const { px, art } of SIZES) {
  const margin = (px - art) / 2 / art;
  outputs.set(`${outDir}/icon-${px}.png`, renderPng(cropToPlate(painted, { margin }), px));
}

syncOutputs(outputs, {
  check: args.check,
  what: 'extension icons',
  command: 'npm run gen:icons -w apps/extension',
});
