/**
 * Command line and environment of the app process (docs/DESKTOP.md §8.1, §10). Pure.
 *
 * Always honoured: `--hidden` (login item: start in the tray).
 *
 * Honoured only when unpackaged (`!app.isPackaged`); a release build ignores all of these:
 * - `--harness-state=<id>` (or `--harness` / `CENTRATE_HARNESS=1`, with the state from
 *   `CENTRATE_HARNESS_STATE`, default `idle`): run on a fixture with the fake guardian and a
 *   frozen clock; renderers load `?window=…&state=<id>`.
 * - `--harness-display=1366x768@125` (or `CENTRATE_HARNESS_DISPLAY`): fake display preset.
 * - `CENTRATE_FAKE_WORKAREA="x,y,w,h"` (or `--harness-workarea=x,y,w,h`): a custom fake work
 *   area in DIP instead of a preset's (capture scripts).
 * - `--harness-theme=light|dark`, `--harness-show` (or `CENTRATE_HARNESS_SHOW=1`).
 * - `--harness-lang=es|en` (or `CENTRATE_HARNESS_LANG`): the fake OS language.
 * - `--harness-neutral-service-icons` (or `CENTRATE_HARNESS_NEUTRAL_ICONS=1`): every service
 *   draws its catalog monogram, never a favicon (marketing captures, PROMPT §11 «Legal»);
 *   renderers load with `?neutral-service-icons=1` (@centrate/shared/service-icon).
 * - `CENTRATE_USER_DATA`, `CENTRATE_DATA_DIR`: isolated userData and guardian sys dir.
 */
import type { ThemeName } from '@centrate/shared/design/tokens';
import { HARNESS_ARGS, HARNESS_ENV } from '../contracts';
import type { Rect } from '../../shared/fixtures';
import { isLocale, type Locale } from '../../shared/i18n/locale';

export const HIDDEN_ARG = '--hidden';
export const HARNESS_FLAG = '--harness';
export const HARNESS_WORKAREA_ARG = '--harness-workarea';
export const HARNESS_NEUTRAL_ICONS_ARG = '--harness-neutral-service-icons';

export const LAUNCH_ENV = Object.freeze({
  harness: 'CENTRATE_HARNESS',
  harnessState: 'CENTRATE_HARNESS_STATE',
  harnessDisplay: 'CENTRATE_HARNESS_DISPLAY',
  harnessShow: 'CENTRATE_HARNESS_SHOW',
  harnessLang: 'CENTRATE_HARNESS_LANG',
  harnessNeutralIcons: 'CENTRATE_HARNESS_NEUTRAL_ICONS',
  fakeWorkArea: 'CENTRATE_FAKE_WORKAREA',
});

/**
 * Harness switches as given. State and display ids are checked against the fixtures by the
 * lazily loaded harness chunk (`harness-setup.ts`), so release code never loads them.
 */
export interface HarnessLaunch {
  stateId: string;
  /** Preset from the command line; `null`: the fixture's own display. */
  display: string | null;
  /** Custom fake work area (DIP); wins over the preset's. */
  fakeWorkArea: Rect | null;
  /** Forced theme; `null`: prefs (`system` in fixtures). */
  theme: ThemeName | null;
  /** Fake OS language; `null`: the fixture's (Spanish). */
  lang: Locale | null;
  /** Start with the main window shown (screenshots). */
  show: boolean;
  /** Services draw their monogram, never a favicon (marketing captures). */
  neutralServiceIcons: boolean;
}

export interface LaunchOptions {
  hidden: boolean;
  harness: HarnessLaunch | null;
  userDataDir: string | null;
  sysDir: string | null;
  /** Arguments that were given but not understood (logged at start). */
  problems: string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/** `--name=value` or `--name value`; `true` for a bare flag; `null` when absent. */
export function argValue(argv: readonly string[], name: string): string | true | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    if (arg === name) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : true;
    }
  }
  return null;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** «x,y,w,h» in DIP (integers, positive size). */
export function parseWorkArea(text: string): Rect | null {
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length !== 4 || parts.some((p) => !/^-?\d+$/.test(p))) return null;
  const [x, y, width, height] = parts.map(Number) as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function isThemeName(value: string): value is ThemeName {
  return value === 'light' || value === 'dark';
}

export function parseLaunchOptions(input: {
  argv: readonly string[];
  env: Env;
  packaged: boolean;
}): LaunchOptions {
  const { argv, env, packaged } = input;
  const hidden = hasFlag(argv, HIDDEN_ARG);
  const problems: string[] = [];
  if (packaged) {
    return { hidden, harness: null, userDataDir: null, sysDir: null, problems };
  }

  const userDataDir = nonEmpty(env[HARNESS_ENV.userData]);
  const sysDir = nonEmpty(env[HARNESS_ENV.sysDir]);

  const stateArg = argValue(argv, HARNESS_ARGS.state);
  const harnessOn =
    typeof stateArg === 'string' || hasFlag(argv, HARNESS_FLAG) || truthy(env[LAUNCH_ENV.harness]);
  if (!harnessOn) return { hidden, harness: null, userDataDir, sysDir, problems };

  const stateId =
    (typeof stateArg === 'string' ? stateArg : null) ??
    nonEmpty(env[LAUNCH_ENV.harnessState]) ??
    'idle';

  const displayArg = argValue(argv, HARNESS_ARGS.display);
  const display =
    (typeof displayArg === 'string' ? displayArg : null) ??
    nonEmpty(env[LAUNCH_ENV.harnessDisplay]);

  const workAreaArg = argValue(argv, HARNESS_WORKAREA_ARG);
  const workAreaText =
    (typeof workAreaArg === 'string' ? workAreaArg : null) ??
    nonEmpty(env[LAUNCH_ENV.fakeWorkArea]);
  let fakeWorkArea: Rect | null = null;
  if (workAreaText !== null) {
    fakeWorkArea = parseWorkArea(workAreaText);
    if (!fakeWorkArea) problems.push(`bad fake work area "${workAreaText}" (want "x,y,w,h")`);
  }

  const themeArg = argValue(argv, HARNESS_ARGS.theme);
  let theme: ThemeName | null = null;
  if (typeof themeArg === 'string') {
    if (isThemeName(themeArg)) theme = themeArg;
    else problems.push(`unknown harness theme "${themeArg}"`);
  }

  const langArg = argValue(argv, HARNESS_ARGS.lang);
  const langText =
    (typeof langArg === 'string' ? langArg : null) ?? nonEmpty(env[LAUNCH_ENV.harnessLang]);
  let lang: Locale | null = null;
  if (langText !== null) {
    if (isLocale(langText)) lang = langText;
    else problems.push(`unknown harness language "${langText}"`);
  }

  const show = hasFlag(argv, HARNESS_ARGS.show) || truthy(env[LAUNCH_ENV.harnessShow]);
  const neutralServiceIcons =
    hasFlag(argv, HARNESS_NEUTRAL_ICONS_ARG) || truthy(env[LAUNCH_ENV.harnessNeutralIcons]);

  return {
    hidden,
    harness: { stateId, display, fakeWorkArea, theme, lang, show, neutralServiceIcons },
    userDataDir,
    sysDir,
    problems,
  };
}
