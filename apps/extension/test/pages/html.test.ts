/**
 * The extension pages' HTML (public/*.html): Spanish by default (each script then sets
 * `<html lang>` to the browser's language, i18n/index.ts), landmarks, and MV3's CSP (no
 * inline scripts or handlers: each page loads its esbuild bundle, named like the build
 * entries).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const PAGES = ['blocked', 'popup', 'options'] as const;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe.each(PAGES)('public/%s.html', (name) => {
  const html = read(`public/${name}.html`);

  it('is Spanish, UTF-8 and follows the system theme', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<html lang="es">/);
    expect(html).toMatch(/<meta charset="utf-8"/i);
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it('loads only its own bundle: no inline script, style or handler (MV3 CSP)', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]).toContain(`type="module"`);
    expect(scripts[0]?.[1]).toContain(`src="${name}.js"`);
    expect(scripts[0]?.[2]?.trim()).toBe('');
    expect(html).toContain(`<link rel="stylesheet" href="${name}.css" />`);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<style\b|\sstyle="/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('has a main landmark', () => {
    expect(html).toMatch(/<main\b[^>]*id="(main|guide)"/);
  });
});

describe('public/blocked.html', () => {
  const html = read('public/blocked.html');

  it('has no big countdown: the header «quedan N min» is the only time (PROMPT §10)', () => {
    expect(html).not.toMatch(/countdown/);
    expect(html).toMatch(/<span id="blocked-remaining" class="section-value">/);
    // The 15, 5 and 1 min marks and the end are still spoken.
    expect(html).toMatch(/<p id="blocked-live" class="visually-hidden" aria-live="polite">/);
  });
});

describe('public/popup.html', () => {
  it('has a status line outside every section (confirms what hides its own, like pairing)', () => {
    const html = read('public/popup.html');
    expect(html).toContain('<p id="popup-live" class="visually-hidden" role="status"></p>');
    const live = html.indexOf('id="popup-live"');
    expect(live).toBeLessThan(html.indexOf('<section'));
    // The «Bloqueo» heading takes the focus when what had it disappears.
    expect(html).toContain('<h2 id="block-title" class="section-title" tabindex="-1"></h2>');
  });

  it('draws the mode bar right under the countdown, decorative', () => {
    const html = read('public/popup.html');
    const countdown = html.indexOf('id="block-countdown"');
    const bar = html.indexOf('<div id="block-bar" class="mode-bar" aria-hidden="true" hidden>');
    expect(countdown).toBeGreaterThan(0);
    expect(bar).toBeGreaterThan(countdown);
    expect(html.slice(countdown, bar)).not.toMatch(/<(p|ul|section)\b/);
  });

  it('the bar is 3 px in the accent of #block (the mode, red for a punishment)', () => {
    const css = /\n\.mode-bar \{([^}]*)\}/.exec(read('src/pages/popup/popup.css'))?.[1] ?? '';
    expect(css).toContain('height: var(--size-mode-bar);');
    expect(css).toMatch(/background: var\(--accent\b/);
    expect(read('src/pages/popup/main.ts')).toMatch(/setAttr\(blockSectionEl, 'data-accent'/);
  });
});

describe('shared/base.css', () => {
  it('restates the font on body (Chromium sets 75 % and system-ui on extension pages)', () => {
    const body = /\nbody \{([^}]*)\}/.exec(read('src/pages/shared/base.css'))?.[1] ?? '';
    expect(body).toContain('font-family: var(--font-sans);');
    expect(body).toContain('font-size: var(--font-size-13);');
  });
});

describe('build entries', () => {
  it('build.mjs bundles the background and one entry per page, named like the HTML expects', () => {
    const build = read('build.mjs');
    expect(build).toContain(`background: 'src/background/index.ts'`);
    for (const name of PAGES) {
      expect(build).toContain(`${name}: 'src/pages/${name}/main.ts'`);
      expect(read(`src/pages/${name}/main.ts`)).toContain(`import './${name}.css';`);
    }
    expect(build).toContain(`chunkNames: 'chunk-[hash]'`);
  });

  it('the manifest points at the pages and exposes blocked.html with its files', () => {
    const manifest = JSON.parse(read('public/manifest.json')) as {
      action?: { default_popup?: string };
      options_ui?: { page?: string };
      web_accessible_resources?: Array<{ resources: string[] }>;
    };
    expect(manifest.action?.default_popup).toBe('popup.html');
    expect(manifest.options_ui?.page).toBe('options.html');
    const exposed = manifest.web_accessible_resources?.flatMap((r) => r.resources) ?? [];
    for (const file of ['blocked.html', 'blocked.js', 'blocked.css', 'chunk-*.js']) {
      expect(exposed).toContain(file);
    }
  });
});
