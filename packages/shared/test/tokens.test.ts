import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accentColors,
  accents,
  colorVars,
  colors,
  composite,
  contrastRatio,
  countdownTracking,
  cssVar,
  durations,
  fontFamily,
  fontSizes,
  interaction,
  lighten,
  mix,
  osd,
  parseHex,
  radii,
  relativeLuminance,
  resolveTheme,
  spacing,
  stateColors,
  toHex,
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
    expect(declared.sort()).toEqual(THEMED.map((t) => colorVars[t]).sort());
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
      expect(a.top).toBe(mix(c[accent], '#FFFFFF', 0.15));
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
  });

  it('static tokens equal tokens.ts', () => {
    const root = block(tokenBlocks, ':root');
    expect(decl(root, '--font-sans').replace(/'/g, '"')).toBe(fontFamily);
    const sizes = [...root.decls.keys()].filter((k) => k.startsWith('--font-size-'));
    expect(sizes).toEqual(fontSizes.map((n) => `--font-size-${n}`));
    for (const n of fontSizes) expect(decl(root, `--font-size-${n}`)).toBe(px(n));
    expect(decl(root, '--tracking-countdown')).toBe(countdownTracking);
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

  it('matches the brief values', () => {
    expect(fontFamily).toBe(
      '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "SF Pro Text", Ubuntu, "Noto Sans", sans-serif',
    );
    expect([...fontSizes]).toEqual([11, 12, 13, 15, 20, 28, 40, 48, 72]);
    expect(radii).toEqual({ sm: 4, md: 6, lg: 8 });
    expect([...spacing]).toEqual([4, 8, 12, 16]);
    expect(durations).toEqual({ hover: 100, fade: 120 });
    expect(colors.dark.redText).toBe('#FF6464');
    expect(colors.dark.onAccent).toBe('#111111');
    expect(colors.light.onAccent).toBe('#FFFFFF');
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

  it('removes the default palette', () => {
    const reset = twBlocks.filter((b) => b.selector === '@theme' && b.decls.has('--color-*'));
    expect(reset).toHaveLength(1);
    expect(reset[0]?.decls.get('--color-*')).toBe('initial');
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
    const sizes = [...b.decls.keys()].filter((k) => k.startsWith('--text-'));
    expect(sizes).toEqual(fontSizes.map((n) => `--text-${n}`));
    for (const n of fontSizes) expect(decl(b, `--text-${n}`)).toBe(px(n));
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

describe('WCAG contrast', () => {
  const surfaces = ['bg', 'tile', 'tile2'] as const;

  describe.each(THEMES)('%s theme', (theme) => {
    const c = colors[theme];

    it.each(['fg', 'fgMuted'] as const)('%s on bg, tile and tile-2 >= 4.5:1', (text) => {
      for (const s of surfaces) expect(contrastRatio(c[text], c[s]), s).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['green', 'blue', 'orange', 'redText'] as const)(
      '%s as text on bg and tile >= 4.5:1',
      (accent) => {
        expect(contrastRatio(c[accent], c.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c[accent], c.tile)).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each(accents)('accentColors(%s).text on bg and tile >= 4.5:1', (accent) => {
      const { text } = accentColors(theme, accent);
      expect(contrastRatio(text, c.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(text, c.tile)).toBeGreaterThanOrEqual(4.5);
    });

    it('control border vs bg and tile >= 3:1', () => {
      expect(contrastRatio(c.control, c.bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(c.control, c.tile)).toBeGreaterThanOrEqual(3);
    });

    it.each(['green', 'blue', 'orange', 'red', 'neutral', 'focusRing'] as const)(
      '%s as outline, bar or dot vs bg and tile >= 3:1',
      (accent) => {
        expect(contrastRatio(c[accent], c.bg)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(c[accent], c.tile)).toBeGreaterThanOrEqual(3);
      },
    );

    it('on-accent text on the blue confirm button >= 4.5:1', () => {
      expect(contrastRatio(c.onAccent, c.blue)).toBeGreaterThanOrEqual(4.5);
    });

    it('fg on hovered and pressed tiles >= 4.5:1', () => {
      for (const bg of Object.values(stateColors(theme))) {
        expect(contrastRatio(c.fg, bg), bg).toBeGreaterThanOrEqual(4.5);
      }
    });
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
