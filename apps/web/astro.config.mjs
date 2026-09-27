import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Static site for Render (render.yaml sets SITE_URL). Canonical URLs, Open Graph, robots.txt
// and the sitemap are all built from `site`.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://centrate.onrender.com',
  output: 'static',
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
