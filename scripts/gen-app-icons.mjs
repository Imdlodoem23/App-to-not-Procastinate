#!/usr/bin/env node
// Draws the app icons from the brand master assets/brand/icon.svg (docs/brand.md «Tamaños y
// recortes», PROMPT.md §11 «Material visual» and §12):
//
//   apps/desktop/build/icon.icns           macOS: the 1024 canvas as is (824 plate, 100 margin)
//   apps/desktop/build/icon.ico            Windows: cropped to the plate, 16 to 256 px
//   apps/desktop/build/icons/<N>x<N>.png   Linux (hicolor sizes 16 to 512), cropped to the plate
//   apps/desktop/build/icon.png            1024, cropped to the plate (electron-builder fallback)
//   apps/web/public/favicon-32.png         32, cropped to the plate
//   apps/web/public/apple-touch-icon.png   180, square plate: iOS rounds the corners itself and
//                                          paints transparent pixels black
//
// electron-builder picks icon.icns, icon.ico and icons/ from buildResources (build/) by name, so
// electron-builder.yml needs no `icon` key. The generated files are committed; rerun after
// changing the master or the tokens.
//
// Colors come only from packages/shared/src/design/tokens.ts: the fills of the master's `plate`,
// `ring` and `dot` are overwritten by id (colors.light.blue and colors.light.tile; the icon is the
// same in both themes). The containers are written here in plain JS, with no iconutil, ImageMagick
// or other binaries:
// - .ico: one PNG-compressed entry per size (Windows Vista and later; Electron needs Windows 10).
// - .icns: PNG entries ic11 ic12 ic07 ic13 ic08 ic14 ic09 ic10 (32 to 1024 px, 1x and 2x).
//
//   node scripts/gen-app-icons.mjs           write every icon (npm run gen:icons)
//   node scripts/gen-app-icons.mjs --check   write nothing; exit 1 if any file is missing or
//                                            differs (CI freshness check)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

const { colors } = await import('../packages/shared/src/design/tokens.ts');

const root = resolve(import.meta.dirname, '..');
const MASTER = 'assets/brand/icon.svg';
const DESKTOP_BUILD = 'apps/desktop/build';
const WEB_PUBLIC = 'apps/web/public';

/** Windows: 100 %, 125 %, 150 % and 200 % of the 16 and 32 px shell sizes, plus 48 to 256. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
/** Linux hicolor theme sizes (/usr/share/icons/hicolor/<N>x<N>/apps). */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
/** macOS icon types with PNG data, as iconutil writes them: [type, pixels]. */
const ICNS_TYPES = [
  ['ic11', 32], // 16 pt @2x
  ['ic12', 64], // 32 pt @2x
  ['ic07', 128], // 128 pt
  ['ic13', 256], // 128 pt @2x
  ['ic08', 256], // 256 pt
  ['ic14', 512], // 256 pt @2x
  ['ic09', 512], // 512 pt
  ['ic10', 1024], // 512 pt @2x
];

const { values: args } = parseArgs({ options: { check: { type: 'boolean', default: false } } });

const master = readFileSync(join(root, MASTER), 'utf8');

/** Opening tag of the element with this id (throws if the master lost it). */
function elementTag(svg, id) {
  const tag = svg.match(new RegExp(`<[a-zA-Z]+\\b[^>]*\\bid="${id}"[^>]*>`));
  if (!tag) throw new Error(`${MASTER}: no element with id="${id}"`);
  return tag[0];
}

function readAttribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function withAttribute(tag, name, value) {
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  if (!pattern.test(tag)) throw new Error(`${MASTER}: ${tag} has no ${name}`);
  return tag.replace(pattern, ` ${name}="${value}"`);
}

function setAttribute(svg, id, name, value) {
  const tag = elementTag(svg, id);
  return svg.replace(tag, withAttribute(tag, name, value));
}

/** The master with the token colors; warns when the copy of a hex in the master is stale. */
function paint(svg) {
  const theme = colors.light;
  const fills = [
    ['plate', 'fill', theme.blue, 'colors.light.blue'],
    ['ring', 'stroke', theme.tile, 'colors.light.tile'],
    ['dot', 'fill', theme.tile, 'colors.light.tile'],
  ];
  let out = svg;
  for (const [id, name, value, token] of fills) {
    const current = readAttribute(elementTag(out, id), name);
    if (current?.toUpperCase() !== value.toUpperCase()) {
      console.warn(
        `note: ${MASTER} #${id} ${name}="${current}", ${token} is ${value} (using ${value})`,
      );
    }
    out = setAttribute(out, id, name, value);
  }
  return out;
}

/** The plate alone (viewBox = the plate's box); `square` drops its rounded corners. */
function cropToPlate(svg, { square = false } = {}) {
  const plate = elementTag(svg, 'plate');
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) =>
    Number(readAttribute(plate, name)),
  );
  if (![x, y, width, height].every(Number.isFinite) || width !== height) {
    throw new Error(`${MASTER}: #plate needs numeric x, y and a square width/height`);
  }
  const rootTag = svg.match(/<svg\b[^>]*>/)[0];
  let croppedRoot = withAttribute(rootTag, 'viewBox', `${x} ${y} ${width} ${height}`);
  croppedRoot = withAttribute(croppedRoot, 'width', String(width));
  croppedRoot = withAttribute(croppedRoot, 'height', String(height));
  const out = svg.replace(rootTag, croppedRoot);
  return square ? setAttribute(out, 'plate', 'rx', '0') : out;
}

const painted = paint(master);
const variants = {
  /** macOS: 1024 canvas with the 100 margin of the macOS icon grid. */
  canvas: painted,
  /** Windows, Linux and the web: the plate fills the box. */
  plate: cropToPlate(painted),
  /** Apple touch icon: full-bleed square. */
  square: cropToPlate(painted, { square: true }),
};

const renders = new Map();
function png(variant, px) {
  const key = `${variant}@${px}`;
  if (!renders.has(key)) {
    const image = new Resvg(variants[variant], {
      fitTo: { mode: 'width', value: px },
      font: { loadSystemFonts: false },
    }).render();
    if (image.width !== px || image.height !== px) {
      throw new Error(
        `${variant} rendered at ${image.width}x${image.height}, expected ${px}x${px}`,
      );
    }
    renders.set(key, image.asPng());
  }
  return renders.get(key);
}

/** ICO container (ICONDIR + one 16-byte ICONDIRENTRY per image) with PNG image data. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ px, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(px >= 256 ? 0 : px, entry); // width (0 means 256)
    header.writeUInt8(px >= 256 ? 0 : px, entry + 1); // height
    header.writeUInt8(0, entry + 2); // palette size
    header.writeUInt8(0, entry + 3); // reserved
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

/** ICNS container: 'icns' + total length, then (type, length including the 8-byte header, data). */
function icns(entries) {
  const chunks = entries.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** Every generated file: repo-relative path -> bytes. */
const outputs = new Map([
  [
    `${DESKTOP_BUILD}/icon.icns`,
    icns(ICNS_TYPES.map(([type, px]) => ({ type, data: png('canvas', px) }))),
  ],
  [`${DESKTOP_BUILD}/icon.ico`, ico(ICO_SIZES.map((px) => ({ px, data: png('plate', px) })))],
  [`${DESKTOP_BUILD}/icon.png`, png('plate', 1024)],
  ...LINUX_SIZES.map((px) => [`${DESKTOP_BUILD}/icons/${px}x${px}.png`, png('plate', px)]),
  [`${WEB_PUBLIC}/favicon-32.png`, png('plate', 32)],
  [`${WEB_PUBLIC}/apple-touch-icon.png`, png('square', 180)],
]);

let stale = 0;
for (const [path, data] of outputs) {
  const file = join(root, path);
  if (args.check) {
    if (!existsSync(file) || !readFileSync(file).equals(data)) {
      console.error(`stale: ${path}`);
      stale += 1;
    }
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

if (args.check) {
  if (stale > 0) {
    console.error(`${stale} app icon(s) out of date: run npm run gen:icons`);
    process.exit(1);
  }
  console.log('app icons up to date');
} else {
  console.log(`wrote ${outputs.size} app icons from ${MASTER}:`);
  for (const path of outputs.keys()) console.log(`  ${path}`);
}
