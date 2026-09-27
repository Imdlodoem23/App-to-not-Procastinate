import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accentColors,
  accents,
  colorVars,
  colors,
  composite,
  contrastRatio,
  countdownSecondsOpacity,
  countdownTracking,
  cssVar,
  density,
  durations,
  fontFamily,
  fontSizes,
  fontWeights,
  iconSizes,
  iconStroke,
  interaction,
  layout,
  lighten,
  lineHeights,
  mix,
  osd,
  parseHex,
  radii,
  relativeLuminance,
  resolveTheme,
  selectedTopLighten,
  sizes,
  spacing,
  stateColors,
  toHex,
  tokens,
  withAlpha,
} from '../src/design/tokens';
import type { ColorToken, ThemeName } from '../src/design/tokens';

// ---------------------------------------------------------------------------------------------
// Minimal CSS reader: enough for tokens.css / tailwind-theme.css (no strings with braces).
// ---------------------------------------------------------------------------------------------

interface Block {
  /** Enclosing at-rule preludes, outermost first (e.g. ['@media (prefers-color-scheme: dark)']). */
  readonly context: readonly string[];
  readonly selector: string;
  readonly decls: ReadonlyMap<string, string>;
}

const normalizeSelector = (text: string): string =>
  text
    .replace(/"/g, "'")
    .split(',')
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .join(', ');

function parseCss(source: string): Block[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: Block[] = [];
  const stack: { selector: string; decls: Map<string, string> }[] = [];
  let buffer = '';
  const flush = (): void => {
    const text = buffer.trim();
    buffer = '';
    const top = stack.at(-1);
    const colon = text.indexOf(':');
    if (!top || colon === -1) return;
    top.decls.set(
      text.slice(0, colon).trim(),
      text
        .slice(colon + 1)
        .trim()
        .replace(/\s+/g, ' '),
    );
  };
  for (const ch of css) {
    if (ch === '{') {
      stack.push({ selector: normalizeSelector(buffer), decls: new Map() });
      buffer = '';
    } else if (ch === '}') {
      flush();
      const done = stack.pop();
      if (done) blocks.push({ context: stack.map((s) => s.selector), ...done });
    } else if (ch === ';') {
      flush();
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

function block(blocks: readonly Block[], selector: string, context: readonly string[] = []): Block {
  const wanted = normalizeSelector(selector);
  const found = blocks.filter(
    (b) => b.selector === wanted && b.context.join(' | ') === context.join(' | '),
  );
  expect(found, `exactly one "${wanted}" block in [${context.join(', ')}]`).toHaveLength(1);
  return found[0] as Block;
}

function decl(b: Block, name: string): string {
  const value = b.decls.get(name);
  expect(value, `${b.selector} declares ${name}`).toBeDefined();
  return value ?? '';
}

const read = (file: string): string =>
  readFileSync(new URL(`../src/design/${file}`, import.meta.url), 'utf8');

const tokensCss = read('tokens.css');
const tokenBlocks = parseCss(tokensCss);
const twCss = read('tailwind-theme.css');
const twBlocks = parseCss(twCss);

const THEMES = ['light', 'dark'] as const satisfies readonly ThemeName[];
const MEDIA_DARK = '@media (prefers-color-scheme: dark)';
const MEDIA_FORCED = '@media (forced-colors: active)';
const LIGHT_SELECTOR = ":root, [data-theme='light'], [data-theme='system']";
const DARK_SELECTOR = "[data-theme='dark']";
const SYSTEM_DARK_SELECTOR = ":root:not([data-theme='light']), [data-theme='system']";
const DERIVED_SELECTOR = ':root, [data-theme]';

/** Tokens declared per theme; focusRing is derived (var(--blue)). */
const THEMED = (Object.keys(colorVars) as ColorToken[]).filter((t) => t !== 'focusRing');
const DERIVED_VARS = [
  '--focus-ring',
  '--tile-hover',
  '--tile-active',
  '--tile-2-hover',
  '--tile-2-active',
];
const ACCENT_VARS = ['--accent', '--accent-top', '--accent-tint', '--accent-text'];

const px = (n: number): string => `${n}px`;
const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;
const sameColor = (css: string, ts: string): void =>
  expect(css.toUpperCase()).toBe(ts.toUpperCase());

// ---------------------------------------------------------------------------------------------

describe('tokens.css matches tokens.ts', () => {
  const themeBlocks: [string, ThemeName, Block][] = [
    ['light (:root)', 'light', block(tokenBlocks, LIGHT_SELECTOR)],
    ['dark ([data-theme=dark])', 'dark', block(tokenBlocks, DARK_SELECTOR)],
    ['dark (prefers-color-scheme)', 'dark', block(tokenBlocks, SYSTEM_DARK_SELECTOR, [MEDIA_DARK])],
  ];

  it.each(themeBlocks)('%s colors equal colors.%s', (_label, theme, b) => {
    for (const token of THEMED) sameColor(decl(b, colorVars[token]), colors[theme][token]);
    const declared = [...b.decls.keys()].filter((k) => k.startsWith('--'));
    expect(declared.sort()).toEqual(
      [...THEMED.map((t) => colorVars[t]), '--neutral-top-lighten'].sort(),
    );
    // Light neutral keeps a flat top edge; dark lightens it like every other accent.
    expect(decl(b, '--neutral-top-lighten')).toBe(
      theme === 'light' ? '0%' : 'var(--selected-top-lighten)',
    );
  });

  it('declares color-scheme for native controls', () => {
    expect(decl(block(tokenBlocks, ':root'), 'color-scheme')).toBe('light dark');
    expect(decl(block(tokenBlocks, "[data-theme='system']"), 'color-scheme')).toBe('light dark');
    expect(decl(block(tokenBlocks, "[data-theme='light']"), 'color-scheme')).toBe('light');
    expect(decl(block(tokenBlocks, DARK_SELECTOR), 'color-scheme')).toBe('dark');
  });

  it('focus ring is blue in both files', () => {
    const derived = block(tokenBlocks, DERIVED_SELECTOR);
    expect(decl(derived, '--focus-ring')).toBe('var(--blue)');
    for (const theme of THEMES) expect(colors[theme].focusRing).toBe(colors[theme].blue);
  });

  it('hover and pressed backgrounds use the same mix in CSS and TS', () => {
    const derived = block(tokenBlocks, DERIVED_SELECTOR);
    expect(decl(derived, '--tile-hover')).toBe(
      'color-mix(in srgb, var(--fg) var(--hover-mix), var(--tile))',
    );
    expect(decl(derived, '--tile-active')).toBe(
      'color-mix(in srgb, var(--fg) var(--active-mix), var(--tile))',
    );
    expect(decl(derived, '--tile-2-hover')).toBe(
      'color-mix(in srgb, var(--fg) var(--hover-mix), var(--tile-2))',
    );
    expect(decl(derived, '--tile-2-active')).toBe(
      'color-mix(in srgb, var(--fg) var(--active-mix), var(--tile-2))',
    );
    for (const theme of THEMES) {
      const c = colors[theme];
      expect(stateColors(theme)).toEqual({
        tileHover: mix(c.tile, c.fg, 0.04),
        tileActive: mix(c.tile, c.fg, 0.08),
        tile2Hover: mix(c.tile2, c.fg, 0.04),
        tile2Active: mix(c.tile2, c.fg, 0.08),
      });
    }
  });

  it.each(accents)('[data-accent=%s] matches accentColors()', (accent) => {
    const b = block(tokenBlocks, `[data-accent='${accent}']`);
    expect(decl(b, '--accent')).toBe(`var(--${accent})`);
    const textVar =
      accent === 'red' ? '--red-text' : accent === 'neutral' ? '--fg-muted' : `--${accent}`;
    expect(decl(b, '--accent-text')).toBe(`var(${textVar})`);
    for (const theme of THEMES) {
      const c = colors[theme];
      const a = accentColors(theme, accent);
      expect(a.base).toBe(c[accent]);
      expect(a.text).toBe(
        accent === 'red' ? c.redText : accent === 'neutral' ? c.fgMuted : c[accent],
      );
      const flat = theme === 'light' && accent === 'neutral';
      expect(selectedTopLighten(theme, accent)).toBe(flat ? 0 : 0.15);
      expect(a.top).toBe(flat ? c.neutral : mix(c[accent], '#FFFFFF', 0.15));
      expect(parseHex(a.tint).a).toBeCloseTo(0.12, 2);
    }
  });

  it('[data-accent] derives outline top and tint like accentColors()', () => {
    const b = block(tokenBlocks, '[data-accent]');
    expect(decl(b, '--accent-top').toUpperCase()).toBe(
      'COLOR-MIX(IN SRGB, #FFFFFF VAR(--SELECTED-TOP-LIGHTEN), VAR(--ACCENT))',
    );
    expect(decl(b, '--accent-tint')).toBe(
      'color-mix(in srgb, var(--accent) var(--selected-tint), transparent)',
    );
    // Neutral overrides the top edge with the per-theme amount, so it must come later.
    const neutral = block(tokenBlocks, "[data-accent='neutral']");
    expect(decl(neutral, '--accent-top').toUpperCase()).toBe(
      'COLOR-MIX(IN SRGB, #FFFFFF VAR(--NEUTRAL-TOP-LIGHTEN), VAR(--ACCENT))',
    );
    expect(tokenBlocks.indexOf(neutral)).toBeGreaterThan(tokenBlocks.indexOf(b));
    for (const accent of ['green', 'blue', 'orange', 'red']) {
      expect(block(tokenBlocks, `[data-accent='${accent}']`).decls.has('--accent-top')).toBe(false);
    }
  });

  it('static tokens equal tokens.ts', () => {
    const root = block(tokenBlocks, ':root');
    expect(decl(root, '--font-sans').replace(/'/g, '"')).toBe(fontFamily);
    const fontSizeVars = [...root.decls.keys()].filter((k) => k.startsWith('--font-size-'));
    expect(fontSizeVars).toEqual(fontSizes.map((n) => `--font-size-${n}`));
    for (const n of fontSizes) expect(decl(root, `--font-size-${n}`)).toBe(px(n));
    const lineHeightVars = [...root.decls.keys()].filter((k) => k.startsWith('--line-height-'));
    expect(lineHeightVars).toEqual(fontSizes.map((n) => `--line-height-${n}`));
    for (const n of fontSizes) expect(decl(root, `--line-height-${n}`)).toBe(px(lineHeights[n]));
    expect(Number(decl(root, '--font-weight-normal'))).toBe(fontWeights.normal);
    expect(Number(decl(root, '--font-weight-semibold'))).toBe(fontWeights.semibold);
    expect(decl(root, '--tracking-countdown')).toBe(countdownTracking);
    expect(Number(decl(root, '--countdown-seconds-opacity'))).toBe(countdownSecondsOpacity);
    expect(decl(root, '--icon-size-header')).toBe(px(iconSizes.header));
    expect(decl(root, '--icon-size-tile')).toBe(px(iconSizes.tile));
    expect(decl(root, '--icon-size-empty')).toBe(px(iconSizes.empty));
    expect(Number(decl(root, '--icon-stroke'))).toBe(iconStroke);
    const kebab = (name: string): string => name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
    const sizeVars = [...root.decls.keys()].filter((k) => k.startsWith('--size-'));
    expect(sizeVars).toEqual(Object.keys(sizes).map((k) => `--size-${kebab(k)}`));
    for (const [name, value] of Object.entries(sizes)) {
      expect(decl(root, `--size-${kebab(name)}`)).toBe(px(value));
    }
    expect(decl(root, '--tile-height')).toBe(px(density.regular.tileHeight));
    expect(decl(root, '--countdown-size')).toBe(px(density.regular.countdownSize));
    expect(decl(root, '--section-gap')).toBe(px(density.regular.sectionGap));
    expect(decl(root, '--layout-main-width')).toBe(px(layout.mainWidth));
    expect(decl(root, '--layout-detail-width')).toBe(px(layout.detailWidth));
    expect(decl(root, '--layout-margin')).toBe(px(layout.margin));
    expect(decl(root, '--layout-tile-gap')).toBe(px(layout.tileGap));
    expect(decl(root, '--focus-ring-offset')).toBe(px(interaction.focusRingOffset));
    expect(decl(root, '--radius-sm')).toBe(px(radii.sm));
    expect(decl(root, '--radius-md')).toBe(px(radii.md));
    expect(decl(root, '--radius-lg')).toBe(px(radii.lg));
    spacing.forEach((n, i) => expect(decl(root, `--space-${i + 1}`)).toBe(px(n)));
    expect(decl(root, '--duration-hover')).toBe(`${durations.hover}ms`);
    expect(decl(root, '--duration-fade')).toBe(`${durations.fade}ms`);
    expect(decl(root, '--hover-mix')).toBe(percent(interaction.hoverMix));
    expect(decl(root, '--active-mix')).toBe(percent(interaction.activeMix));
    expect(decl(root, '--selected-tint')).toBe(percent(interaction.selectedTint));
    expect(decl(root, '--selected-tint-stop')).toBe(percent(interaction.selectedTintStop));
    expect(decl(root, '--selected-top-lighten')).toBe(percent(interaction.selectedTopLighten));
    expect(decl(root, '--selected-width')).toBe(px(interaction.selectedWidth));
    expect(decl(root, '--focus-ring-width')).toBe(px(interaction.focusRingWidth));
    expect(Number(decl(root, '--disabled-opacity'))).toBe(interaction.disabledOpacity);
    sameColor(decl(root, '--osd-bg'), osd.bg);
    sameColor(decl(root, '--osd-fg'), osd.fg);
  });

  it('compact density matches density.compact', () => {
    const b = block(tokenBlocks, "[data-density='compact']");
    expect(decl(b, '--tile-height')).toBe(px(density.compact.tileHeight));
    expect(decl(b, '--countdown-size')).toBe(px(density.compact.countdownSize));
    expect(decl(b, '--section-gap')).toBe(px(density.compact.sectionGap));
    expect([...b.decls.keys()].sort()).toEqual([
      '--countdown-size',
      '--section-gap',
      '--tile-height',
    ]);
  });

  it('matches the brief values', () => {
    expect(fontFamily).toBe(
      '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Ubuntu, "Noto Sans", sans-serif',
    );
    // 32 is the pairing code of the onboarding.
    expect([...fontSizes]).toEqual([11, 12, 13, 15, 20, 28, 32, 40, 48, 72]);
    expect(fontWeights).toEqual({ normal: 400, semibold: 600 });
    expect(countdownSecondsOpacity).toBe(0.6);
    expect(iconSizes).toEqual({ header: 16, tile: 20, empty: 24 });
    expect(iconStroke).toBe(1.75);
    expect(sizes).toEqual({
      header: 20,
      tileDoor: 40,
      tileText: 32,
      field: 44,
      blockRow: 28,
      settingsRow: 48,
      minTarget: 32,
      border: 1,
      modeBar: 3,
      meter: 6,
      goalBar: 4,
      statusDot: 8,
    });
    expect(density).toEqual({
      regular: { tileHeight: 56, countdownSize: 48, sectionGap: 12 },
      compact: { tileHeight: 40, countdownSize: 40, sectionGap: 8 },
    });
    expect(layout).toMatchObject({
      mainWidth: 440,
      detailWidth: 600,
      margin: 12,
      tileGap: 4,
      detailMinHeight: 480,
      detailGap: 6,
      screenInset: 10,
      restMaxHeight: 540,
      maxHeight: 600,
      miniTimer: { width: 180, height: 44 },
      osdBottom: 300,
    });
    expect(interaction.focusRingOffset).toBeGreaterThanOrEqual(interaction.focusRingWidth);
    expect(radii).toEqual({ sm: 4, md: 6, lg: 8 });
    expect([...spacing]).toEqual([4, 8, 12, 16]);
    expect(durations).toEqual({ hover: 100, fade: 120 });
    expect(colors.dark.redText).toBe('#FF6464');
    expect(colors.dark.onAccent).toBe('#111111');
    expect(colors.light.onAccent).toBe('#FFFFFF');
  });

  it('text line heights are even and countdowns are set solid', () => {
    for (const n of fontSizes) {
      const lh = lineHeights[n];
      expect(lh, `line height of ${n}`).toBeGreaterThanOrEqual(n);
      expect(lh % 2, `line height of ${n}`).toBe(0);
    }
    for (const n of [40, 48, 72] as const) expect(lineHeights[n]).toBe(n);
    for (const d of Object.values(density)) {
      expect(fontSizes).toContain(d.countdownSize);
      expect(d.tileHeight).toBeGreaterThanOrEqual(sizes.minTarget);
    }
    expect(sizes.tileText).toBeGreaterThanOrEqual(sizes.minTarget);
  });

  it('exposes every group in tokens', () => {
    expect(tokens).toMatchObject({
      lineHeights,
      fontWeights,
      countdownSecondsOpacity,
      iconSizes,
      iconStroke,
      sizes,
      density,
      layout,
    });
  });

  it('drops durations to 0 with reduced motion', () => {
    const b = block(tokenBlocks, ':root', ['@media (prefers-reduced-motion: reduce)']);
    expect(decl(b, '--duration-hover')).toBe('0ms');
    expect(decl(b, '--duration-fade')).toBe('0ms');
  });

  it('maps every color to a system color in forced-colors mode', () => {
    const b = block(tokenBlocks, DERIVED_SELECTOR, [MEDIA_FORCED]);
    const systemColors = /^(Canvas|CanvasText|Highlight|HighlightText) !important$/;
    for (const name of [...THEMED.map((t) => colorVars[t]), '--osd-bg', '--osd-fg']) {
      expect(decl(b, name)).toMatch(systemColors);
    }
    expect(decl(b, '--border')).toBe('CanvasText !important');
    expect(decl(b, '--control')).toBe('CanvasText !important');
  });
});

describe('tailwind-theme.css', () => {
  const inline = block(twBlocks, '@theme inline');
  const statics = twBlocks.filter((b) => b.selector === '@theme' && b.decls.has('--font-sans'));

  it('imports tokens.css and not Tailwind itself', () => {
    const code = twCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/^@import '\.\/tokens\.css';$/m);
    expect(code).not.toMatch(/tailwindcss/);
  });

  it('removes Tailwind defaults outside the design system before declaring the tokens', () => {
    const reset = twBlocks.filter((b) => b.selector === '@theme' && b.decls.has('--color-*'));
    expect(reset).toHaveLength(1);
    const namespaces = [
      '--color-*',
      '--font-*',
      '--font-weight-*',
      '--text-*',
      '--tracking-*',
      '--leading-*',
      '--radius-*',
      '--shadow-*',
      '--inset-shadow-*',
      '--drop-shadow-*',
      '--text-shadow-*',
      '--blur-*',
      '--animate-*',
    ];
    const b = reset[0] as Block;
    expect([...b.decls.keys()].sort()).toEqual([...namespaces].sort());
    for (const ns of namespaces) expect(b.decls.get(ns), ns).toBe('initial');
    // Resets must come first: a later reset would wipe the tokens declared after it.
    const index = twBlocks.indexOf(b);
    for (const other of twBlocks.filter((x) => x.selector.startsWith('@theme') && x !== b)) {
      expect(twBlocks.indexOf(other)).toBeGreaterThan(index);
    }
  });

  it('maps every color token to its tokens.css variable', () => {
    const expected = [
      ...THEMED.map((t) => colorVars[t]),
      ...DERIVED_VARS,
      ...ACCENT_VARS,
      '--osd-bg',
      '--osd-fg',
    ];
    const mapped = [...inline.decls.entries()].filter(([k]) => k.startsWith('--color-'));
    expect(mapped.map(([k]) => k.replace('--color-', '--')).sort()).toEqual([...expected].sort());
    for (const [key, value] of mapped) expect(value).toBe(`var(${key.replace('--color-', '--')})`);
    // Each referenced variable exists in tokens.css.
    const declared = new Set(tokenBlocks.flatMap((b) => [...b.decls.keys()]));
    for (const name of expected) expect(declared.has(name), name).toBe(true);
    expect(decl(inline, '--default-transition-duration')).toBe('var(--duration-hover)');
  });

  it('static values equal tokens.ts', () => {
    expect(statics).toHaveLength(1);
    const b = statics[0] as Block;
    expect(decl(b, '--font-sans').replace(/'/g, '"')).toBe(fontFamily);
    const text = [...b.decls.keys()].filter((k) => k.startsWith('--text-'));
    expect(text).toEqual(fontSizes.flatMap((n) => [`--text-${n}`, `--text-${n}--line-height`]));
    for (const n of fontSizes) {
      expect(decl(b, `--text-${n}`)).toBe(px(n));
      // Without it the size inherits line-height 1.5 (a 72 px row for the 48 px countdown).
      expect(decl(b, `--text-${n}--line-height`)).toBe(px(lineHeights[n]));
    }
    const weights = [...b.decls.keys()].filter((k) => k.startsWith('--font-weight-'));
    expect(weights).toEqual(['--font-weight-normal', '--font-weight-semibold']);
    expect(Number(decl(b, '--font-weight-normal'))).toBe(fontWeights.normal);
    expect(Number(decl(b, '--font-weight-semibold'))).toBe(fontWeights.semibold);
    expect([...b.decls.keys()].filter((k) => k.startsWith('--radius-')).sort()).toEqual([
      '--radius-lg',
      '--radius-md',
      '--radius-osd',
      '--radius-pill',
      '--radius-sm',
      '--radius-tile',
    ]);
    expect(decl(b, '--tracking-countdown')).toBe(countdownTracking);
    expect(decl(b, '--radius-sm')).toBe(px(radii.sm));
    expect(decl(b, '--radius-md')).toBe(px(radii.md));
    expect(decl(b, '--radius-lg')).toBe(px(radii.lg));
    expect(decl(b, '--radius-pill')).toBe(px(radii.sm));
    expect(decl(b, '--radius-tile')).toBe(px(radii.md));
    expect(decl(b, '--radius-osd')).toBe(px(radii.lg));
    expect(decl(b, '--spacing')).toBe(px(spacing[0]));
  });
});

describe('WCAG contrast (usage rules in the header of tokens.ts)', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    const c = colors[theme];
    const st = stateColors(theme);
    const rest = { bg: c.bg, tile: c.tile, tile2: c.tile2 };
    const hovered = { tileHover: st.tileHover, tile2Hover: st.tile2Hover };
    const pressed = { tileActive: st.tileActive, tile2Active: st.tile2Active };

    const expectAtLeast = (
      label: string,
      color: string,
      surfaces: Readonly<Record<string, string>>,
      min: number,
    ): void => {
      for (const [name, surface] of Object.entries(surfaces)) {
        expect(contrastRatio(color, surface), `${label} on ${name}`).toBeGreaterThanOrEqual(min);
      }
    };

    it('fg on every surface, hovered and pressed tiles included, >= 4.5:1', () => {
      expectAtLeast('fg', c.fg, { ...rest, ...hovered, ...pressed }, 4.5);
    });

    it('fgMuted on bg, tile and tile-2 >= 4.5:1', () => {
      expectAtLeast('fgMuted', c.fgMuted, rest, 4.5);
    });

    it.each(['green', 'blue', 'orange', 'redText'] as const)(
      '%s as text on bg and tile >= 4.5:1',
      (accent) => {
        expectAtLeast(accent, c[accent], { bg: c.bg, tile: c.tile }, 4.5);
      },
    );

    it.each(accents)('accentColors(%s).text on bg and tile >= 4.5:1', (accent) => {
      expectAtLeast(accent, accentColors(theme, accent).text, { bg: c.bg, tile: c.tile }, 4.5);
    });

    it('control border on bg and tile >= 3:1', () => {
      expectAtLeast('control', c.control, { bg: c.bg, tile: c.tile }, 3);
    });

    it.each(['green', 'blue', 'orange', 'red', 'neutral', 'focusRing'] as const)(
      '%s as outline, bar or dot on bg, tile, tile-2 and hovered tiles >= 3:1',
      (accent) => {
        expectAtLeast(accent, c[accent], { ...rest, ...hovered }, 3);
      },
    );

    it('focus ring on pressed tiles >= 3:1', () => {
      expectAtLeast('focusRing', c.focusRing, pressed, 3);
    });

    it.each(accents)(
      'selected %s outline (both edges) vs bg and its tinted interior >= 3:1',
      (accent) => {
        const a = accentColors(theme, accent);
        // Selected tiles keep the resting background, so the interior is the tint over `tile`.
        const around = { bg: c.bg, interior: composite(a.tint, c.tile) };
        expectAtLeast(`${accent} outline`, a.base, around, 3);
        expectAtLeast(`${accent} top edge`, a.top, around, 3);
      },
    );

    it('on-accent text on the blue confirm button >= 4.5:1', () => {
      expect(contrastRatio(c.onAccent, c.blue)).toBeGreaterThanOrEqual(4.5);
    });

    it('countdown seconds at 60 % stay >= 3:1 (large text) on bg', () => {
      const seconds = composite(withAlpha(c.fg, countdownSecondsOpacity), c.bg);
      expect(contrastRatio(seconds, c.bg)).toBeGreaterThanOrEqual(3);
      expect(
        Math.min(...Object.values(density).map((d) => d.countdownSize)),
      ).toBeGreaterThanOrEqual(24);
    });
  });

  it('light neutral stays flat on top because 15 % lighter falls under 3:1', () => {
    // Regression: the lightened edge was 2.99:1 against bg and 2.94:1 against its interior.
    const lightened = lighten(colors.light.neutral, interaction.selectedTopLighten);
    expect(contrastRatio(lightened, colors.light.bg)).toBeLessThan(3);
    expect(accentColors('light', 'neutral').top).toBe(colors.light.neutral);
    expect(accentColors('dark', 'neutral').top).toBe(lighten(colors.dark.neutral, 0.15));
  });

  it('OSD text >= 4.5:1 even over a white backdrop', () => {
    expect(contrastRatio(osd.fg, composite(osd.bg, '#FFFFFF'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('color helpers', () => {
  it('parses and prints hex colors', () => {
    expect(parseHex('#3AAEEF')).toEqual({ r: 58, g: 174, b: 239, a: 1 });
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex('#0008')).toEqual({ r: 0, g: 0, b: 0, a: 0x88 / 255 });
    expect(parseHex('#00000099').a).toBeCloseTo(0.6, 5);
    expect(toHex({ r: 58, g: 174, b: 239, a: 1 })).toBe('#3AAEEF');
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.6 })).toBe('#00000099');
    expect(toHex({ r: 300, g: -4, b: 12.6, a: 1 })).toBe('#FF000D');
    for (const bad of ['3AAEEF', '#12', '#12345', '#GGGGGG', 'red', '']) {
      expect(() => parseHex(bad), bad).toThrow(TypeError);
    }
  });

  it('mixes like color-mix(in srgb)', () => {
    expect(mix('#2E2E2E', '#F0F0F0', 0)).toBe('#2E2E2E');
    expect(mix('#2E2E2E', '#F0F0F0', 1)).toBe('#F0F0F0');
    expect(mix('#2E2E2E', '#F0F0F0', 0.04)).toBe('#363636');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    // Premultiplied alpha: mixing with transparent keeps the hue.
    expect(mix('#3AAEEF', '#00000000', 0.88)).toBe(withAlpha('#3AAEEF', 0.12));
    expect(mix('#00000000', '#00000000', 0.5)).toBe('#00000000');
    expect(() => mix('#000', '#fff', 1.2)).toThrow(RangeError);
    expect(() => mix('#000', '#fff', Number.NaN)).toThrow(RangeError);
  });

  it('lightens, sets alpha and composites', () => {
    expect(lighten('#000000', 0.15)).toBe('#262626');
    expect(withAlpha('#3AAEEF', 0.12)).toBe('#3AAEEF1F');
    expect(() => withAlpha('#3AAEEF', -0.1)).toThrow(RangeError);
    expect(composite('#00000099', '#FFFFFF')).toBe('#666666');
    expect(composite('#FF2020', '#1C1C1C')).toBe('#FF2020');
    expect(composite('#00000000', '#00000000')).toBe('#00000000');
  });

  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#3AAEEF', '#3AAEEF')).toBe(1);
    expect(() => relativeLuminance('#00000099')).toThrow(RangeError);
  });

  it('resolves the theme preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('builds var() references', () => {
    expect(cssVar('tile2')).toBe('var(--tile-2)');
    expect(cssVar('fgMuted')).toBe('var(--fg-muted)');
    expect(cssVar('onAccent')).toBe('var(--on-accent)');
  });
});
