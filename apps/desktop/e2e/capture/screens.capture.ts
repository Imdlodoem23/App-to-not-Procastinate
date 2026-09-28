/**
 * Screenshot matrix (PROMPT §10 «Capturas con Playwright»): every harness fixture × {light,
 * dark} × the four display presets, rendered by the real app on the harness's fake display
 * (work area and frame of the preset, `--force-device-scale-factor` of its scale), so the
 * automatic height and density are the ones a user on that screen gets.
 *
 * Run through `npm run capture -w apps/desktop` (scripts/ui-capture.mjs), which sets:
 * - `CENTRATE_CAPTURE=1` (enables this Playwright project) and `CENTRATE_CAPTURE_OUT`;
 * - optional filters `E2E_STATES`, `CENTRATE_CAPTURE_THEMES`, `CENTRATE_CAPTURE_PRESETS`.
 *
 * Output, per shot, in `CENTRATE_CAPTURE_OUT` (docs/ui):
 * - `<state>-<theme>-<w>x<h>@<scale>.png`: the window the state is about (the detail window
 *   for Bloqueos, Emergencia and Ajustes states), at device pixels;
 * - `<state>-<theme>-<w>x<h>@<scale>.main.png`: for detail states, the main window beside it;
 * - `manifest.<scale>.json`: what this worker wrote (merged into manifest.json by the script).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  DISPLAY_PRESETS,
  DISPLAY_PRESET_IDS,
  type DisplayPresetId,
  type HarnessFixture,
} from '../../src/shared/fixtures';
import type { WindowKind } from '../../src/shared/ui-state';
import type { LaunchedApp } from '../support/app';
import { settleWindow } from '../support/checks';
import { THEMES, presetsByScale, selectedFixtures, type CaptureTheme } from '../support/matrix';
import { expect, test } from '../support/test';

export interface CaptureShot {
  /** File name relative to the output folder. */
  file: string;
  window: WindowKind;
  /** Device pixels. */
  width: number;
  height: number;
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
}

const OUT = process.env['CENTRATE_CAPTURE_OUT'];

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

async function shoot(page: Page, file: string, kind: WindowKind): Promise<CaptureShot> {
  if (!OUT) throw new Error('CENTRATE_CAPTURE_OUT is not set');
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' });
  writeFileSync(join(OUT, file), png);
  return { file, window: kind, ...pngSize(png) };
}

async function capture(
  app: LaunchedApp,
  fixture: HarnessFixture,
  theme: CaptureTheme,
  preset: DisplayPresetId,
): Promise<CaptureEntry> {
  await app.harness.load(fixture.id, { display: preset, theme });
  const kinds: WindowKind[] = fixture.window === 'main' ? ['main'] : ['detail', 'main'];
  let settled = (await settleWindow(app, 'main')).settled;
  if (fixture.window !== 'main') {
    await expect.poll(async () => (await app.harness.bounds()).detail?.visible).toBe(true);
    settled = (await settleWindow(app, 'detail')).settled && settled;
  }
  const base = `${fixture.id}-${theme}-${preset}`;
  const shots: CaptureShot[] = [];
  for (const kind of kinds) {
    const page = await app.page(kind);
    const primary = kind === (fixture.window === 'main' ? 'main' : 'detail');
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
  };
}

for (const group of presetsByScale(presets)) {
  test(`capture @${group.scaleFactor}x (${group.presets.join(', ')})`, async ({ apps }) => {
    if (!OUT) throw new Error('Run through scripts/ui-capture.mjs (CENTRATE_CAPTURE_OUT)');
    mkdirSync(OUT, { recursive: true });
    const app = await apps.at(group.scaleFactor);
    const entries: CaptureEntry[] = [];
    for (const preset of group.presets) {
      for (const theme of themes) {
        for (const fixture of fixtures) {
          entries.push(
            await test.step(`${fixture.id} ${theme} ${preset}`, () =>
              capture(app, fixture, theme, preset)),
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
