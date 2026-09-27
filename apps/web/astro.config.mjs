import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://centrate.onrender.com',
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
