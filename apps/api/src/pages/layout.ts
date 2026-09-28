/**
 * Server-rendered HTML for the small web pages the API serves itself (owner: CORE; SOCIAL and
 * CLIENT use it). The API serves them because onrender.com is a public suffix: a page on the
 * static site could not share the API's cookies. Rules:
 * - Spanish copy, sentence case; colors only from the shared design tokens (served as CSS).
 * - Strict CSP (see app.ts): no inline scripts or styles. Page scripts are registered assets.
 * - Every interpolated value goes through `html` (escaped). Never put secrets in a page.
 * - `<meta name="referrer" content="same-origin">` overrides the API's `no-referrer` header for
 *   pages, so their same-origin form posts and fetches carry a real `Origin` (the CSRF rule for
 *   cookie sessions, auth/csrf.ts); other sites still get no referrer at all.
 */

/** Text that is already safe HTML. Only `html` and `raw` create it. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | Interpolation[];

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (value instanceof SafeHtml) return value.value;
  return escapeHtml(String(value));
}

/** Tagged template that escapes every interpolation except `SafeHtml`. */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Trusted markup (inline SVG built from numbers). Never pass user input. */
export const raw = (markup: string): SafeHtml => new SafeHtml(markup);

export interface PageOptions {
  title: string;
  body: SafeHtml;
  /** Names of registered script assets, e.g. `conectar.js`. */
  scripts?: string[];
}

/** The page shell. Styles and scripts come from /cuenta/assets/ (see `ASSET_PREFIX`). */
export function page({ title, body, scripts = [] }: PageOptions): string {
  return html`<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="referrer" content="same-origin" />
        <link rel="icon" href="data:," />
        <title>${title} · Céntrate</title>
        <link rel="stylesheet" href="${ASSET_PREFIX}tokens.css" />
        <link rel="stylesheet" href="${ASSET_PREFIX}pages.css" />
        ${scripts.map((s) => html`<script src="${ASSET_PREFIX}${s}" defer></script>`)}
      </head>
      <body>
        <main class="page">${body}</main>
      </body>
    </html>`.value;
}

export const ASSET_PREFIX = '/cuenta/assets/';

/** The static website (download and privacy pages). */
export const WEBSITE_URL = 'https://centrate.onrender.com';
export const PRIVACY_URL = `${WEBSITE_URL}/privacidad`;

export interface PageAsset {
  contentType: 'text/css; charset=utf-8' | 'text/javascript; charset=utf-8' | 'image/svg+xml';
  body: string;
}

/**
 * Static files served at /cuenta/assets/:name (the route is CORE's). Page modules register
 * their scripts and styles here when they are registered, e.g.
 * `registerPageAsset('panel.js', 'text/javascript; charset=utf-8', PANEL_JS)`.
 */
export const pageAssets = new Map<string, PageAsset>();

export function registerPageAsset(
  name: string,
  contentType: PageAsset['contentType'],
  body: string,
): void {
  if (!/^[a-z0-9-]+\.(css|js|svg)$/.test(name)) throw new Error(`bad asset name ${name}`);
  pageAssets.set(name, { contentType, body });
}
