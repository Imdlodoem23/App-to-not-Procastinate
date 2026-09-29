/**
 * The pages' two languages: the English table has exactly the Spanish one's shape, the
 * language follows the browser's UI language (`en*` → English, anything else Spanish), the
 * formatters follow it, and the manifest's store texts exist in both `_locales`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { untilLabel } from '@centrate/shared/parser/format';
import { blockedView } from '../../src/pages/blocked/model';
import {
  PAGES,
  PAGES_EN,
  PAGES_ES,
  applyDocumentLanguage,
  browserUiLanguage,
  detectLocale,
  intlTag,
  localeFromLanguage,
  pagesIntlTag,
  pagesLocale,
  setPagesLocale,
  withPagesLocale,
} from '../../src/pages/i18n';
import { blockSection, popupTimes } from '../../src/pages/popup/model';
import {
  countdownAnnouncement,
  countdownAria,
  formatClock,
  formatDayMonth,
  formatInt,
  formatPoints,
  formatRemaining,
  formatRemainingProse,
  formatUntil,
} from '../../src/pages/shared/format';
import { pairErrorText } from '../../src/pages/shared/pairing-form';
import { connectionLine, noticesFor, retryResult } from '../../src/pages/shared/status';
import { MIN, NOW, ruleBlock, snapshot, tabInfo } from './fixtures';

const ROOT = join(import.meta.dirname, '../..');

type Shape = string | { [key: string]: Shape } | Shape[];

/** The table's structure: leaf types, keys at every depth and array lengths. */
function shape(value: unknown): Shape {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'function') return `function/${value.length}`;
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, shape(v)]),
    );
  }
  return typeof value;
}

afterEach(() => {
  setPagesLocale('es');
  vi.unstubAllGlobals();
});

describe('message tables', () => {
  it('English has exactly the Spanish keys, leaf types and list lengths', () => {
    expect(shape(PAGES_EN)).toEqual(shape(PAGES_ES));
  });

  it('every function answers in both languages with the same arguments', () => {
    const ctx = { name: 'YouTube', inlineName: 'YouTube', time: '43 min' };
    for (const table of [PAGES_ES, PAGES_EN]) {
      expect(table.blocked.humor.map((line) => typeof line(ctx))).toEqual(
        PAGES_ES.blocked.humor.map(() => 'string'),
      );
      expect(table.common.privateName(null)).toBeTypeOf('string');
    }
  });

  it('the shortcut letters are letters of their tile label', () => {
    for (const table of [PAGES_ES, PAGES_EN]) {
      const b = table.blocked;
      expect(b.back.toUpperCase()).toContain(b.shortcuts.back);
      expect(b.open('YouTube').toUpperCase()).toContain(b.shortcuts.open);
      expect(b.shortcuts.back).toMatch(/^[A-Z]$/);
      expect(b.shortcuts.open).toMatch(/^[A-Z]$/);
    }
  });
});

describe('language', () => {
  it('English for any en* UI language, Spanish for everything else', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'en_US', 'EN-au']) {
      expect(localeFromLanguage(tag)).toBe('en');
    }
    for (const tag of ['es', 'es-ES', 'es-419', 'ca', 'fr-FR', 'eng', 'enx', '', null, undefined]) {
      expect(localeFromLanguage(tag)).toBe('es');
    }
    expect(intlTag('en')).toBe('en-US');
    expect(intlTag('es')).toBe('es-ES');
  });

  it('reads chrome.i18n.getUILanguage(), and falls back to Spanish without it', () => {
    expect(browserUiLanguage()).toBeNull();
    expect(detectLocale()).toBe('es');
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'en-GB' } });
    expect(browserUiLanguage()).toBe('en-GB');
    expect(detectLocale()).toBe('en');
    vi.stubGlobal('chrome', { i18n: { getUILanguage: () => 'es-419' } });
    expect(detectLocale()).toBe('es');
    vi.stubGlobal('chrome', {
      i18n: {
        getUILanguage: () => {
          throw new Error('no i18n here');
        },
      },
    });
    expect(detectLocale()).toBe('es');
    vi.stubGlobal('chrome', { runtime: {} });
    expect(detectLocale()).toBe('es');
  });

  it('the pages start in Spanish outside a browser, and switch as one', () => {
    expect(pagesLocale()).toBe('es');
    expect(PAGES).toBe(PAGES_ES);
    setPagesLocale('en');
    expect(PAGES).toBe(PAGES_EN);
    expect(pagesIntlTag()).toBe('en-US');
    expect(withPagesLocale('es', () => PAGES.status.connected)).toBe('Guardián conectado');
    expect(PAGES.status.connected).toBe('Guardian connected');
  });

  it('sets <html lang> from the active locale', () => {
    const root = { lang: 'es' };
    withPagesLocale('en', () => applyDocumentLanguage(root));
    expect(root.lang).toBe('en');
    applyDocumentLanguage(root);
    expect(root.lang).toBe('es');
  });

  it('every page script sets its language before rendering', () => {
    for (const page of ['blocked', 'popup', 'options']) {
      const source = readFileSync(join(ROOT, `src/pages/${page}/main.ts`), 'utf8');
      expect(source, page).toContain('applyDocumentLanguage();');
      expect(source, page).not.toMatch(/i18n\/es'/);
    }
  });
});

describe('formatting in English', () => {
  const en = <T>(fn: () => T): T => withPagesLocale('en', fn);

  it('groups thousands in en-US and keeps the typographic minus', () => {
    expect(en(() => formatInt(1240))).toBe('1,240');
    expect(en(() => formatInt(-1240))).toBe('−1,240');
    expect(en(() => formatPoints(-10))).toBe('−10 points');
    expect(en(() => formatPoints(-1))).toBe('−1 point');
    expect(en(() => formatPoints(80, { signed: true }))).toBe('+80 points');
    // Spanish is untouched by an English render in between.
    expect(formatInt(1240)).toBe('1.240');
    expect(formatPoints(-10)).toBe('−10 puntos');
  });

  it('says the time left in English words', () => {
    expect(en(() => formatRemaining(42 * MIN + 10_000))).toBe('43 min left');
    expect(en(() => formatRemaining(65 * MIN))).toBe('1 h 5 min left');
    expect(en(() => countdownAria(42 * MIN + 1))).toBe('43 minutes left');
    expect(en(() => countdownAria(30_000))).toBe('1 minute left');
    expect(en(() => countdownAria(60 * MIN))).toBe('1 hour left');
    expect(en(() => countdownAria(65 * MIN))).toBe('1 hour and 5 minutes left');
    expect(en(() => formatRemainingProse(125 * MIN))).toBe('2 hours and 5 minutes');
    expect(en(() => countdownAnnouncement(15 * MIN + 1, 15 * MIN))).toBe('15 minutes left');
    expect(en(() => countdownAnnouncement(MIN + 1, MIN - 1))).toBe('1 minute left');
  });

  it('uses a 12 h clock and month/day dates in English, 24 h and day/month in Spanish', () => {
    const at = new Date(2026, 8, 28, 17, 42).getTime();
    expect(en(() => formatClock(at))).toMatch(/^5:42\sPM$/);
    expect(formatClock(at)).toBe('17:42');
    expect(en(() => formatDayMonth(at))).toBe('9/28');
    expect(formatDayMonth(at)).toBe('28/9');
  });

  it('writes «until …» like the app in English', () => {
    const now = new Date(2026, 8, 28, 16, 0).getTime();
    const at = (d: number, h: number, m = 0): number => new Date(2026, 8, d, h, m).getTime();
    expect(en(() => formatUntil(at(28, 17, 42), now))).toMatch(/^until 5:42\sPM$/);
    expect(en(() => formatUntil(at(29, 8), now))).toMatch(/^until tomorrow 8:00\sAM$/);
    expect(en(() => formatUntil(at(30, 8), now))).toMatch(/^until 9\/30 8:00\sAM$/);
    // The midnight that ends today reads as today.
    expect(en(() => formatUntil(at(29, 0), now))).toMatch(/^until 12:00\sAM$/);
  });

  it('keeps the parser’s own wording in Spanish (untilLabel)', () => {
    const now = new Date(2026, 8, 28, 16, 0);
    const ends = [
      new Date(2026, 8, 28, 17, 42),
      new Date(2026, 8, 28, 23, 59),
      new Date(2026, 8, 29, 0, 0),
      new Date(2026, 8, 29, 8, 0),
      new Date(2026, 8, 30, 8, 5),
      new Date(2026, 9, 12, 21, 30),
      new Date(2026, 8, 28, 15, 0),
    ];
    for (const end of ends) {
      expect(formatUntil(end.getTime(), now.getTime())).toBe(untilLabel(end, now));
    }
  });
});

describe('pages in English', () => {
  const en = <T>(fn: () => T): T => withPagesLocale('en', fn);

  it('blocked.html: title, time left, points, humor and the tile', () => {
    const view = en(() =>
      blockedView({
        params: { cause: 'domain', serviceId: 'youtube', enforced: false },
        info: tabInfo({ pointsDelta: -10 }),
        snapshot: snapshot(),
        now: NOW,
        humorIndex: 0,
        ready: true,
      }),
    );
    expect(view.title).toBe('YouTube: blocked');
    expect(view.documentTitle).toBe('YouTube: blocked · Céntrate');
    expect(view.headerValue).toBe('43 min left');
    expect(view.remainingLabel).toBe('43 minutes left');
    expect(view.points).toMatchObject({ text: '−10 points', tone: 'red' });
    expect(view.humor).toBe('YouTube will still be there in 43 minutes. Your deadline won’t.');
    expect(view.actionLabel).toBe('Back to my work');
  });

  it('the popup: header, until and rows', () => {
    const state = snapshot({
      blocks: [
        ruleBlock(),
        ruleBlock({ id: 'blk_reddit', mode: 'normal', serviceIds: ['reddit'], domains: [] }),
      ],
    });
    const section = en(() => blockSection(state));
    expect(section?.title).toBe('Block: YouTube · Strict');
    expect(section?.rows.map((row) => row.title)).toEqual(['Reddit · Normal']);
    const times = en(() => popupTimes(section ?? null, NOW));
    expect(times.until).toMatch(/^until \d{1,2}:\d{2}\s[AP]M$/);
    expect(times.rowValues).toEqual(['43 min left']);
    const whitelist = en(() =>
      blockSection(snapshot({ blocks: [ruleBlock({ mode: 'exam', whitelistOnly: true })] })),
    );
    expect(whitelist?.title).toBe('Block: allowlist only · Exam');
  });

  it('status line, warnings with their actions, retries and pairing errors', () => {
    expect(en(() => connectionLine(snapshot()).text)).toBe('Guardian connected');
    const down = snapshot({ link: 'unreachable', problems: ['guardian_unreachable'] });
    const [notice] = en(() => noticesFor(down));
    expect(notice?.text).toBe('Guardian not responding: your blocks stay on until they end.');
    expect(notice?.action).toMatchObject({ kind: 'retry', label: 'Retry' });
    expect(en(() => retryResult(down, NOW)?.notice)).toMatch(
      /^Still not responding · checked at \d{1,2}:\d{2}\s[AP]M$/,
    );
    const incognito = snapshot({
      problems: ['incognito_not_allowed'],
      browser: { family: 'edge', engine: 'chromium', version: '131.0' },
    });
    expect(en(() => noticesFor(incognito)[0]?.text)).toBe(
      'Nothing is blocked in InPrivate windows: allow the extension there.',
    );
    expect(
      en(() => pairErrorText({ ok: false, error: 'code_expired', retryAfterSeconds: null })),
    ).toBe('The code has expired. Get another one in the app with “New code”.');
    // Back in Spanish, the same notice is Spanish again (nothing cached at module load).
    expect(noticesFor(down)[0]?.action).toMatchObject({ label: 'Reintentar' });
  });
});

describe('manifest store texts (_locales)', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public/manifest.json'), 'utf8')) as {
    default_locale?: string;
  } & Record<string, unknown>;
  const messages = (locale: string): Record<string, { message: string; description?: string }> =>
    JSON.parse(readFileSync(join(ROOT, `public/_locales/${locale}/messages.json`), 'utf8'));
  const es = messages('es');
  const en = messages('en');

  it('Spanish is the default locale, and both locales have the same keys', () => {
    expect(manifest.default_locale).toBe('es');
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it('every __MSG_…__ in the manifest exists in both locales', () => {
    const used = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
    expect(used).toContain('extName');
    expect(used).toContain('extDescription');
    for (const key of used) {
      expect(es[key as string]?.message, `es ${key}`).toBeTruthy();
      expect(en[key as string]?.message, `en ${key}`).toBeTruthy();
    }
  });

  it('the product name stays «Céntrate» and descriptions fit the stores (132 characters)', () => {
    expect(es['extName']?.message).toBe('Céntrate');
    expect(en['extName']?.message).toBe('Céntrate');
    for (const table of [es, en]) {
      expect(table['extDescription']?.message.length).toBeLessThanOrEqual(132);
    }
    expect(en['extDescription']?.message.replaceAll('Céntrate', '')).not.toMatch(/[áéíóúñ¿¡«»]/);
  });
});
