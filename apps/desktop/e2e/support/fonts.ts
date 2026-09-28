/**
 * The typeface the e2e runs and the screenshot capture render in (PROMPT §10 «Tipografía»:
 * `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Ubuntu,
 * "Noto Sans", sans-serif`, nothing downloaded).
 *
 * Windows and macOS have their stack font. A Linux runner usually has only DejaVu Sans, which
 * is not in the stack, about 12 % wider than Segoe UI and has no 600: the docs/ui shots (the
 * README's and the web's) would show the wrong type and trip width fallbacks the product never
 * shows. So on Linux every launch gets a private fontconfig file (`FONTCONFIG_FILE`) that
 * keeps the system configuration and puts a stack family in front of what `system-ui`
 * resolves to (Chromium asks fontconfig for «Sans»), in stack order:
 *
 * 1. **Selawik** (Microsoft, OFL: Segoe UI's metrics), when installed or in
 *    `CENTRATE_FONT_DIRS`, also answers «Segoe UI» and «Segoe UI Variable Text»: Windows-like
 *    shots. It is a stand-in, recorded as such.
 * 2. **Ubuntu** (`fonts-ubuntu`: a variable font, so 600 is a real semibold).
 * 3. **Noto Sans** (`fonts-noto-core` has Regular and Bold only: 600 renders as Bold;
 *    `fonts-noto-extra` adds SemiBold).
 *
 * `CENTRATE_FONTS=system` turns this off (plain system fonts). `CENTRATE_FONT_DIRS` (path
 * list) adds font folders to the private configuration.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { fontFamily } from '@centrate/shared/design/tokens';

/** The stack's entries in order, unquoted. */
export const FONT_STACK: readonly string[] = fontFamily
  .split(',')
  .map((entry) => entry.trim().replace(/^["']|["']$/g, ''));

const GENERIC = new Set(['system-ui', '-apple-system', 'sans-serif']);

/** The named families of the stack: what a capture must render in. */
export const STACK_FAMILIES: readonly string[] = FONT_STACK.filter((f) => !GENERIC.has(f));

/** Metric-compatible stand-ins accepted for a stack family. */
export const STAND_INS: Readonly<Record<string, string>> = { Selawik: 'Segoe UI' };

/** Families that can stand for `system-ui` on Linux, in the order they are preferred. */
const LINUX_UI_FAMILIES = ['Selawik', 'Ubuntu', 'Noto Sans'] as const;

/** Platform names a stack entry resolves to (macOS reports its system font like this). */
function isStackName(family: string): boolean {
  if (STACK_FAMILIES.some((f) => f.toLowerCase() === family.toLowerCase())) return true;
  if (process.platform === 'darwin' && /^(\.?SF|System Font|\.AppleSystemUIFont)/i.test(family)) {
    return true;
  }
  return false;
}

export interface ResolvedFont {
  /** Family name as the renderer (or fontconfig) reports it. */
  family: string;
  /** The stack family it stands in for (Selawik → Segoe UI), else `null`. */
  standsInFor: string | null;
  /** In the stack, or an accepted stand-in. */
  ok: boolean;
}

export function judgeFamily(family: string): ResolvedFont {
  const standsInFor = STAND_INS[family] ?? null;
  return { family, standsInFor, ok: isStackName(family) || standsInFor !== null };
}

export interface FontPlan {
  /** Extra environment for Electron (`FONTCONFIG_FILE` on Linux). */
  env: Record<string, string>;
  /**
   * What fontconfig resolves `system-ui` («Sans») to under `env` on Linux; `null` elsewhere
   * (the OS's own font; the renderer check tells).
   */
  expected: ResolvedFont | null;
  /** One line on how the font was chosen, for logs, the manifest and docs/ui/index.html. */
  source: string;
}

function fcFamilies(env: NodeJS.ProcessEnv): Set<string> {
  const out = spawnSync('fc-list', [':', 'family'], { env, encoding: 'utf8' });
  if (out.error || out.status !== 0) return new Set();
  return new Set(
    out.stdout
      .split('\n')
      .flatMap((line) => line.split(','))
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function fcMatch(pattern: string, env: NodeJS.ProcessEnv): string | null {
  const out = spawnSync('fc-match', ['-f', '%{family[0]}', pattern], { env, encoding: 'utf8' });
  return out.error || out.status !== 0 ? null : out.stdout.trim() || null;
}

const xml = (text: string): string =>
  text.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
  );

/**
 * The private fontconfig file: our aliases first (fontconfig applies rules in file order, and
 * `prefer` inserts before the matched name, so they must run before the system's
 * 60-latin.conf puts DejaVu in front of `sans-serif`), then the system configuration.
 */
function fontconfigXml(
  ui: string,
  selawik: boolean,
  dirs: readonly string[],
  system: string,
): string {
  const alias = (name: string, prefer: string) =>
    `  <alias binding="strong"><family>${xml(name)}</family><prefer><family>${xml(prefer)}</family></prefer></alias>`;
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<!-- Generated by apps/desktop/e2e/support/fonts.ts for e2e and capture runs. -->',
    '<fontconfig>',
    ...dirs.map((d) => `  <dir>${xml(d)}</dir>`),
    ...(selawik ? [alias('Segoe UI Variable Text', 'Selawik'), alias('Segoe UI', 'Selawik')] : []),
    ...['system-ui', 'sans', 'sans-serif'].map((generic) => alias(generic, ui)),
    `  <include ignore_missing="yes">${xml(system)}</include>`,
    '</fontconfig>',
    '',
  ].join('\n');
}

/**
 * The font plan for a launch. On Linux it writes `fonts.conf` into `dir` (the launch's
 * temporary folder) when a stack family is installed; otherwise it leaves the system fonts and
 * says why in `source`.
 */
export function fontPlan(dir: string, base: NodeJS.ProcessEnv = process.env): FontPlan {
  if (process.platform !== 'linux') {
    return { env: {}, expected: null, source: `${process.platform}: the system's own font` };
  }
  if (base['CENTRATE_FONTS'] === 'system') {
    const family = fcMatch('sans', base);
    return {
      env: {},
      expected: family ? judgeFamily(family) : null,
      source: 'CENTRATE_FONTS=system: system fonts as they are',
    };
  }
  const dirs = (base['CENTRATE_FONT_DIRS'] ?? '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d && existsSync(d));
  // Families visible with the extra folders (a probe config holding just those folders).
  // The configuration ours wraps: the caller's own FONTCONFIG_FILE, else the system's.
  const system = base['FONTCONFIG_FILE'] || '/etc/fonts/fonts.conf';
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'fonts.conf');
  writeFileSync(file, fontconfigXml('sans-serif', false, dirs, system));
  const probeEnv = { ...base, FONTCONFIG_FILE: file };
  const installed = fcFamilies(probeEnv);
  const ui = LINUX_UI_FAMILIES.find((f) => installed.has(f));
  if (!ui) {
    const family = fcMatch('sans', probeEnv) ?? 'unknown';
    return {
      env: dirs.length ? { FONTCONFIG_FILE: file } : {},
      expected: judgeFamily(family),
      source:
        `no stack font installed (${family} instead): install fonts-ubuntu or fonts-noto-core, ` +
        'or put Selawik in CENTRATE_FONT_DIRS',
    };
  }
  writeFileSync(file, fontconfigXml(ui, ui === 'Selawik', dirs, system));
  const env = { FONTCONFIG_FILE: file };
  const family = fcMatch('sans', { ...base, ...env }) ?? ui;
  const judged = judgeFamily(family);
  return {
    env,
    expected: judged,
    source:
      `Linux: system-ui → ${family}` +
      (judged.standsInFor ? ` (metric-compatible stand-in for ${judged.standsInFor})` : '') +
      ' via a private fontconfig file',
  };
}

// ---------------------------------------------------------------------------------------
// What the renderer really drew with
// ---------------------------------------------------------------------------------------

export interface PlatformFont {
  family: string;
  postScriptName: string;
}

export interface RenderedFonts extends ResolvedFont {
  /** Platform font of the first text drawn at each weight the kit uses (400, 600). */
  weights: Record<'400' | '600', PlatformFont | null>;
}

/**
 * The platform fonts Chromium used for text at 400 and 600 in `page`
 * (`CSS.getPlatformFontsForNode` over CDP), judged against the stack by the 400 family.
 */
export async function renderedFonts(context: BrowserContext, page: Page): Promise<RenderedFonts> {
  const tagged = await page.evaluate(() => {
    const found: Record<string, boolean> = {};
    for (const el of document.body.querySelectorAll('*')) {
      const own = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 1,
      );
      if (!own || el.getClientRects().length === 0) continue;
      const weight = getComputedStyle(el).fontWeight;
      if ((weight === '400' || weight === '600') && !found[weight]) {
        el.setAttribute('data-font-probe', weight);
        found[weight] = true;
      }
    }
    return found;
  });
  const cdp = await context.newCDPSession(page);
  const weights: RenderedFonts['weights'] = { '400': null, '600': null };
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    await cdp.send('CSS.enable');
    for (const weight of ['400', '600'] as const) {
      if (!tagged[weight]) continue;
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: `[data-font-probe="${weight}"]`,
      });
      if (!nodeId) continue;
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      const main = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
      if (main) weights[weight] = { family: main.familyName, postScriptName: main.postScriptName };
    }
  } finally {
    await cdp.detach().catch(() => undefined);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-font-probe]')) {
        el.removeAttribute('data-font-probe');
      }
    });
  }
  const family = weights['400']?.family ?? weights['600']?.family ?? 'unknown';
  return { ...judgeFamily(family), weights };
}
