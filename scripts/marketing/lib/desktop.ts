/**
 * The desktop app for marketing captures: the built app in harness mode (fake guardian on a
 * frozen clock, deterministic fixtures) through the e2e launcher, at the scale factor of
 * media.json, with the brief's typeface checked like `npm run capture` does.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThemeName } from '@centrate/shared/design/tokens';
import { launchApp, type LaunchedApp } from '../../../apps/desktop/e2e/support/app';
import { settleWindow } from '../../../apps/desktop/e2e/support/checks';
import { renderedFonts } from '../../../apps/desktop/e2e/support/fonts';
import type { HarnessStateId } from '../../../apps/desktop/src/shared/fixtures';
import type { WindowKind } from '../../../apps/desktop/src/shared/ui-state';
import { CONFIG, LANG } from './config';

const ANY_FONT = process.env['MARKETING_ANY_FONT'] === '1';

/**
 * Chromium switches that make two runs draw the same pixels: sRGB output, no LCD text, no
 * GPU or partial raster (a region repainted after a different previous frame can differ in
 * its antialiasing by one level).
 */
const DETERMINISTIC_ARGS = [
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--disable-gpu',
  '--disable-gpu-rasterization',
  '--disable-partial-raster',
];

/**
 * A GTK configuration with the caret blink off (Chromium on Linux reads `gtk-cursor-blink`):
 * a focused field then always shows its caret, so frames do not depend on the wall clock.
 */
function steadyCaretConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centrate-marketing-gtk-'));
  for (const version of ['gtk-3.0', 'gtk-4.0']) {
    mkdirSync(join(dir, version), { recursive: true });
    writeFileSync(join(dir, version, 'settings.ini'), '[Settings]\ngtk-cursor-blink=false\n');
  }
  return dir;
}

export async function launchDesktop(state: HarnessStateId, theme: ThemeName): Promise<LaunchedApp> {
  const env: Record<string, string> = {};
  if (process.platform === 'linux') env['XDG_CONFIG_HOME'] = steadyCaretConfig();
  return launchApp({
    state,
    show: true,
    theme,
    display: CONFIG.display,
    scaleFactor: CONFIG.scaleFactor,
    args: [`--harness-lang=${LANG}`, ...DETERMINISTIC_ARGS],
    env,
  });
}

/**
 * The family the main window draws its text with. Outside the brief's stack (Segoe UI,
 * Ubuntu, Noto Sans… on Linux through the e2e fontconfig file) it throws, unless
 * `MARKETING_ANY_FONT=1`.
 */
export async function checkFont(app: LaunchedApp): Promise<string> {
  const rendered = await renderedFonts(app.electron.context(), await app.page('main'));
  if (!rendered.ok) {
    const message = `The app renders in ${rendered.family} (${app.fonts.source}); install fonts-noto-core or fonts-ubuntu.`;
    if (!ANY_FONT) throw new Error(message);
    console.warn(`[marketing] ${message}`);
  }
  return rendered.family;
}

/** Waits until the window stopped resizing to its content and fonts are ready. */
export async function settled(app: LaunchedApp, kind: WindowKind = 'main'): Promise<void> {
  const result = await settleWindow(app, kind);
  if (!result.settled) throw new Error(`the ${kind} window did not settle: ${result.detail}`);
}
