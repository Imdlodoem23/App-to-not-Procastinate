/**
 * Post-deploy check of the live site: every page answers at its clean URL, and the canonical
 * URL, og:url, og:image, robots.txt and the sitemap all use the origin the site is served from
 * (a wrong SITE_URL or a renamed Render service would point them at another host).
 *
 *   node apps/web/scripts/check-live.mjs https://centrate.onrender.com
 *
 * Also runs from GitHub Actions: Web quality → Run workflow, with the live URL.
 */
const input = process.argv[2] || process.env.LIVE_URL;
if (!input) {
  console.error('Usage: node apps/web/scripts/check-live.mjs <https://site-url>');
  process.exit(2);
}
const origin = new URL(input).origin;
const failures = [];

/** @param {string} path */
async function get(path) {
  const response = await fetch(new URL(path, origin), { redirect: 'manual' });
  if (response.status !== 200) failures.push(`${path}: HTTP ${response.status} (expected 200)`);
  return response;
}

/** @param {string} html @param {RegExp} pattern */
const attr = (html, pattern) => html.match(pattern)?.[1] ?? '';

const pages = [
  '/',
  '/descargar',
  '/novedades',
  '/privacidad',
  '/en',
  '/en/download',
  '/en/changelog',
  '/en/privacy',
];
const canonicals = [];
for (const path of pages) {
  const html = await (await get(path)).text();
  const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/);
  const ogUrl = attr(html, /<meta property="og:url" content="([^"]+)"/);
  const ogImage = attr(html, /<meta property="og:image" content="([^"]+)"/);
  if (canonical !== new URL(path, origin).href) {
    failures.push(`${path}: canonical is «${canonical}», expected ${new URL(path, origin).href}`);
  }
  if (ogUrl !== canonical) failures.push(`${path}: og:url «${ogUrl}» differs from the canonical`);
  if (!ogImage.startsWith(`${origin}/`))
    failures.push(`${path}: og:image «${ogImage}» is off-site`);
  canonicals.push(canonical);
}

const robots = await (await get('/robots.txt')).text();
if (!robots.includes(`Sitemap: ${origin}/sitemap-index.xml`)) {
  failures.push(`/robots.txt: no «Sitemap: ${origin}/sitemap-index.xml» line`);
}
await get('/sitemap.xml');
const sitemap = await (await get('/sitemap-0.xml')).text();
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if ([...locs].sort().join() !== [...canonicals].sort().join()) {
  failures.push(
    `sitemap-0.xml lists ${locs.join(', ')}; the canonicals are ${canonicals.join(', ')}`,
  );
}
const og = await get('/og.png');
if (!og.headers.get('content-type')?.startsWith('image/png')) failures.push('/og.png is not a PNG');

if (failures.length > 0) {
  console.error(`Live check of ${origin} failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Live check of ${origin}: ${pages.length} pages, sitemap, robots.txt and og.png OK.`);
