import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defaultLang, langs, routes } from './src/lib/i18n.ts';

// Canonical URLs, Open Graph, robots.txt and the sitemap are all built from `site`. Order:
// SITE_URL (set it in the Render dashboard for a custom domain), then RENDER_EXTERNAL_URL (Render
// sets it on every build to the service's own onrender.com address, so a different service name
// cannot leave the tags pointing at someone else's host), then the expected default.
const site =
  process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'https://centrate.onrender.com';
if (process.env.RENDER) console.info(`[centrate] site URL: ${site}`);

// Spanish lives at / and English under /en, with translated slugs (/descargar ↔ /en/download).
// Each page lists its translations in the sitemap (and in its <head>, see Base.astro).
const translations = Object.keys(routes[defaultLang]).map((key) => ({
  paths: langs.map((lang) => routes[lang][key]),
  links: [
    ...langs.map((lang) => ({ lang, url: new URL(routes[lang][key], site).href })),
    { lang: 'x-default', url: new URL(routes[defaultLang][key], site).href },
  ],
}));

export default defineConfig({
  site,
  output: 'static',
  // One URL form everywhere: canonical, og:url, internal links and the sitemap all use
  // /descargar and /en/download (never with a final slash). render.yaml rewrites each clean
  // path to its index.html.
  trailingSlash: 'never',
  // Lossless whitespace removal. Astro 7's default ('jsx') drops line breaks between inline
  // elements, which would glue words together in multi-line markup («texto<a>enlace</a>»).
  compressHTML: true,
  build: {
    // Small stylesheets are inlined into the page, the large global one stays a cached file.
    inlineStylesheets: 'auto',
  },
  // No link prefetching: every page is small and the site should not spend visitors' data.
  prefetch: false,
  integrations: [
    sitemap({
      // The 404 page is served for any missing path and must not be indexed.
      filter: (page) => !/\/404\/?$/.test(new URL(page).pathname),
      serialize(item) {
        const path = new URL(item.url).pathname.replace(/(.)\/$/, '$1');
        const page = translations.find((entry) => entry.paths.includes(path));
        return page ? { ...item, links: page.links } : item;
      },
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
