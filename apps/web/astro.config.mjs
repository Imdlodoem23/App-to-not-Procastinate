import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Canonical URLs, Open Graph, robots.txt and the sitemap are all built from `site`. Order:
// SITE_URL (set it in the Render dashboard for a custom domain), then RENDER_EXTERNAL_URL (Render
// sets it on every build to the service's own onrender.com address, so a different service name
// cannot leave the tags pointing at someone else's host), then the expected default.
const site =
  process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'https://centrate.onrender.com';
if (process.env.RENDER) console.info(`[centrate] site URL: ${site}`);

export default defineConfig({
  site,
  output: 'static',
  // One URL form everywhere: canonical, og:url, internal links and the sitemap all use
  // /descargar (never /descargar/). render.yaml rewrites each clean path to its index.html.
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
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
