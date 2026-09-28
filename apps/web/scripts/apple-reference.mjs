/**
 * Reference captures of Apple's software pages (PROMPT.md § 11, «Antes de diseñar»): screenshots
 * at 375, 768, 1280 and 1920 px plus the measurements the critique rounds compare against (bar
 * height, headline and body type per breakpoint, section padding, card radii and heights,
 * content width, pills, sticky scenes, videos and reveal transitions).
 *
 * The captures are for comparison only: they go to a temporary folder (default
 * `$RUNNER_TEMP/apple-reference` or the OS temp dir) and, in CI, into a workflow artifact.
 * Never commit or publish them. Nothing from these pages is copied into the site.
 *
 *   node apps/web/scripts/apple-reference.mjs [--out <dir>] [--no-shots] [--url <page>]
 *
 * `--url` measures another page with the same yardstick (for example the local preview,
 * http://localhost:4321/), so both sets of numbers can be compared side by side.
 *
 * Runs from GitHub Actions: Apple reference → Run workflow (the session network blocks
 * www.apple.com). Locally, PW_CHROMIUM_PATH points Playwright at a browser if it has none.
 * Writes `medidas.json`, `medidas.md` (also appended to the job summary) and the screenshots.
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const APPLE_PAGES = [
  { slug: 'macos', url: 'https://www.apple.com/es/macos/' },
  { slug: 'apple-intelligence', url: 'https://www.apple.com/es/apple-intelligence/' },
];
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
/** Viewport screenshots per page and width, one per screen height of scroll. */
const MAX_SCROLL_SHOTS = 40;

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir =
  outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : join(process.env.RUNNER_TEMP || tmpdir(), 'apple-reference');
const takeShots = !args.includes('--no-shots');
const urlIndex = args.indexOf('--url');
const PAGES =
  urlIndex >= 0 && args[urlIndex + 1]
    ? [
        {
          slug: new URL(args[urlIndex + 1]).hostname.replace(/[^a-z0-9]+/gi, '-'),
          url: args[urlIndex + 1],
        },
      ]
    : APPLE_PAGES;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs in the page. Returns computed values only (no text beyond a short label to tell the
 * elements apart), grouped and counted so the tables stay readable.
 */
function measure() {
  const vw = document.documentElement.clientWidth;
  const round = (n) => Math.round(n * 10) / 10;
  const px = (value) => (value === 'normal' ? value : `${round(parseFloat(value))}`);
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const top = (el) => round(el.getBoundingClientRect().top + window.scrollY);
  /** Counts identical keys, most frequent first. */
  const tally = (items, limit = 12) => {
    const map = new Map();
    for (const item of items) {
      const entry = map.get(item.key) ?? { ...item, count: 0 };
      entry.count += 1;
      map.set(item.key, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  };
  const type = (el) => {
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const lineHeight =
      s.lineHeight === 'normal'
        ? 'normal'
        : Math.round((parseFloat(s.lineHeight) / size) * 1000) / 1000;
    const tracking =
      s.letterSpacing === 'normal' ? 0 : round((parseFloat(s.letterSpacing) / size) * 1000) / 1000;
    return { size: round(size), lineHeight, tracking, weight: s.fontWeight };
  };
  const typeKey = (t) => `${t.size}px / ${t.lineHeight} / ${t.tracking}em / ${t.weight}`;

  // Bars: the global bar and the page's own sticky bar (Apple has two).
  const bars = [...document.querySelectorAll('nav, [role="navigation"], header')]
    .filter((el) => visible(el) && el.getBoundingClientRect().top < 200)
    .map((el) => {
      const s = getComputedStyle(el);
      // The glass often lives on a pseudo-element, so the bar itself stays transparent.
      const glass = getComputedStyle(el, '::before');
      const backdrop = (style) => style.backdropFilter || style.webkitBackdropFilter || 'none';
      const own = backdrop(s) !== 'none' || s.backgroundColor !== 'rgba(0, 0, 0, 0)';
      return {
        key: `${el.tagName.toLowerCase()}#${el.id || '-'}.${[...el.classList].slice(0, 2).join('.')}`,
        height: round(el.getBoundingClientRect().height),
        position: s.position,
        background: own ? s.backgroundColor : `::before ${glass.backgroundColor}`,
        backdrop: own ? backdrop(s) : `::before ${backdrop(glass)}`,
      };
    })
    .filter((bar) => bar.height >= 30 && bar.height <= 120);

  const headings = (selector) =>
    tally(
      [...document.querySelectorAll(selector)].filter(visible).map((el) => {
        const t = type(el);
        return { key: typeKey(t), ...t, firstAt: top(el) };
      }),
    );

  const paragraphs = tally(
    [...document.querySelectorAll('p')]
      .filter((el) => visible(el) && el.textContent.trim().length > 40)
      .map((el) => {
        const t = type(el);
        const s = getComputedStyle(el);
        return { key: `${typeKey(t)} / ${s.color}`, ...t, color: s.color, maxWidth: s.maxWidth };
      }),
  );

  const sections = tally(
    [...document.querySelectorAll('main section, main > div > section, main > *')]
      .filter(visible)
      .map((el) => {
        const s = getComputedStyle(el);
        const key = `${px(s.paddingTop)} / ${px(s.paddingBottom)} / ${s.backgroundColor}`;
        return {
          key,
          paddingTop: px(s.paddingTop),
          paddingBottom: px(s.paddingBottom),
          background: s.backgroundColor,
        };
      })
      // Plain wrappers (no padding, no background) say nothing about the rhythm.
      .filter((row) => row.key !== '0 / 0 / rgba(0, 0, 0, 0)'),
    16,
  );

  // Cards and tiles: rounded boxes at least 120 px wide.
  const rounded = tally(
    [...document.querySelectorAll('main *')]
      .filter((el) => {
        if (!visible(el)) return false;
        const r = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        return r >= 8 && r < 500 && el.getBoundingClientRect().width >= 120;
      })
      .map((el) => {
        const box = el.getBoundingClientRect();
        const radius = round(parseFloat(getComputedStyle(el).borderTopLeftRadius));
        return {
          key: `r${radius} ${Math.round(box.width)}x${Math.round(box.height)}`,
          radius,
          width: Math.round(box.width),
          height: Math.round(box.height),
          background: getComputedStyle(el).backgroundColor,
        };
      }),
    20,
  );

  // Pills: links and buttons with a fully rounded background.
  const pills = tally(
    [...document.querySelectorAll('a, button')]
      .filter((el) => {
        if (!visible(el)) return false;
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return (
          parseFloat(s.borderTopLeftRadius) >= box.height / 2 - 1 &&
          s.backgroundColor !== 'rgba(0, 0, 0, 0)'
        );
      })
      .map((el) => {
        const s = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const t = type(el);
        return {
          key: `${Math.round(box.height)}px / pad ${px(s.paddingLeft)} / ${typeKey(t)} / ${s.backgroundColor}`,
          height: Math.round(box.height),
          paddingInline: px(s.paddingLeft),
          ...t,
          background: s.backgroundColor,
          color: s.color,
        };
      }),
  );

  // Content column: the left edge of section headlines gives the column width.
  const columns = tally(
    [...document.querySelectorAll('main h2')].filter(visible).map((el) => {
      const left = Math.round(el.getBoundingClientRect().left);
      const align = getComputedStyle(el).textAlign;
      return {
        key: `${vw - 2 * left}px (${align})`,
        width: vw - 2 * left,
        percent: round(((vw - 2 * left) / vw) * 100),
      };
    }),
  );

  const sticky = [...document.querySelectorAll('main *')]
    .filter((el) => getComputedStyle(el).position === 'sticky' && visible(el))
    .map((el) => {
      const parent = el.parentElement;
      return {
        top: getComputedStyle(el).top,
        height: round(el.getBoundingClientRect().height),
        trackHeight: parent ? round(parent.getBoundingClientRect().height) : null,
        trackVh: parent ? round(parent.getBoundingClientRect().height / window.innerHeight) : null,
      };
    })
    .slice(0, 20);

  const videos = [...document.querySelectorAll('video')].map((v) => ({
    autoplay: v.autoplay,
    muted: v.muted,
    loop: v.loop,
    playsinline: v.playsInline,
    width: Math.round(v.getBoundingClientRect().width),
    height: Math.round(v.getBoundingClientRect().height),
  }));
  const mediaControls = [...document.querySelectorAll('button')]
    .filter(visible)
    .map((b) => b.getAttribute('aria-label') || b.textContent.trim())
    .filter((label) => /pausa|reproduc|repetir|play|pause|replay/i.test(label ?? '')).length;

  const transitions = tally(
    [
      ...document.querySelectorAll(
        'main h1, main h2, main h3, main p, main figure, main picture, main li',
      ),
    ]
      .map((el) => getComputedStyle(el))
      .filter((s) => s.transitionDuration !== '0s')
      .map((s) => ({
        key: `${s.transitionProperty} ${s.transitionDuration} ${s.transitionTimingFunction} delay ${s.transitionDelay}`,
      })),
    10,
  );

  const body = getComputedStyle(document.body);
  return {
    url: location.href,
    viewport: `${vw}x${window.innerHeight}`,
    pageHeight: document.documentElement.scrollHeight,
    body: {
      font: body.fontFamily,
      color: body.color,
      background: body.backgroundColor,
      ...type(document.body),
    },
    bars,
    h1: headings('main h1'),
    h2: headings('main h2'),
    h3: headings('main h3'),
    paragraphs,
    sections,
    rounded,
    pills,
    columns,
    sticky,
    videos: { count: videos.length, list: videos.slice(0, 12) },
    mediaControls,
    transitions,
  };
}

async function scrollThrough(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = await page.evaluate(() => Math.round(window.innerHeight * 0.8));
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await wait(250);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(800);
}

const table = (rows, columns) => {
  if (rows.length === 0) return '_(nada)_\n';
  const head = `| ${columns.map(([label]) => label).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n`;
  return (
    head +
    rows
      .map(
        (row) =>
          `| ${columns.map(([, get]) => String(get(row)).replaceAll('|', '\\|')).join(' | ')} |`,
      )
      .join('\n') +
    '\n'
  );
};

function toMarkdown(results) {
  let md = '# Medidas de referencia\n\n';
  md += `Generado el ${new Date().toISOString()} por \`apps/web/scripts/apple-reference.mjs\`. Solo para comparar: no se publica.\n`;
  for (const r of results) {
    md += `\n## ${r.slug} a ${r.width} px\n\n`;
    if (r.error) {
      md += `Error: ${r.error}\n`;
      continue;
    }
    const m = r.measurements;
    md += `URL final: ${m.url} · viewport ${m.viewport} · alto de página ${m.pageHeight} px · texto ${m.body.size}px/${m.body.lineHeight}, ${m.body.color} sobre ${m.body.background}\n\n`;
    md +=
      '**Barras**\n\n' +
      table(m.bars, [
        ['elemento', (b) => b.key],
        ['alto', (b) => b.height],
        ['posición', (b) => b.position],
        ['fondo', (b) => b.background],
        ['backdrop', (b) => b.backdrop],
      ]);
    for (const tag of ['h1', 'h2', 'h3']) {
      md +=
        `\n**${tag}** (tamaño / interlineado / espaciado / peso)\n\n` +
        table(m[tag], [
          ['estilo', (h) => h.key],
          ['veces', (h) => h.count],
          ['primera en y', (h) => h.firstAt],
        ]);
    }
    md +=
      '\n**Párrafos**\n\n' +
      table(m.paragraphs, [
        ['estilo / color', (p) => p.key],
        ['veces', (p) => p.count],
        ['max-width', (p) => p.maxWidth],
      ]);
    md +=
      '\n**Secciones** (relleno arriba / abajo / fondo)\n\n' +
      table(m.sections, [
        ['relleno y fondo', (s) => s.key],
        ['veces', (s) => s.count],
      ]);
    md +=
      '\n**Columna de contenido** (desde el borde de los h2)\n\n' +
      table(m.columns, [
        ['ancho', (c) => c.key],
        ['% del viewport', (c) => c.percent],
        ['veces', (c) => c.count],
      ]);
    md +=
      '\n**Tarjetas y tiles** (radio y tamaño)\n\n' +
      table(m.rounded, [
        ['radio y tamaño', (c) => c.key],
        ['fondo', (c) => c.background],
        ['veces', (c) => c.count],
      ]);
    md +=
      '\n**Píldoras**\n\n' +
      table(m.pills, [
        ['alto / relleno / tipo / fondo', (p) => p.key],
        ['veces', (p) => p.count],
      ]);
    md +=
      '\n**Escenas pegajosas**\n\n' +
      table(m.sticky, [
        ['top', (s) => s.top],
        ['alto', (s) => s.height],
        ['recorrido (px)', (s) => s.trackHeight],
        ['recorrido (vh)', (s) => s.trackVh],
      ]);
    md += `\n**Vídeos:** ${m.videos.count} · controles de reproducción visibles: ${m.mediaControls}\n\n`;
    md +=
      '**Transiciones** (titulares, textos, figuras)\n\n' +
      table(m.transitions, [
        ['transición', (t) => t.key],
        ['veces', (t) => t.count],
      ]);
  }
  return md;
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH || undefined,
});
const probe = await browser.newPage();
// Headless Chromium says «HeadlessChrome»; some CDNs answer that with an error page.
const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace(
  'HeadlessChrome',
  'Chrome',
);
await probe.close();

const results = [];
for (const target of PAGES) {
  for (const viewport of VIEWPORTS) {
    const label = `${target.slug}-${viewport.width}`;
    const context = await browser.newContext({
      viewport,
      userAgent,
      locale: 'es-ES',
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    try {
      await page.goto(target.url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await scrollThrough(page);
      const measurements = await page.evaluate(measure);
      results.push({ slug: target.slug, width: viewport.width, measurements });
      if (takeShots) {
        await page.screenshot({ path: join(outDir, `${label}-top.png`) });
        const height = measurements.pageHeight;
        for (let i = 1; i < MAX_SCROLL_SHOTS && i * viewport.height < height; i += 1) {
          await page.evaluate((y) => window.scrollTo(0, y), i * viewport.height);
          await wait(700);
          const name = `${label}-${String(i).padStart(2, '0')}.jpg`;
          await page.screenshot({ path: join(outDir, name), type: 'jpeg', quality: 70 });
        }
      }
      console.log(`ok ${label}: ${measurements.pageHeight} px tall`);
    } catch (error) {
      results.push({ slug: target.slug, width: viewport.width, error: String(error) });
      console.error(`failed ${label}: ${error}`);
    } finally {
      await context.close();
    }
  }
}
await browser.close();

const markdown = toMarkdown(results);
await writeFile(join(outDir, 'medidas.json'), JSON.stringify(results, null, 2));
await writeFile(join(outDir, 'medidas.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
console.log(`Saved to ${outDir}`);
if (results.every((r) => r.error)) process.exit(1);
