/**
 * /og.svg: the Open Graph placeholder (1200 × 630), built from copy.ts so no text is written
 * twice. It echoes the hero: the name, the headline, and the Céntrate window with YouTube
 * blocked and the countdown (copy.meta.ogImageAlt), entering from the bottom edge.
 *
 * Most social networks do not render SVG previews; the marketing-assets workflow will add a
 * PNG (satori + resvg) and site.ogImage will point to it. The colors below are copies of
 * src/styles/tokens.css (--palette-* and the --aw-* dark theme): a standalone image cannot read
 * CSS variables.
 */
import type { APIRoute } from 'astro';
import { copy } from '../content/copy';

const color = {
  page: '#ffffff',
  ink: '#1d1d1f',
  ink2: '#6e6e73',
  awBg: '#1c1c1c',
  awTile: '#2e2e2e',
  awTile2: '#242424',
  awFg: '#f0f0f0',
  awMuted: '#a8a8a8',
  awBorder: '#373737',
  awControl: '#7a7a7a',
  awBlue: '#3aaeef',
  awGreen: '#06b48a',
} as const;

const FONT = `Inter, 'Inter Variable', 'Segoe UI', Roboto, Arial, sans-serif`;

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function text(
  value: string,
  x: number,
  y: number,
  attrs: Record<string, string | number> = {},
): string {
  const rendered = Object.entries(attrs)
    .map(([key, v]) => ` ${key}="${v}"`)
    .join('');
  return `<text x="${x}" y="${y}"${rendered}>${esc(value)}</text>`;
}

function buildSvg(): string {
  const aw = copy.appWindow;
  const [ext1, ext2, ext3, extOther] = aw.block.extend;
  const tileW = (416 - 3 * 4) / 4;
  const extendTiles = [ext1, ext2, ext3, extOther]
    .map((label, i) => {
      const x = 12 + i * (tileW + 4);
      const door = i === 3;
      return (
        `<rect x="${x}" y="164" width="${tileW}" height="32" rx="6" fill="${door ? color.awTile2 : color.awTile}" stroke="${color.awBorder}"/>` +
        text(label, x + tileW / 2, 184.5, {
          'font-size': 13,
          fill: color.awFg,
          'text-anchor': 'middle',
        })
      );
    })
    .join('');

  // Window-local coordinates: 440 px wide, like the real window; scaled 1.3 on the canvas.
  const appWindow = `
  <g transform="translate(314 250) scale(1.3)">
    <rect width="440" height="340" rx="8" fill="${color.awBg}" stroke="${color.awBorder}" filter="url(#shadow)"/>
    ${text(aw.title.blocked, 12, 20.5, { 'font-size': 12, fill: color.awFg })}
    <path d="M412 11l10 10M422 11l-10 10" stroke="${color.awFg}" stroke-width="1"/>
    ${text(aw.block.activeHeader, 12, 58, { 'font-size': 13, 'font-weight': 600, fill: color.awFg })}
    ${text(aw.block.activeMeta, 376, 58, { 'font-size': 12, fill: color.awMuted, 'text-anchor': 'end' })}
    <rect x="384.5" y="46.5" width="43" height="15" rx="4" fill="none" stroke="${color.awControl}"/>
    ${text(aw.block.newPill, 406, 57.5, { 'font-size': 11, 'font-weight': 600, fill: color.awFg, 'text-anchor': 'middle' })}
    <text x="10" y="118" font-size="48" font-weight="600" letter-spacing="-0.96" fill="${color.awFg}">${esc(aw.block.countdown.minutes)}<tspan fill-opacity="0.6">${esc(aw.block.countdown.seconds)}</tspan></text>
    <rect x="12" y="132" width="416" height="3" rx="1.5" fill="${color.awTile}"/>
    <rect x="12" y="132" width="${(416 * 0.705).toFixed(1)}" height="3" rx="1.5" fill="${color.awBlue}"/>
    ${text(aw.block.motive, 12, 153, { 'font-size': 12, 'font-style': 'italic', fill: color.awMuted })}
    ${extendTiles}
    ${text(aw.block.emergency, 12, 216, { 'font-size': 12, fill: color.awMuted })}
    ${text(aw.study.readyHeader, 12, 246, { 'font-size': 13, 'font-weight': 600, fill: color.awFg })}
    ${text(aw.study.readyMeta, 428, 246, { 'font-size': 12, fill: color.awMuted, 'text-anchor': 'end' })}
    ${text(aw.progress.header, 12, 278, { 'font-size': 13, 'font-weight': 600, fill: color.awFg })}
    ${text(aw.progress.meta, 428, 278, { 'font-size': 12, fill: color.awMuted, 'text-anchor': 'end' })}
    <circle cx="16" cy="318" r="4" fill="${color.awGreen}"/>
    ${text(aw.footer.guardian, 26, 322, { 'font-size': 12, fill: color.awMuted })}
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${FONT}">
  <title>${esc(copy.meta.ogImageAlt)}</title>
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="24" stdDeviation="24" flood-color="#000000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="${color.page}"/>
  ${text(copy.hero.eyebrow, 600, 112, { 'font-size': 32, 'font-weight': 600, fill: color.ink, 'text-anchor': 'middle' })}
  ${text(copy.hero.headline, 600, 196, { 'font-size': 72, 'font-weight': 600, 'letter-spacing': -0.65, fill: color.ink, 'text-anchor': 'middle' })}
  ${appWindow}
</svg>
`;
}

export const GET: APIRoute = () =>
  new Response(buildSvg(), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
