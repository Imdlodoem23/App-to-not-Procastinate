/**
 * Screenshot matrix (PROMPT §10 «Capturas con Playwright»): every harness fixture × {light,
 * dark} × the four display presets, rendered by the real app on the harness's fake display
 * (work area and frame of the preset, `--force-device-scale-factor` of its scale), so the
 * automatic height and density are the ones a user on that screen gets.
 *
 * Run through `npm run capture -w apps/desktop` (scripts/ui-capture.mjs), which sets:
 * - `CENTRATE_CAPTURE=1` (enables this Playwright project) and `CENTRATE_CAPTURE_OUT`;
 * - optional filters `E2E_STATES`, `CENTRATE_CAPTURE_THEMES`, `CENTRATE_CAPTURE_PRESETS`;
 * - optional `CENTRATE_CAPTURE_LANG=en`: the fake OS language (docs/ui/en/).
 *
 * Output, per shot, in `CENTRATE_CAPTURE_OUT` (docs/ui):
 * - `<state>-<theme>-<w>x<h>@<scale>.png`: the window the state is about (the detail window
 *   for detail states, the mini timer, OSD or Nuclear window for surface states), at device
 *   pixels;
 * - `<state>-<theme>-<w>x<h>@<scale>.main.png`: for detail and surface states, the main window
 *   beside it;
 * - `manifest.<scale>.json`: what this worker wrote (merged into manifest.json by the script).
 *
 * Typeface (PROMPT §10 «Tipografía»): the shots feed the README and the web, so they must be
 * in a family of the brief's stack. Before launching, the worker checks what the launch will
 * resolve `system-ui` to (`fontPlan`, fontconfig on Linux) and, once the app is up, what
 * Chromium really drew with (`renderedFonts`); either one outside the stack fails the capture
 * unless `CENTRATE_CAPTURE_ANY_FONT=1` (`npm run capture -- --any-font`). The font is recorded
 * in every manifest entry.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISPLAY_PRESETS,
  DISPLAY_PRESET_IDS,
  type DisplayPresetId,
  type HarnessFixture,
} from '../../src/shared/fixtures';
import { isLocale } from '../../src/shared/i18n/locale';
import { isSurfaceKind, type UiWindow, type WindowKind } from '../../src/shared/ui-state';
import { waitHarnessReady } from '../support/app';
import type { LaunchedApp } from '../support/app';
import { settleWindow } from '../support/checks';
import { fontPlan, renderedFonts, type PlatformFont } from '../support/fonts';
import { THEMES, presetsByScale, selectedFixtures, type CaptureTheme } from '../support/matrix';
import { expect, test } from '../support/test';

export interface CaptureShot {
  /** File name relative to the output folder. */
  file: string;
  window: UiWindow;
  /** Device pixels. */
  width: number;
  height: number;
}

/** The typeface of a shot, as recorded in the manifest and docs/ui/index.html. */
export interface CaptureFont {
  /** Family Chromium drew the 400 text with. */
  family: string;
  /** The stack family it stands in for (Selawik → Segoe UI), else `null`. */
  standsInFor: string | null;
  /** In the brief's stack (or an accepted stand-in). */
  inStack: boolean;
  /** Platform face per weight («Ubuntu-Regular» for a variable font's 600 too). */
  weights: Record<'400' | '600', PlatformFont | null>;
  /** How it was chosen (`fontPlan().source`). */
  source: string;
  /** `process.platform` of the capture. */
  platform: NodeJS.Platform;
}

export interface CaptureEntry {
  state: string;
  label: string;
  /** The window the state is about. */
  window: HarnessFixture['window'];
  theme: CaptureTheme;
  preset: DisplayPresetId;
  presetLabel: string;
  scaleFactor: number;
  density: string | null;
  /** The primary shot first (detail window for detail states), then the main window. */
  shots: CaptureShot[];
  settled: boolean;
  font: CaptureFont;
}

const OUT = process.env['CENTRATE_CAPTURE_OUT'];
const ANY_FONT = process.env['CENTRATE_CAPTURE_ANY_FONT'] === '1';
const LANG_ENV = process.env['CENTRATE_CAPTURE_LANG'];
const LANG = isLocale(LANG_ENV) ? LANG_ENV : null;
const FONT_HELP =
  'install a family of the stack (Linux: `sudo apt-get install fonts-ubuntu`, or ' +
  'fonts-noto-core; Selawik via CENTRATE_FONT_DIRS for Windows metrics), or pass --any-font';

/** Before any launch: what `system-ui` will resolve to. Throws outside the stack. */
function fontPreflight(): void {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-font-'));
  try {
    const plan = fontPlan(dir);
    if (plan.expected && !plan.expected.ok && !ANY_FONT) {
      throw new Error(
        `The capture would render in ${plan.expected.family}: ${plan.source}; ${FONT_HELP}.`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function listEnv<T extends string>(name: string, all: readonly T[]): T[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [...all];
  const wanted = raw.split(',').map((s) => s.trim());
  const unknown = wanted.filter((w) => !(all as readonly string[]).includes(w));
  if (unknown.length > 0) throw new Error(`${name}: unknown value(s) ${unknown.join(', ')}`);
  return all.filter((v) => wanted.includes(v));
}

const themes = listEnv('CENTRATE_CAPTURE_THEMES', THEMES);
const presets = listEnv('CENTRATE_CAPTURE_PRESETS', DISPLAY_PRESET_IDS);
const fixtures = selectedFixtures();

/** PNG size from its IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function shoot(page: Page, file: string, kind: UiWindow): Promise<CaptureShot> {
  if (!OUT) throw new Error('CENTRATE_CAPTURE_OUT is not set');
  const png = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    scale: 'device',
    // The OSD pill and the mini timer's rounded box sit on a transparent window.
    omitBackground: isSurfaceKind(kind) && kind !== 'nuclear',
  });
  writeFileSync(join(OUT, file), png);
  return { file, window: kind, ...pngSize(png) };
}

/** Once the app is up: what Chromium really drew with. Throws outside the stack. */
async function appFont(app: LaunchedApp): Promise<CaptureFont> {
  const rendered = await renderedFonts(app.electron.context(), await app.page('main'));
  const font: CaptureFont = {
    family: rendered.family,
    standsInFor: rendered.standsInFor,
    inStack: rendered.ok,
    weights: rendered.weights,
    source: app.fonts.source,
    platform: process.platform,
  };
  if (!font.inStack && !ANY_FONT) {
    throw new Error(`The app renders in ${font.family} (${font.source}); ${FONT_HELP}.`);
  }
  if (!font.inStack) console.warn(`[capture] NOT the brief's typeface: ${font.family}.`);
  return font;
}

async function capture(
  app: LaunchedApp,
  font: CaptureFont,
  fixture: HarnessFixture,
  theme: CaptureTheme,
  preset: DisplayPresetId,
): Promise<CaptureEntry> {
  await app.harness.load(fixture.id, { display: preset, theme, ...(LANG ? { lang: LANG } : {}) });
  // Surface fixtures (mini timer, OSD, Nuclear) open no detail window: their own window is the
  // shot (`harness.openSurface`), with the main window beside it.
  const surface = isSurfaceKind(fixture.window) ? fixture.window : null;
  const hasDetail = fixture.detailRequest !== null;
  const kinds: WindowKind[] = hasDetail ? ['detail', 'main'] : ['main'];
  let settled = (await settleWindow(app, 'main')).settled;
  if (hasDetail) {
    await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
    settled = (await settleWindow(app, 'detail')).settled && settled;
  }
  const base = `${fixture.id}-${theme}-${preset}`;
  const shots: CaptureShot[] = [];
  if (surface) {
    await app.harness.openSurface(surface);
    const page = await app.surface(surface);
    await waitHarnessReady(page, fixture.id);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    shots.push(await shoot(page, `${base}.png`, surface));
  }
  for (const kind of kinds) {
    const page = await app.page(kind);
    const primary = !surface && kind === (hasDetail ? 'detail' : 'main');
    shots.push(await shoot(page, primary ? `${base}.png` : `${base}.main.png`, kind));
  }
  const main = await app.page('main');
  return {
    state: fixture.id,
    label: fixture.label,
    window: fixture.window,
    theme,
    preset,
    presetLabel: DISPLAY_PRESETS[preset].label,
    scaleFactor: DISPLAY_PRESETS[preset].scaleFactor,
    density: await main.evaluate(() => document.documentElement.dataset['density'] ?? null),
    shots,
    settled,
    font,
  };
}

for (const group of presetsByScale(presets)) {
  test(`capture @${group.scaleFactor}x (${group.presets.join(', ')})`, async ({ apps }) => {
    if (!OUT) throw new Error('Run through scripts/ui-capture.mjs (CENTRATE_CAPTURE_OUT)');
    mkdirSync(OUT, { recursive: true });
    fontPreflight();
    const app = await apps.at(group.scaleFactor);
    const font = await appFont(app);
    const entries: CaptureEntry[] = [];
    for (const preset of group.presets) {
      for (const theme of themes) {
        for (const fixture of fixtures) {
          entries.push(
            await test.step(`${fixture.id} ${theme} ${preset}`, () =>
              capture(app, font, fixture, theme, preset)),
          );
        }
      }
    }
    writeFileSync(
      join(OUT, `manifest.${group.scaleFactor}.json`),
      `${JSON.stringify(entries, null, 2)}\n`,
    );
    const unsettled = entries.filter((e) => !e.settled).map((e) => `${e.state} ${e.preset}`);
    expect(unsettled, 'windows that did not settle before the shot').toEqual([]);
  });
}
