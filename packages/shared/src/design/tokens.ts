/**
 * Céntrate design tokens for TypeScript: Electron main (tray icon colors, BrowserWindow
 * backgroundColor), canvas drawing and inline styles.
 *
 * Values come from PROMPT.md section 10 ("Estilo visual") and mirror `tokens.css` one to one;
 * `test/tokens.test.ts` fails if the two files drift apart, and also checks WCAG contrast.
 * This module has no DOM or Node dependencies, so it runs in every process.
 *
 * Where each color may go (every pair below is checked in both themes by test/tokens.test.ts;
 * anything else drops under the brief's minimums in at least one theme):
 * - Text (>= 4.5:1): `fg` on every surface, hovered and pressed tiles included. `fgMuted` on
 *   `bg`, `tile` and `tile2`. Accent text (`green`, `blue`, `orange`, `redText`,
 *   `accentColors().text`) on `bg` and `tile` only: on light `tile2` it falls under 4.5:1.
 *   Labels inside tiles and buttons are always `fg` (the selected state never recolors text).
 * - Control borders (>= 3:1): `control` on `bg` and `tile` only. Fields and checkboxes never sit
 *   on `tile2` (2.69:1 in light) or on a hovered or pressed tile.
 * - Outlines, bars and dots (>= 3:1): the accents and `focusRing` on `bg`, `tile`, `tile2` and
 *   hovered tiles; `focusRing` also on pressed tiles. Draw the focus ring with
 *   `interaction.focusRingOffset` so it sits on the background, not on a filled blue button.
 * - A tile with an accent outline (selected, or the red «¿Seguro?» state) keeps its resting
 *   background: no hover or pressed mix. Hovered, the dark red outline would fall to 2.97:1
 *   against its tinted interior, and to 2.79:1 against a pressed tile.
 */

export type ThemeName = 'light' | 'dark';
/** What the user picks in Ajustes: follow the OS, or force a theme. */
export type ThemePreference = ThemeName | 'system';

export interface ThemeColors {
  /** Window background. */
  readonly bg: string;
  /** Tiles and fields. */
  readonly tile: string;
  /** Doors ("…" tiles) and secondary buttons. Only `fg`/`fgMuted` text on it (see the header). */
  readonly tile2: string;
  /** Text. */
  readonly fg: string;
  /** Help line and secondary data, outside tiles. */
  readonly fgMuted: string;
  /** Tile border. */
  readonly border: string;
  /** Field and checkbox border (>= 3:1 against bg and tile; never on tile-2 or tile states). */
  readonly control: string;
  /** Focused, completed, guardian OK. */
  readonly green: string;
  /** Normal mode, information, links, sliders, focus. */
  readonly blue: string;
  /** Strict mode, warning, "¿Sigues ahí?", strike. */
  readonly orange: string;
  /**
   * Hardcore, exam, punishment, lost points, camera on, error (fills, bars, outlines, icons).
   * Not a text color: dark `red` is 3.54:1 on `tile`. Text uses `redText`.
   */
  readonly red: string;
  /** Red used as text (the dark `red` is too dim for small text). */
  readonly redText: string;
  /**
   * Selected state for options with no "better" choice (durations, sounds). Outline only, never
   * text: light `neutral` is 3.99:1 on `bg`.
   */
  readonly neutral: string;
  /** Text on the filled blue confirm button. */
  readonly onAccent: string;
  /** Focus ring (always `blue`). */
  readonly focusRing: string;
}

export type ColorToken = keyof ThemeColors;

const DARK_BLUE = '#3AAEEF';
const LIGHT_BLUE = '#0A6AA8';

/** Theme colors. Dark values are G-Helper's; see PROMPT.md section 10. */
export const colors = {
  light: {
    bg: '#F0F0F0',
    tile: '#FFFFFF',
    tile2: '#E3E3E3',
    fg: '#1A1A1A',
    fgMuted: '#5C5C5C',
    border: '#DCDCDC',
    control: '#8A8A8A',
    green: '#047857',
    blue: LIGHT_BLUE,
    orange: '#A34700',
    red: '#C81E1E',
    redText: '#C81E1E',
    neutral: '#767676',
    onAccent: '#FFFFFF',
    focusRing: LIGHT_BLUE,
  },
  dark: {
    bg: '#1C1C1C',
    tile: '#2E2E2E',
    tile2: '#242424',
    fg: '#F0F0F0',
    fgMuted: '#A8A8A8',
    border: '#373737',
    control: '#7A7A7A',
    green: '#06B48A',
    blue: DARK_BLUE,
    orange: '#FF8000',
    red: '#FF2020',
    redText: '#FF6464',
    neutral: '#A8A8A8',
    onAccent: '#111111',
    focusRing: DARK_BLUE,
  },
} as const satisfies Readonly<Record<ThemeName, ThemeColors>>;

/** CSS custom property that holds each color token in `tokens.css`. */
export const colorVars = {
  bg: '--bg',
  tile: '--tile',
  tile2: '--tile-2',
  fg: '--fg',
  fgMuted: '--fg-muted',
  border: '--border',
  control: '--control',
  green: '--green',
  blue: '--blue',
  orange: '--orange',
  red: '--red',
  redText: '--red-text',
  neutral: '--neutral',
  onAccent: '--on-accent',
  focusRing: '--focus-ring',
} as const satisfies Readonly<Record<ColorToken, `--${string}`>>;

/** `var(--token)` for inline styles, e.g. `style={{ borderColor: cssVar('control') }}`. */
export function cssVar(token: ColorToken): string {
  return `var(${colorVars[token]})`;
}

/** Big on-screen display (OSD): black pill at 60 % with white text, in both themes. */
export const osd = {
  bg: '#00000099',
  fg: '#FFFFFF',
} as const;

/** The four accents plus `neutral`, each with one meaning across the app. */
export const accents = ['green', 'blue', 'orange', 'red', 'neutral'] as const;
export type Accent = (typeof accents)[number];

/** Font stack: system fonts only, nothing is downloaded. */
export const fontFamily =
  '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Ubuntu, "Noto Sans", sans-serif';

/**
 * Font sizes in px: 11 pills · 12 help line and footer · 13 almost everything · 15 main field ·
 * 20 mini timer and reason on the blocked page · 28 OSD · 32 pairing code (onboarding) ·
 * 40 compact countdown · 48 countdown · 72 Nuclear countdown.
 */
export const fontSizes = [11, 12, 13, 15, 20, 28, 32, 40, 48, 72] as const;
export type FontSize = (typeof fontSizes)[number];

/**
 * Line height in px for each font size (even values); the countdowns (40, 48, 72) are set
 * solid so their row is exactly as tall as the digits.
 */
export const lineHeights = {
  11: 16,
  12: 16,
  13: 18,
  15: 20,
  20: 24,
  28: 32,
  32: 40,
  40: 40,
  48: 48,
  72: 72,
} as const satisfies Readonly<Record<FontSize, number>>;

/** Font weights: 400 for body text, 600 for titles, pills, the countdown and the OSD. */
export const fontWeights = { normal: 400, semibold: 600 } as const;

/** Countdown letter spacing (with `tabular-nums`, weight 600). */
export const countdownTracking = '-0.02em';

/**
 * Opacity of the countdown seconds. Over `bg` that is 4.35:1 in light: fine for 40–72 px digits
 * (large text needs 3:1), so keep it to the countdown.
 */
export const countdownSecondsOpacity = 0.6;

/** Icon sizes in px (lucide-react, `currentColor`): 16 headers and footer · 20 tiles · 24 empty states. */
export const iconSizes = { header: 16, tile: 20, empty: 24 } as const;

/** Icon stroke width (lucide-react `strokeWidth`). */
export const iconStroke = 1.75;

/** Fixed component sizes in px. The regular tile height and the countdown depend on `density`. */
export const sizes = {
  /** Section header row (16 px icon, 13 px title). */
  header: 20,
  /** Progreso's doors (Estadísticas… | Recompensas… | Logros…). */
  tileDoor: 40,
  /** Text-only tiles and the footer's secondary buttons. */
  tileText: 32,
  /** Main field «¿Qué quieres hacer?». */
  field: 44,
  /** Rows of the extra blocks under the big countdown. */
  blockRow: 28,
  /** Ajustes rows. */
  settingsRow: 48,
  /** Minimum click target (width and height). */
  minTarget: 32,
  /** Tile and field border width. */
  border: 1,
  /** Bar under the countdown, in the color of the mode. */
  modeBar: 3,
  /** Study Mode meter. */
  meter: 6,
  /** Daily goal bar in Progreso. */
  goalBar: 4,
  /** Status dots (footer, strikes, camera). */
  statusDot: 8,
} as const;

export type Density = 'regular' | 'compact';

/**
 * Sizes that change with density. The main window switches to compact on its own when its
 * content does not fit: 40 px tiles with the icon left of the label, 40 px countdown, 8 px
 * between sections. `[data-density='compact']` in tokens.css.
 */
export const density = {
  regular: { tileHeight: 56, countdownSize: 48, sectionGap: 12 },
  compact: { tileHeight: 40, countdownSize: 40, sectionGap: 8 },
} as const satisfies Readonly<
  Record<Density, { tileHeight: number; countdownSize: FontSize; sectionGap: number }>
>;

/** Window layout in px (DIP). The CSS side (tokens.css) mirrors the first four. */
export const layout = {
  /** Main window width; also the column of blocked.html and the extension popup. */
  mainWidth: 440,
  /** Detail windows (what the doors open). */
  detailWidth: 600,
  /** Side margin inside every window. */
  margin: 12,
  /** Gap between tiles in a row. */
  tileGap: 4,
  /** Minimum height of a detail window. */
  detailMinHeight: 480,
  /** Gap between the main window and a detail window. */
  detailGap: 6,
  /** Distance from the edges of the tray display's work area. */
  screenInset: 10,
  /** Content height targets: at rest and in any state. */
  restMaxHeight: 540,
  maxHeight: 600,
  /** Mini timer window. */
  miniTimer: { width: 180, height: 44 },
  /** OSD distance from the bottom of the screen. */
  osdBottom: 300,
} as const;

/** Corner radii in px: sm pills and checkboxes · md tiles and fields · lg OSD and mini timer. */
export const radii = { sm: 4, md: 6, lg: 8 } as const;

/** 4 px grid: `--space-1` … `--space-4`. */
export const spacing = [4, 8, 12, 16] as const;

/** Durations in ms: hover/press background change and state fade. 0 with reduced motion. */
export const durations = { hover: 100, fade: 120 } as const;

/** Interaction constants (fractions, 0–1, and px widths). */
export const interaction = {
  /** Hover: the background moves 4 % toward `fg`. */
  hoverMix: 0.04,
  /** Pressed: 8 % toward `fg`. */
  activeMix: 0.08,
  /** Selected: accent tint at 12 %… */
  selectedTint: 0.12,
  /** …that fades out over the first 20 % of the height. */
  selectedTintStop: 0.2,
  /**
   * Selected outline is 15 % lighter on top, except `neutral` in the light theme (it stays flat:
   * lighter, it falls to 2.99:1 against `bg`). `accentColors()` applies the exception.
   */
  selectedTopLighten: 0.15,
  /** Disabled controls. */
  disabledOpacity: 0.45,
  /** Selected outline width in px. */
  selectedWidth: 2,
  /** Focus ring width in px (`:focus-visible` only). */
  focusRingWidth: 2,
  /**
   * Focus ring offset in px: the ring sits on the background around the control. Without it, the
   * blue ring on the filled blue confirm button would be 1:1.
   */
  focusRingOffset: 2,
} as const;

/** Every token in one object. */
export const tokens = {
  colors,
  osd,
  fontFamily,
  fontSizes,
  lineHeights,
  fontWeights,
  countdownTracking,
  countdownSecondsOpacity,
  iconSizes,
  iconStroke,
  sizes,
  density,
  layout,
  radii,
  spacing,
  durations,
  interaction,
} as const;

// ---------------------------------------------------------------------------------------------
// Color helpers (sRGB, WCAG 2.x)
// ---------------------------------------------------------------------------------------------

/** 8-bit channels plus alpha in 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. Throws on anything else. */
export function parseHex(hex: string): Rgba {
  if (!HEX_RE.test(hex)) throw new TypeError(`Invalid hex color: ${hex}`);
  let digits = hex.slice(1);
  if (digits.length <= 4) digits = Array.from(digits, (d) => d + d).join('');
  const channel = (index: number): number =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: digits.length === 8 ? channel(3) / 255 : 1,
  };
}

function byte(value: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, '0').toUpperCase();
}

/** `#RRGGBB`, or `#RRGGBBAA` when the color is translucent. */
export function toHex(color: Rgba): string {
  const rgb = `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
  return color.a >= 1 ? rgb : `${rgb}${byte(color.a * 255)}`;
}

function assertFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1, got ${value}`);
  }
}

/**
 * Moves `from` toward `to` by `t` (0 = `from`, 1 = `to`), like
 * `color-mix(in srgb, <to> <t*100>%, <from>)` in CSS (premultiplied alpha).
 * Examples: `mix(tile, fg, 0.04)` hover, `mix(tile, fg, 0.08)` pressed, `mix(tile, accent, 0.12)`
 * selected tint over an opaque tile.
 */
export function mix(from: string, to: string, t: number): string {
  assertFraction('t', t);
  const a = parseHex(from);
  const b = parseHex(to);
  const alpha = a.a * (1 - t) + b.a * t;
  if (alpha === 0) return '#00000000';
  const channel = (x: number, y: number): number => (x * a.a * (1 - t) + y * b.a * t) / alpha;
  return toHex({ r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha });
}

/** Mixes toward white: the selected outline is `lighten(accent, 0.15)` on top. */
export function lighten(color: string, amount: number): string {
  return mix(color, '#FFFFFF', amount);
}

/** Same color with another alpha, e.g. `withAlpha(blue, 0.12)` for the selected tint. */
export function withAlpha(color: string, alpha: number): string {
  assertFraction('alpha', alpha);
  return toHex({ ...parseHex(color), a: alpha });
}

/** Paints `top` (possibly translucent) over `bottom` (source-over). */
export function composite(top: string, bottom: string): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  const alpha = t.a + b.a * (1 - t.a);
  if (alpha === 0) return '#00000000';
  const channel = (x: number, y: number): number => (x * t.a + y * b.a * (1 - t.a)) / alpha;
  return toHex({ r: channel(t.r, b.r), g: channel(t.g, b.g), b: channel(t.b, b.b), a: alpha });
}

function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 black – 1 white) of an opaque color. Composite translucent ones first. */
export function relativeLuminance(color: string): number {
  const { r, g, b, a } = parseHex(color);
  if (a < 1) {
    throw new RangeError(`${color} is translucent: composite() it over its background first`);
  }
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two opaque colors, from 1 to 21 (order does not matter). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------------------------

/**
 * Theme actually shown. In Electron main pass `nativeTheme.shouldUseDarkColors`, e.g.
 * `colors[resolveTheme(pref, nativeTheme.shouldUseDarkColors)].bg` for `backgroundColor`.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeName {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/** Hover and pressed backgrounds of tiles, as `tokens.css` computes them with `color-mix()`. */
export interface StateColors {
  readonly tileHover: string;
  readonly tileActive: string;
  readonly tile2Hover: string;
  readonly tile2Active: string;
}

export function stateColors(theme: ThemeName): StateColors {
  const c = colors[theme];
  return {
    tileHover: mix(c.tile, c.fg, interaction.hoverMix),
    tileActive: mix(c.tile, c.fg, interaction.activeMix),
    tile2Hover: mix(c.tile2, c.fg, interaction.hoverMix),
    tile2Active: mix(c.tile2, c.fg, interaction.activeMix),
  };
}

/** What `[data-accent=…]` provides in `tokens.css`. */
export interface AccentColors {
  /** Outline, bar, dot. */
  readonly base: string;
  /** Top edge of the selected outline (15 % lighter; flat for light `neutral`). */
  readonly top: string;
  /** Selected tint (accent at 12 % alpha). */
  readonly tint: string;
  /** Accent as text: `redText` for red, `fgMuted` for neutral (neutral is not a text color). */
  readonly text: string;
}

/**
 * How much lighter the top edge of a selected outline is: `interaction.selectedTopLighten`, or 0
 * for `neutral` in the light theme (`--neutral-top-lighten` in tokens.css).
 */
export function selectedTopLighten(theme: ThemeName, accent: Accent): number {
  return theme === 'light' && accent === 'neutral' ? 0 : interaction.selectedTopLighten;
}

export function accentColors(theme: ThemeName, accent: Accent): AccentColors {
  const c = colors[theme];
  const base = c[accent];
  return {
    base,
    top: lighten(base, selectedTopLighten(theme, accent)),
    tint: withAlpha(base, interaction.selectedTint),
    text: accent === 'red' ? c.redText : accent === 'neutral' ? c.fgMuted : base,
  };
}
