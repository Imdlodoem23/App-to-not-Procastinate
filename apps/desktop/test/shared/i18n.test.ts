import { CATEGORIES } from '@centrate/shared/catalog';
import { emptyTargets } from '@centrate/shared/guardian-api';
import { afterEach, describe, expect, it } from 'vitest';
import { NOTIFY_EN, NOTIFY_ES } from '../../src/main/notifications/i18n';
import { DIAGNOSTICS_EN, DIAGNOSTICS_ES } from '../../src/main/system/i18n';
import { TRAY, TRAY_EN, TRAY_ES, capitalise } from '../../src/main/tray/i18n';
import { WINDOWS_EN, WINDOWS_ES } from '../../src/main/windows/i18n';
import { RENDERER_EN, RENDERER_ES } from '../../src/renderer/src/i18n/messages';
import { BLOQUEO_EN, BLOQUEO_ES } from '../../src/renderer/src/sections/bloqueo/i18n';
import { AJUSTES_EN, AJUSTES_ES } from '../../src/renderer/src/windows/ajustes/i18n';
import { BLOQUEOS_EN, BLOQUEOS_ES } from '../../src/renderer/src/windows/bloqueos/i18n';
import { EMERGENCIA_EN, EMERGENCIA_ES } from '../../src/renderer/src/windows/emergencia/i18n';
import { HARNESS_STATE_IDS, fixtureInLocale, harnessFixture } from '../../src/shared/fixtures';
import {
  MINUS,
  categoryName,
  countdownAria,
  formatClock,
  formatInt,
  formatPoints,
  formatRemaining,
  formatWeekday,
  modeLabel,
  targetsLabel,
} from '../../src/shared/format';
import { SHARED, SHARED_EN, SHARED_ES } from '../../src/shared/i18n';
import {
  activeLocale,
  localized,
  onLocaleChange,
  resolveLocale,
  setActiveLocale,
  systemLocaleFrom,
  withLocale,
} from '../../src/shared/i18n/locale';
import { DEFAULT_TEMPLATES, snapshotLocale, templateLabel } from '../../src/shared/ui-state';

const TABLES: Record<string, readonly [object, object]> = {
  shared: [SHARED_ES, SHARED_EN],
  renderer: [RENDERER_ES, RENDERER_EN],
  bloqueo: [BLOQUEO_ES, BLOQUEO_EN],
  bloqueos: [BLOQUEOS_ES, BLOQUEOS_EN],
  emergencia: [EMERGENCIA_ES, EMERGENCIA_EN],
  ajustes: [AJUSTES_ES, AJUSTES_EN],
  tray: [TRAY_ES, TRAY_EN],
  notify: [NOTIFY_ES, NOTIFY_EN],
  windows: [WINDOWS_ES, WINDOWS_EN],
  diagnostics: [DIAGNOSTICS_ES, DIAGNOSTICS_EN],
};

/** «a.b.c» of every leaf, with its kind (string, function, array). */
function leaves(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, kind] of leaves(child, prefix ? `${prefix}.${key}` : key)) {
        out.set(path, kind);
      }
    }
    return out;
  }
  out.set(prefix, Array.isArray(value) ? 'array' : typeof value);
  return out;
}

/** Every string (and every array item) that is empty or only spaces. */
function blanks(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [prefix] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => blanks(item, `${prefix}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => blanks(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

afterEach(() => setActiveLocale('es'));

describe('language files', () => {
  for (const [name, [es, en]] of Object.entries(TABLES)) {
    it(`${name}: English has exactly the Spanish keys, of the same kind`, () => {
      expect([...leaves(en)].sort()).toEqual([...leaves(es)].sort());
    });

    it(`${name}: no empty strings in either language`, () => {
      expect(blanks(es)).toEqual([]);
      expect(blanks(en)).toEqual([]);
    });
  }

  it('function messages answer non-empty text in English too', () => {
    for (const [name, [, en]] of Object.entries(TABLES)) {
      const walk = (value: unknown, path: string): void => {
        if (typeof value === 'function') {
          const fn = value as (...a: unknown[]) => unknown;
          let out: unknown;
          try {
            out = fn(...Array.from({ length: fn.length }, () => '2'));
          } catch {
            out = fn(...Array.from({ length: fn.length }, () => ['2']));
          }
          if (typeof out === 'string') expect(out.trim(), `${name}.${path}`).not.toBe('');
          return;
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
        }
      };
      walk(en, '');
    }
  });

  it('keeps the Spanish category names equal to the catalog', () => {
    for (const category of CATEGORIES) {
      expect(SHARED_ES.categories[category.id]).toBe(category.name);
    }
  });

  it('gives the English field English examples and hint (the parser reads English)', () => {
    expect(BLOQUEO_EN.field.examples).toHaveLength(BLOQUEO_ES.field.examples.length);
    expect(BLOQUEO_EN.field.examples[0]).toBe('no YouTube for an hour');
    expect(BLOQUEO_EN.field.placeholder('no YouTube')).toBe('e.g. no YouTube');
    expect(BLOQUEO_EN.field.hint).toBe('What do you want to do? Type it and press Enter');
    expect(BLOQUEO_EN.field.hint).not.toContain('Spanish');
    expect(BLOQUEO_ES.field.placeholder('no veo YouTube')).toBe('no veo YouTube');
  });
});

describe('locale resolution', () => {
  it('reads the OS language: en… is English, anything else Spanish', () => {
    expect(systemLocaleFrom(['en-US', 'es-ES'])).toBe('en');
    expect(systemLocaleFrom(['en_GB.UTF-8'])).toBe('en');
    expect(systemLocaleFrom(['EN'])).toBe('en');
    expect(systemLocaleFrom(['es-ES', 'en-US'])).toBe('es');
    expect(systemLocaleFrom(['fr-FR', 'en-US'])).toBe('es');
    expect(systemLocaleFrom(['', 'en-US'])).toBe('en');
    expect(systemLocaleFrom(['eng'])).toBe('es');
    expect(systemLocaleFrom([])).toBe('es');
  });

  it('lets «Idioma» override the system', () => {
    expect(resolveLocale('system', 'en')).toBe('en');
    expect(resolveLocale('system', 'es')).toBe('es');
    expect(resolveLocale('es', 'en')).toBe('es');
    expect(resolveLocale('en', 'es')).toBe('en');
    const fixture = harnessFixture('idle');
    expect(snapshotLocale(fixture.snapshot)).toBe('es');
    expect(snapshotLocale(fixtureInLocale(fixture, 'en').snapshot)).toBe('en');
    expect(
      snapshotLocale({ ...fixture.snapshot, prefs: { ...fixture.snapshot.prefs, language: 'en' } }),
    ).toBe('en');
  });

  it('gives the English fixtures English sample text, keeping everything else', () => {
    const plain = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Array.isArray(value)
        ? value.every(plain)
        : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plain));
    for (const id of HARNESS_STATE_IDS) {
      const fixture = harnessFixture(id);
      // `fixtureInLocale` copies plain data only: anything else would lose its prototype.
      expect(plain(fixture), id).toBe(true);
      const en = JSON.stringify(fixtureInLocale(fixture, 'en'));
      // The emergency preview keeps both phrases: only what the user typed is swapped.
      for (const spanish of [
        'Quiero aprobar',
        '"Acepto romper mi compromiso"',
        'Tardes de estudio',
        '"mates"',
      ]) {
        expect(en, `${id}: ${spanish}`).not.toContain(spanish);
      }
      expect(fixtureInLocale(fixture, 'es')).toEqual(fixture);
    }
    const en = fixtureInLocale(harnessFixture('emergencia'), 'en');
    expect(en.detail.emergencia.phrase).toBe('I accept breaking my commitment');
    expect(en.snapshot.prefs.lastReason).toBe('I want to pass math');
  });

  it('notifies listeners only on a real change', () => {
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setActiveLocale('es');
    setActiveLocale('en');
    setActiveLocale('en');
    setActiveLocale('es');
    off();
    setActiveLocale('en');
    expect(seen).toEqual(['en', 'es']);
    expect(activeLocale()).toBe('en');
  });
});

describe('localized tables', () => {
  it('reads the active locale at access time, at any depth, through module aliases', () => {
    const T = localized({
      es: { a: { b: 'hola', f: (n: number) => `${n} min` }, list: ['x'] },
      en: { a: { b: 'hello', f: (n: number) => `${n} mins` }, list: ['y'] },
    });
    const alias = T.a;
    expect(alias.b).toBe('hola');
    setActiveLocale('en');
    expect(alias.b).toBe('hello');
    expect(alias.f(3)).toBe('3 mins');
    expect(T.list).toEqual(['y']);
    expect(Object.keys(alias)).toEqual(['b', 'f']);
    expect('b' in alias).toBe(true);
    expect(Object.entries(T.a).map(([k]) => k)).toEqual(['b', 'f']);
  });

  it('switches every surface: shared, tray', () => {
    expect(SHARED.modes.strict).toBe('Estricto');
    expect(TRAY.menu.quick).toBe('Bloqueo rápido');
    setActiveLocale('en');
    expect(SHARED.modes.strict).toBe('Strict');
    expect(TRAY.menu.quick).toBe('Quick block');
    expect(capitalise('guardian stopped')).toBe('Guardian stopped');
  });
});

describe('formatting per locale', () => {
  const at1742 = new Date(2026, 8, 28, 17, 42).getTime(); // local time (TZ=Europe/Madrid)

  it('groups numbers with the locale separator and keeps the typographic minus', () => {
    expect(formatInt(1240)).toBe('1.240');
    expect(formatInt(1240000)).toBe('1.240.000');
    withLocale('en', () => {
      expect(formatInt(1240)).toBe('1,240');
      expect(formatInt(-340)).toBe(`${MINUS}340`);
      expect(formatPoints(1240)).toBe('1,240 points');
      expect(formatPoints(1)).toBe('1 point');
      expect(formatPoints(-10, { signed: true })).toBe(`${MINUS}10 points`);
      expect(formatPoints(80, { signed: true })).toBe('+80 points');
    });
  });

  it('shows 24 h in Spanish and the English clock in English', () => {
    expect(formatClock(at1742)).toBe('17:42');
    expect(withLocale('en', () => formatClock(at1742))).toMatch(/^5:42\s?PM$/u);
    expect(withLocale('en', () => formatWeekday(at1742))).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it('says remaining time, modes, categories and targets in the active language', () => {
    withLocale('en', () => {
      expect(formatRemaining(42 * 60_000)).toBe('42 min left');
      expect(countdownAria(65 * 60_000)).toBe('1 hour and 5 minutes left');
      expect(countdownAria(60_000)).toBe('1 minute left');
      expect(modeLabel('exam')).toBe('Exam');
      expect(categoryName('social')).toBe('Social media');
      expect(targetsLabel({ ...emptyTargets(), categoryIds: ['social'] }, false)).toBe(
        'Social media',
      );
      expect(targetsLabel(emptyTargets(), true)).toBe('Everything except the allowlist');
    });
    expect(categoryName('social')).toBe('Redes sociales');
  });

  it('names built-in templates in the app language unless the user renamed them', () => {
    const [deberes] = DEFAULT_TEMPLATES;
    if (!deberes) throw new Error('no built-in template');
    expect(templateLabel(deberes)).toBe('Deberes 1 h');
    expect(withLocale('en', () => templateLabel(deberes))).toBe('Homework 1h');
    const renamed = { ...deberes, label: 'Mates' };
    expect(withLocale('en', () => templateLabel(renamed))).toBe('Mates');
    const mine = { ...deberes, id: 'tpl_abcdef', builtin: false, label: 'Deberes 1 h' };
    expect(withLocale('en', () => templateLabel(mine))).toBe('Deberes 1 h');
  });
});
