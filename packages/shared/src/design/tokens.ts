/**
 * Céntrate design tokens for TypeScript: Electron main (tray icon colors, BrowserWindow
 * backgroundColor), canvas drawing and inline styles.
 *
 * Values come from PROMPT.md section 10 ("Estilo visual") and mirror `tokens.css` one to one;
 * `test/tokens.test.ts` fails if the two files drift apart, and also checks WCAG contrast.
 * This module has no DOM or Node dependencies, so it runs in every process.
 */

export type ThemeName = 'light' | 'dark';
/** What the user picks in Ajustes: follow the OS, or force a theme. */
export type ThemePreference = ThemeName | 'system';

export interface ThemeColors {
  /** Window background. */
  readonly bg: string;
  /** Tiles and fields. */
  readonly tile: string;
  /** Doors ("…" tiles) and secondary buttons. */
  readonly tile2: string;
  /** Text. */
  readonly fg: string;
  /** Help line and secondary data. */
  readonly fgMuted: string;
  /** Tile border. */
  readonly border: string;
  /** Field and checkbox border (>= 3:1 against bg and tile). */
  readonly control: string;
  /** Focused, completed, guardian OK. */
  readonly green: string;
  /** Normal mode, information, links, sliders, focus. */
  readonly blue: string;
  /** Strict mode, warning, "¿Sigues ahí?", strike. */
  readonly orange: string;
  /** Hardcore, exam, punishment, lost points, camera on, error (fills, bars, outlines). */
  readonly red: string;
  /** Red used as text (the dark `red` is too dim for small text). */
  readonly redText: string;
  /** Selected state for options with no "better" choice (durations, sounds). */
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
 * 20 mini timer and reason on the blocked page · 28 OSD · 40 compact countdown · 48 countdown ·
 * 72 Nuclear countdown.
 */
export const fontSizes = [11, 12, 13, 15, 20, 28, 40, 48, 72] as const;
export type FontSize = (typeof fontSizes)[number];

/** Countdown letter spacing (with `tabular-nums`, weight 600). */
export const countdownTracking = '-0.02em';

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
  /** Selected outline is 15 % lighter on top. */
  selectedTopLighten: 0.15,
  /** Disabled controls. */
  disabledOpacity: 0.45,
  /** Selected outline width in px. */
  selectedWidth: 2,
  /** Focus ring width in px (`:focus-visible` only). */
  focusRingWidth: 2,
} as const;

/** Every token in one object. */
export const tokens = {
  colors,
  osd,
  fontFamily,
  fontSizes,
  countdownTracking,
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
  /** Top edge of the selected outline (15 % lighter). */
  readonly top: string;
  /** Selected tint (accent at 12 % alpha). */
  readonly tint: string;
  /** Accent as text: `redText` for red, `fgMuted` for neutral (neutral is not a text color). */
  readonly text: string;
}

export function accentColors(theme: ThemeName, accent: Accent): AccentColors {
  const c = colors[theme];
  const base = c[accent];
  return {
    base,
    top: lighten(base, interaction.selectedTopLighten),
    tint: withAlpha(base, interaction.selectedTint),
    text: accent === 'red' ? c.redText : accent === 'neutral' ? c.fgMuted : base,
  };
}
