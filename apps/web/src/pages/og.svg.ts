/** /og.svg: the Spanish Open Graph image as SVG (src/lib/og-image.ts). */
import type { APIRoute } from 'astro';
import { getCopy } from '../content/locale';
import { buildOgSvg } from '../lib/og-image';

export const GET: APIRoute = () =>
  new Response(buildOgSvg(getCopy('es')), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
