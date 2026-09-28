// The brand masters in assets/brand (docs/brand.md) and the SVG operations the icon generators
// share, so every icon of the product is drawn from the same two files:
//
//   assets/brand/icon.svg        app icon: #plate, #ring and #dot on a 1024 canvas
//   assets/brand/icon-mono.svg   monochrome template: #ring and #dot in a 16-unit box
//
// Used by scripts/gen-app-icons.mjs (.icns, .ico, Linux PNG, favicons),
// apps/desktop/scripts/gen-tray-icons.mjs (tray and menu bar) and
// apps/extension/scripts/gen-icons.mjs (toolbar and store icons). The elements are found by id
// and only their paint is changed (colors from packages/shared/src/design/tokens.ts); the
// geometry is never redrawn here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const APP_MASTER = 'assets/brand/icon.svg';
export const MONO_MASTER = 'assets/brand/icon-mono.svg';

/** A master's source (repo-relative path). */
export function readMaster(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/** Opening tag of the element with this id (throws if the master lost it). */
export function elementTag(svg, id) {
  const tag = svg.match(new RegExp(`<[a-zA-Z]+\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!tag) throw new Error(`brand master: no element with id="${id}"`);
  return tag[0];
}

export function readAttribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

export function withAttribute(tag, name, value) {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  if (!pattern.test(tag)) throw new Error(`brand master: ${tag} has no ${name}`);
  return tag.replace(pattern, ` ${name}="${value}"`);
}

export function setAttribute(svg, id, name, value) {
  const tag = elementTag(svg, id);
  return svg.replace(tag, withAttribute(tag, name, value));
}

/** The master without comments and indentation (smaller favicon, stable output). */
export function compact(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/**
 * The self-closing elements `ids` of `svg`, painted with `paint` ({ ring: { stroke: … } }),
 * with their ids dropped so they can be reused inside another SVG (masks, composites).
 */
export function markElements(svg, ids, paint = {}) {
  return ids
    .map((id) => {
      let tag = elementTag(svg, id);
      if (!tag.endsWith('/>')) throw new Error(`brand master: #${id} must be self-closing`);
      for (const [name, value] of Object.entries(paint[id] ?? {})) {
        tag = withAttribute(tag, name, value);
      }
      return tag.replace(/\sid="[^"]*"/, '');
    })
    .join('');
}

/**
 * The app icon master with token colors: `plate` in `theme.blue`, `ring` and `dot` in
 * `theme.tile`. Warns when the hex copy in the master is stale (the token wins).
 */
export function paintAppIcon(svg, theme) {
  const fills = [
    ['plate', 'fill', theme.blue, 'blue'],
    ['ring', 'stroke', theme.tile, 'tile'],
    ['dot', 'fill', theme.tile, 'tile'],
  ];
  let out = svg;
  for (const [id, name, value, token] of fills) {
    const current = readAttribute(elementTag(out, id), name);
    if (current?.toUpperCase() !== value.toUpperCase()) {
      console.warn(
        `note: ${APP_MASTER} #${id} ${name}="${current}", token ${token} is ${value} (using ${value})`,
      );
    }
    out = setAttribute(out, id, name, value);
  }
  return out;
}

/** The monochrome template painted in one color (ring stroke and dot fill). */
export function paintMono(svg, color) {
  return setAttribute(setAttribute(svg, 'ring', 'stroke', color), 'dot', 'fill', color);
}

/** The #plate box of the app icon master: { x, y, width, height } (square). */
export function plateBox(svg) {
  const plate = elementTag(svg, 'plate');
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) =>
    Number(readAttribute(plate, name)),
  );
  if (![x, y, width, height].every(Number.isFinite) || width !== height) {
    throw new Error(`${APP_MASTER}: #plate needs numeric x, y and a square width/height`);
  }
  return { x, y, width, height };
}

/**
 * The app icon cropped to its plate (the viewBox becomes the plate's box). `square` drops the
 * rounded corners (Apple touch icon); `margin` leaves that fraction of the plate transparent on
 * every side (store icons that need a margin); `size` sets width and height.
 */
export function cropToPlate(svg, { square = false, margin = 0, size } = {}) {
  const { x, y, width } = plateBox(svg);
  const pad = width * margin;
  const box = width + 2 * pad;
  const round = (value) => Number(value.toFixed(4));
  const rootTag = svg.match(/<svg\b[^>]*>/)[0];
  let croppedRoot = withAttribute(
    rootTag,
    'viewBox',
    `${round(x - pad)} ${round(y - pad)} ${round(box)} ${round(box)}`,
  );
  croppedRoot = withAttribute(croppedRoot, 'width', String(size ?? round(box)));
  croppedRoot = withAttribute(croppedRoot, 'height', String(size ?? round(box)));
  const out = svg.replace(rootTag, croppedRoot);
  return square ? setAttribute(out, 'plate', 'rx', '0') : out;
}

/**
 * The transform that maps the app icon's plate onto a `box`-unit square at the origin, for
 * reusing the master's #ring and #dot inside a 16-unit tray glyph.
 */
export function plateTransform(svg, box) {
  const { x, y, width } = plateBox(svg);
  const scale = Number((box / width).toFixed(10));
  return `scale(${scale}) translate(${-x} ${-y})`;
}

/** PNG of `svg` at `px` × `px` (throws if the SVG is not square). */
export function renderPng(svg, px) {
  const image = new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    font: { loadSystemFonts: false },
  }).render();
  if (image.width !== px || image.height !== px) {
    throw new Error(`rendered at ${image.width}x${image.height}, expected ${px}x${px}`);
  }
  return image.asPng();
}

/**
 * Writes `outputs` (repo-relative path -> bytes or text), or with `check` writes nothing and
 * exits 1 when a file is missing or differs (CI freshness check). `what` names the files in the
 * messages and `command` is how to regenerate them.
 */
export function syncOutputs(outputs, { check, what, command }) {
  let stale = 0;
  for (const [path, contents] of outputs) {
    const file = join(REPO_ROOT, path);
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (check) {
      if (!existsSync(file) || !readFileSync(file).equals(data)) {
        console.error(`stale: ${path}`);
        stale += 1;
      }
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  if (check) {
    if (stale > 0) {
      console.error(`${stale} ${what} out of date: run ${command}`);
      process.exit(1);
    }
    console.log(`${what} up to date`);
    return;
  }
  console.log(`wrote ${outputs.size} ${what}:`);
  for (const path of outputs.keys()) console.log(`  ${path}`);
}
