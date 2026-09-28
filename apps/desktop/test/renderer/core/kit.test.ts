import { describe, expect, it } from 'vitest';
import {
  accents,
  colors,
  contrastRatio,
  stateColors,
  type ThemeName,
} from '@centrate/shared/design/tokens';
import { confirmButtonColors, selectedTileTop } from '../../../src/renderer/src/components/colors';
import {
  countdownModel,
  countdownSpeech,
  endsAtMs,
} from '../../../src/renderer/src/components/countdown-model';
import { splitMnemonic } from '../../../src/renderer/src/components/mnemonic';
import { RowHelpRegistry, rowHelpText } from '../../../src/renderer/src/components/row-help';
import { tileVisual } from '../../../src/renderer/src/components/tile-style';
import { RENDERER_ES } from '../../../src/renderer/src/i18n/es';

const THEMES: ThemeName[] = ['light', 'dark'];

describe('tileVisual', () => {
  it('rests on `tile` with hover, no outline', () => {
    expect(tileVisual({})).toEqual({
      surface: 'tile',
      accent: null,
      outline: null,
      tint: false,
      hover: true,
      dim: false,
    });
  });

  it('draws selected as outline + tint, never a solid fill, and stops hover', () => {
    const v = tileVisual({ selected: true, tone: 'orange' });
    expect(v).toMatchObject({ surface: 'tile', accent: 'orange', outline: 'selected', tint: true });
    expect(v.hover).toBe(false);
  });

  it('defaults the selected accent to neutral', () => {
    expect(tileVisual({ selected: true }).accent).toBe('neutral');
  });

  it('puts doors and secondary buttons on tile-2', () => {
    expect(tileVisual({ door: true }).surface).toBe('tile-2');
    expect(tileVisual({ secondary: true }).surface).toBe('tile-2');
  });

  it('arms in red without tint, over a selected state', () => {
    expect(tileVisual({ armed: true, selected: true, tone: 'blue' })).toMatchObject({
      accent: 'red',
      outline: 'armed',
      tint: false,
      hover: false,
    });
  });

  it('dims disabled tiles, keeps their selection outline but no tint or hover', () => {
    expect(tileVisual({ disabled: true })).toMatchObject({ dim: true, hover: false });
    expect(tileVisual({ disabled: true, selected: true, tone: 'blue' })).toMatchObject({
      dim: true,
      outline: 'selected',
      tint: false,
    });
    expect(tileVisual({ disabled: true, armed: true }).outline).toBeNull();
  });
});

describe('colors the kit mixes', () => {
  it.each(THEMES)(
    'keeps the confirm button label at 4.5:1 at rest, hovered and pressed (%s)',
    (theme) => {
      const c = confirmButtonColors(theme);
      for (const bg of [c.rest, c.hover, c.active]) {
        expect(contrastRatio(c.text, bg)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(THEMES)(
    'keeps tile labels at 4.5:1 over the selected tint of every accent (%s)',
    (theme) => {
      for (const accent of accents) {
        expect(
          contrastRatio(colors[theme].fg, selectedTileTop(theme, accent)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(THEMES)('keeps help text readable on the window background (%s)', (theme) => {
    const c = colors[theme];
    expect(contrastRatio(c.fgMuted, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.fg, stateColors(theme).tile2Hover)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('splitMnemonic', () => {
  it('finds the first matching character, case- and accent-insensitively', () => {
    expect(splitMnemonic('Salir', 's')).toEqual({ before: '', key: 'S', after: 'alir' });
    expect(splitMnemonic('Ajustes…', 'a')).toEqual({ before: '', key: 'A', after: 'justes…' });
    expect(splitMnemonic('Más…', 'a')).toEqual({ before: 'M', key: 'á', after: 's…' });
    expect(splitMnemonic('+15 min', '1')).toEqual({ before: '+', key: '1', after: '5 min' });
  });

  it('underlines nothing when the label lacks the letter or there is none', () => {
    expect(splitMnemonic('Reparar', 'z')).toBeNull();
    expect(splitMnemonic('Reparar', undefined)).toBeNull();
    expect(splitMnemonic('Reparar', 'ab')).toBeNull();
  });
});

describe('row help line', () => {
  it('shows the armed consequence, else the active tile, else the row help', () => {
    const registry = new RowHelpRegistry();
    registry.set('a', { text: 'Ayuda A', tone: 'muted', armed: false });
    registry.set('b', { text: null, tone: 'muted', armed: false });
    const fallback = { text: null, tone: 'muted' as const };
    expect(rowHelpText(registry, 'a', fallback)).toEqual({ text: 'Ayuda A', tone: 'muted' });
    expect(rowHelpText(registry, 'b', fallback)).toEqual(fallback);
    expect(rowHelpText(registry, null, fallback)).toEqual(fallback);
    registry.set('c', { text: 'Perderás 620 puntos', tone: 'red', armed: true });
    expect(rowHelpText(registry, 'a', fallback)).toEqual({
      text: 'Perderás 620 puntos',
      tone: 'red',
    });
    registry.delete('c');
    expect(rowHelpText(registry, 'a', fallback).text).toBe('Ayuda A');
  });

  it('notifies subscribers only on real changes', () => {
    const registry = new RowHelpRegistry();
    let calls = 0;
    const off = registry.subscribe(() => {
      calls += 1;
    });
    registry.set('a', { text: 'x', tone: 'muted', armed: false });
    registry.set('a', { text: 'x', tone: 'muted', armed: false });
    registry.set('a', { text: 'y', tone: 'muted', armed: false });
    registry.delete('missing');
    registry.delete('a');
    expect(calls).toBe(3);
    expect(registry.getVersion()).toBe(3);
    off();
    registry.set('a', { text: 'z', tone: 'muted', armed: false });
    expect(calls).toBe(3);
  });
});

describe('countdownModel', () => {
  const end = Date.parse('2026-09-28T15:42:10.000Z');

  it('is endsAt − now, rounded up, with the seconds apart', () => {
    const m = countdownModel('2026-09-28T15:42:10.000Z', end - (42 * 60 + 10) * 1000 + 300);
    expect(m.parts).toEqual({ lead: '42', seconds: ':10', text: '42:10' });
    expect(m.aria).toBe('Quedan 43 minutos');
    expect(m.nextDelayMs).toBeGreaterThan(0);
    expect(endsAtMs(end)).toBe(end);
  });

  it('switches to H:MM:SS from one hour and stops at 0:00', () => {
    expect(countdownModel(end, end - (2 * 3600 + 10 * 60 + 5) * 1000).parts.text).toBe('2:10:05');
    const done = countdownModel(end, end + 5);
    expect(done.parts.text).toBe('0:00');
    expect(done.nextDelayMs).toBeNull();
  });

  it('shows every second of an hour, in order and on time, with late timers', () => {
    // The one-setTimeout loop, each timer firing 0–40 ms late.
    let now = end - 3600 * 1000 + 17;
    const shownSeconds: number[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const m = countdownModel(end, now);
      shownSeconds.push(Math.ceil(Math.max(0, m.remainingMs) / 1000));
      if (m.nextDelayMs === null) break;
      // Each wake lands just after a displayed-second boundary (epsilon + lateness ≤ 44 ms).
      if (i > 0 && m.remainingMs > 0) {
        const sinceBoundary = (1000 - (m.remainingMs % 1000)) % 1000;
        expect(sinceBoundary).toBeLessThanOrEqual(50);
      }
      now += m.nextDelayMs + (i % 5) * 10;
    }
    expect(shownSeconds[0]).toBe(3600);
    expect(shownSeconds[shownSeconds.length - 1]).toBe(0);
    for (let i = 1; i < shownSeconds.length; i += 1) {
      expect(shownSeconds[i]).toBe((shownSeconds[i - 1] ?? 0) - 1);
    }
  });

  it('speaks only at 15, 5 and 1 min and at the end, never on the first render', () => {
    expect(countdownSpeech(null, 5 * 60_000)).toBeNull();
    expect(countdownSpeech(15 * 60_000 + 500, 15 * 60_000 - 500)).toBe('Quedan 15 minutos');
    expect(countdownSpeech(14 * 60_000, 13 * 60_000)).toBeNull();
    expect(countdownSpeech(61_000, 59_000)).toBe('Queda 1 minuto');
    expect(countdownSpeech(400, -10)).toBe('Bloqueo terminado');
  });
});

describe('renderer copy', () => {
  it('builds door and armed labels', () => {
    expect(RENDERER_ES.kit.door('Más')).toBe('Más…');
    expect(RENDERER_ES.kit.door('Detalles…')).toBe('Detalles…');
    expect(RENDERER_ES.kit.armed('Desbloquear')).toBe('¿Seguro? Desbloquear');
  });

  it('keeps footer and warning mnemonics unique', () => {
    const letters = [
      ...Object.values(RENDERER_ES.protection.mnemonics),
      ...Object.values(RENDERER_ES.footer.mnemonics),
    ];
    expect(new Set(letters).size).toBe(letters.length);
  });
});
