/**
 * Renders the built Open Graph image (dist/og.svg, made from copy.ts by src/pages/og.svg.ts) to
 * public/og.png (1200 × 630), the file site.ogImage points to: most social networks do not show
 * SVG previews.
 *
 * Chromium draws it with the real Inter (the same woff2 files the site ships, inlined as data
 * URLs), which resvg cannot load. Run it after changing the hero or window copy:
 *
 *   npm run build -w apps/web && npm run og -w apps/web
 *
 * In this cloud container: PW_CHROMIUM_PATH=/opt/pw-browsers/chromium. The marketing-assets
 * workflow may overwrite the PNG later; og.svg.ts stays the source.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WIDTH = 1200;
const HEIGHT = 630;

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const fontCssPath = require.resolve('@fontsource-variable/inter/opsz.css');

const svg = await readFile(join(webDir, 'dist/og.svg'), 'utf8').catch(() => {
  throw new Error('dist/og.svg not found: run `npm run build -w apps/web` first.');
});

// Inline every @font-face source as a data URL, so the page needs no file or network access.
let fontCss = await readFile(fontCssPath, 'utf8');
const fontFiles = [...new Set(fontCss.match(/\.\/files\/[\w-]+\.woff2/g) ?? [])];
for (const file of fontFiles) {
  const data = await readFile(join(dirname(fontCssPath), file));
  fontCss = fontCss.replaceAll(
    `url(${file})`,
    `url(data:font/woff2;base64,${data.toString('base64')})`,
  );
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
});
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}
      html, body { margin: 0; background: #ffffff; }
      svg { display: block; }
    </style></head><body>${svg}</body></html>`,
  );
  // Load both weights the image uses before taking the picture.
  const loaded = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "Inter Variable"', 'Céntrate'),
      document.fonts.load('600 16px "Inter Variable"', 'Céntrate'),
    ]);
    await document.fonts.ready;
    return document.fonts.check('600 16px "Inter Variable"', 'Céntrate');
  });
  if (!loaded) throw new Error('Inter did not load.');
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  await writeFile(join(webDir, 'public/og.png'), png);
  console.log(`public/og.png: ${WIDTH} × ${HEIGHT}, ${Math.round(png.length / 1024)} KB`);
} finally {
  await browser.close();
}
