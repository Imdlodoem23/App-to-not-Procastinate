// Fixed time zone before any Date is created: clock times are local.
process.env.TZ = 'Europe/Madrid';

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPS,
  CATALOG_NAMES_EN,
  CATEGORIES,
  CATEGORY_IDS,
  SERVICES,
  STUDY_APP_WHITELIST,
  STUDY_WHITELIST,
  appName,
  catalogSnapshot,
  categoryName,
  serviceName,
  studyAppName,
  studySiteName,
} from '../src/catalog';
import {
  DEFAULT_LOCALE,
  LOCALES,
  MINUS,
  SHARED_EN,
  SHARED_ES,
  achievementText,
  formatClock,
  formatDayMonth,
  formatInteger,
  formatSignedInteger,
  intlTag,
  isLocale,
  localeFromLanguage,
  localeFromLanguages,
  sharedMessages,
  toLocale,
  type Locale,
} from '../src/i18n';
import {
  PARSER_EN,
  PARSER_ES,
  PARSER_MESSAGES,
  durationLabel,
  notUnderstoodMessage,
  parseIntent,
  parserMessages,
  untilLabel,
  type ParseResult,
} from '../src/parser';
import {
  ACHIEVEMENTS,
  EMERGENCY_RULES,
  emergencyPhrase,
  emergencyPhraseMatches,
} from '../src/points';

/** Monday 28 September 2026, 16:42 in Madrid (CEST, UTC+2). */
const NOW = new Date(2026, 8, 28, 16, 42);

/** `Intl` may separate «PM» with a narrow no-break space (ICU 72-77): compare with a space. */
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');

/** A value that is not a `Locale`, as untyped callers could pass. */
const NOT_A_LOCALE = 'fr' as unknown as Locale;

/** Words and letters that give a name away as Spanish. */
const SPANISH = /[áéíóúñ¿¡]|\b(?:y|de|del|el|la|los|las|para|con|sin)\b/i;

describe('locale helpers', () => {
  it('knows Spanish and English, Spanish first', () => {
    expect(LOCALES).toEqual(['es', 'en']);
    expect(DEFAULT_LOCALE).toBe('es');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    for (const value of ['EN', 'en-US', 'fr', '', null, undefined, 1]) {
      expect(isLocale(value)).toBe(false);
    }
    expect(toLocale('en')).toBe('en');
    expect(toLocale('fr')).toBe('es');
    expect(toLocale(undefined)).toBe('es');
  });

  it('reads English from any en tag and Spanish from everything else', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'en_US', 'EN', ' en-AU ']) {
      expect(localeFromLanguage(tag)).toBe('en');
    }
    for (const tag of ['es', 'es-ES', 'es-419', 'ca', 'fr-FR', 'eng', 'enx', '', null, undefined]) {
      expect(localeFromLanguage(tag)).toBe('es');
    }
  });

  it('takes the first Spanish or English entry of a language list, Spanish otherwise', () => {
    expect(localeFromLanguages(['', '  ', 'en-US', 'es'])).toBe('en');
    expect(localeFromLanguages([null, 'es-ES', 'en'])).toBe('es');
    // A French or Catalan speaker who also reads English gets English…
    expect(localeFromLanguages(['fr-FR', 'en-US'])).toBe('en');
    expect(localeFromLanguages(['ca-ES', 'en-GB', 'es-ES'])).toBe('en');
    // …and Spanish when Spanish comes first or nothing else matches.
    expect(localeFromLanguages(['ca-ES', 'es-ES', 'en-GB'])).toBe('es');
    expect(localeFromLanguages(['fr-FR', 'de-DE'])).toBe('es');
    expect(localeFromLanguages(['eng', 'enx'])).toBe('es');
    expect(localeFromLanguages([])).toBe('es');
  });

  it('maps locales to Intl tags, es-ES and en-US by default', () => {
    expect(intlTag('es')).toBe('es-ES');
    expect(intlTag('en')).toBe('en-US');
    expect(intlTag()).toBe('es-ES');
    expect(intlTag(NOT_A_LOCALE)).toBe('es-ES');
  });

  it('follows the region of the first language in the locale', () => {
    expect(intlTag('en', ['en-GB', 'en-US'])).toBe('en-GB');
    expect(intlTag('en', 'en_au')).toBe('en-AU');
    expect(intlTag('en', ['es-ES', 'fr-FR', 'en-IN'])).toBe('en-IN');
    expect(intlTag('es', ['en-US', 'es-MX'])).toBe('es-MX');
    expect(intlTag('es', 'es')).toBe('es');
    // Other languages, blanks and tags `Intl` rejects fall back to the default region.
    expect(intlTag('en', ['fr-FR', 'es-ES'])).toBe('en-US');
    expect(intlTag('en', ['en-!!', '', null, undefined])).toBe('en-US');
    expect(intlTag('es', ['english'])).toBe('es-ES');
  });
});

describe('number and clock formatting', () => {
  it('groups thousands in both languages and uses the typographic minus', () => {
    expect(formatInteger(1240)).toBe('1.240');
    expect(formatInteger(1240, 'es')).toBe('1.240');
    expect(formatInteger(1240, 'en')).toBe('1,240');
    expect(formatInteger(-340, 'en')).toBe(`${MINUS}340`);
    expect(formatInteger(-1240.4, 'es')).toBe('−1.240');
    expect(formatInteger(0, 'en')).toBe('0');
    expect(formatInteger(-0.4, 'en')).toBe('0');
    expect(formatInteger(Number.NaN, 'en')).toBe('0');
    expect(formatInteger(Number.POSITIVE_INFINITY)).toBe('0');
    expect(MINUS).toBe('−');
  });

  it('signs points: «+80», «−10», «0»', () => {
    expect(formatSignedInteger(80, 'en')).toBe('+80');
    expect(formatSignedInteger(1240, 'en')).toBe('+1,240');
    expect(formatSignedInteger(-10)).toBe('−10');
    expect(formatSignedInteger(0, 'en')).toBe('0');
  });

  it('uses a 24 h clock in Spanish and the en-US clock in English by default', () => {
    expect(formatClock(new Date(2026, 8, 28, 20, 30))).toBe('20:30');
    expect(formatClock(new Date(2026, 8, 28, 8, 5), 'es')).toBe('08:05');
    expect(formatClock(new Date(2026, 8, 28, 0, 0), 'es')).toBe('00:00');
    expect(plain(formatClock(new Date(2026, 8, 28, 20, 30), 'en'))).toBe('8:30 PM');
    expect(plain(formatClock(new Date(2026, 8, 28, 8, 5), 'en'))).toBe('8:05 AM');
    expect(plain(formatClock(new Date(2026, 8, 28, 0, 0), 'en'))).toBe('12:00 AM');
    expect(plain(formatClock(new Date(2026, 8, 28, 12, 0), 'en'))).toBe('12:00 PM');
  });

  it('follows the region of the user languages', () => {
    const evening = new Date(2026, 8, 30, 20, 30);
    expect(formatClock(evening, 'en', ['en-GB'])).toBe('20:30');
    expect(formatClock(new Date(2026, 8, 30, 8, 5), 'en', 'en-GB')).toBe('08:05');
    expect(plain(formatClock(evening, 'en', 'en-AU'))).toMatch(/^8:30 pm$/i);
    expect(plain(formatClock(evening, 'en', ['fr-FR']))).toBe('8:30 PM');
    // Spanish keeps the 24 h clock in every region; numbers follow the region.
    expect(formatClock(evening, 'es', 'es-MX')).toBe('20:30');
    expect(formatClock(new Date(2026, 8, 30, 8, 5), 'es', 'es-MX')).toBe('08:05');
    expect(formatInteger(1240, 'es', 'es-MX')).toBe('1,240');
    expect(formatInteger(-1240, 'en', 'en-GB')).toBe(`${MINUS}1,240`);
    expect(formatSignedInteger(1240, 'es', ['en-US', 'es-ES'])).toBe('+1.240');
  });

  it('writes day and month in each language and region', () => {
    const day = new Date(2026, 8, 30, 8, 0);
    expect(formatDayMonth(day)).toBe('30/9');
    expect(formatDayMonth(day, 'es')).toBe('30/9');
    expect(formatDayMonth(day, 'en')).toBe('9/30');
    expect(formatDayMonth(day, 'en', 'en-GB')).toBe('30/09');
  });
});

describe('parser labels', () => {
  it('have the same keys in every language', () => {
    expect(Object.keys(PARSER_MESSAGES).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(PARSER_EN).sort()).toEqual(Object.keys(PARSER_ES).sort());
    expect(parserMessages('en')).toBe(PARSER_EN);
    expect(parserMessages()).toBe(PARSER_ES);
    expect(parserMessages(NOT_A_LOCALE)).toBe(PARSER_ES);
  });

  it('durationLabel keeps the short units in English and defaults to Spanish', () => {
    for (const minutes of [0, 5, 45, 59, 60, 90, 120, 1440, 1445]) {
      expect(durationLabel(minutes)).toBe(durationLabel(minutes, 'es'));
    }
    expect(durationLabel(45, 'en')).toBe('45 min');
    expect(durationLabel(120, 'en')).toBe('2 h');
    expect(durationLabel(90, 'en')).toBe('1 h 30 min');
    expect(durationLabel(-3, 'en')).toBe('0 min');
    expect(durationLabel(90, NOT_A_LOCALE)).toBe('1 h 30 min');
  });

  it('untilLabel reads the day and the clock in each language', () => {
    const today = new Date(2026, 8, 28, 20, 30);
    const tomorrow = new Date(2026, 8, 29, 8, 0);
    const later = new Date(2026, 8, 30, 8, 0);
    const midnight = new Date(2026, 8, 29, 0, 0);

    expect(untilLabel(today, NOW)).toBe('hasta 20:30');
    expect(untilLabel(tomorrow, NOW)).toBe('hasta mañana 08:00');
    expect(untilLabel(later, NOW)).toBe('hasta el 30/9 08:00');
    expect(untilLabel(midnight, NOW)).toBe('hasta 00:00');
    expect(untilLabel(later, NOW, NOT_A_LOCALE)).toBe('hasta el 30/9 08:00');

    expect(plain(untilLabel(today, NOW, 'en'))).toBe('until 8:30 PM');
    expect(plain(untilLabel(tomorrow, NOW, 'en'))).toBe('until tomorrow 8:00 AM');
    expect(plain(untilLabel(later, NOW, 'en'))).toBe('until 9/30 8:00 AM');
  });

  it('untilLabel names noon and midnight in English only', () => {
    const midnight = new Date(2026, 8, 29, 0, 0);
    const nextMidnight = new Date(2026, 8, 30, 0, 0);
    const laterMidnight = new Date(2026, 9, 1, 0, 0);
    const noon = new Date(2026, 8, 28, 12, 0);
    const noonTomorrow = new Date(2026, 8, 29, 12, 0);
    const morning = new Date(2026, 8, 28, 9, 0);

    expect(untilLabel(midnight, NOW, 'en')).toBe('until midnight');
    expect(untilLabel(nextMidnight, NOW, 'en')).toBe('until midnight tomorrow');
    expect(untilLabel(noon, morning, 'en')).toBe('until noon');
    expect(untilLabel(noonTomorrow, NOW, 'en')).toBe('until noon tomorrow');
    expect(plain(untilLabel(laterMidnight, NOW, 'en'))).toBe('until 10/1 12:00 AM');

    expect(untilLabel(midnight, NOW)).toBe('hasta 00:00');
    expect(untilLabel(nextMidnight, NOW)).toBe('hasta el 30/9 00:00');
    expect(untilLabel(noon, morning)).toBe('hasta 12:00');
    expect(untilLabel(noonTomorrow, NOW)).toBe('hasta mañana 12:00');
  });

  it('untilLabel follows the region of the user languages', () => {
    const today = new Date(2026, 8, 28, 20, 30);
    const later = new Date(2026, 8, 30, 8, 0);
    expect(untilLabel(today, NOW, 'en', ['en-GB'])).toBe('until 20:30');
    expect(untilLabel(later, NOW, 'en', 'en-GB')).toBe('until 30/09 08:00');
    expect(plain(untilLabel(today, NOW, 'en', ['es-ES', 'en-US']))).toBe('until 8:30 PM');
    expect(untilLabel(today, NOW, 'es', ['es-MX'])).toBe('hasta 20:30');
  });

  it('notUnderstoodMessage quotes each fragment', () => {
    expect(notUnderstoodMessage([])).toBe('');
    expect(notUnderstoodMessage([], 'en')).toBe('');
    expect(notUnderstoodMessage(['mañana tarde'])).toBe('No he entendido: "mañana tarde"');
    expect(notUnderstoodMessage(['mañana tarde', 'xyz'], 'en')).toBe(
      'Not understood: "mañana tarde", "xyz"',
    );
  });
});

describe('parseIntent chip labels', () => {
  const PHRASES = [
    'no veo YouTube en una hora',
    'nada de TikTok ni Instagram durante 45 minutos',
    'bloquea las redes sociales hasta las 20:30',
    'sin juegos hora y media',
    'no quiero ver Netflix 2h',
    'estudiar mates 1 hora',
    'bloquea marca.com y las noticias hasta mañana a las 8',
    'bloquea youtube hasta el miércoles a las 9',
    'redes socales 30 min',
    'mañana tarde',
    'no YouTube for an hour',
    'block social media until 8:30 pm',
    'study math for 1 hour',
    'block TikTok and Instagram until tomorrow at 8',
  ];

  /** The result without chip labels. */
  const withoutLabels = (result: ParseResult): unknown => ({
    ...result,
    chips: result.chips.map(({ label: _label, ...chip }) => chip),
  });

  it('defaults to Spanish: no locale is the same as `es`', () => {
    for (const text of PHRASES) {
      expect(parseIntent(text, { now: NOW })).toEqual(
        parseIntent(text, { now: NOW, locale: 'es' }),
      );
      expect(parseIntent(text, { now: NOW, locale: NOT_A_LOCALE })).toEqual(
        parseIntent(text, { now: NOW }),
      );
    }
  });

  it('only changes the labels in English', () => {
    for (const text of PHRASES) {
      const es = parseIntent(text, { now: NOW });
      const en = parseIntent(text, { now: NOW, locale: 'en' });
      expect(withoutLabels(en)).toEqual(withoutLabels(es));
    }
  });

  it('labels categories, durations and end times in English', () => {
    const social = parseIntent('bloquea las redes sociales hasta las 20:30', {
      now: NOW,
      locale: 'en',
    });
    expect(social.chips.map((chip) => plain(chip.label))).toEqual([
      'Social media',
      'until 8:30 PM',
    ]);

    const news = parseIntent('bloquea marca.com y las noticias hasta mañana a las 8', {
      now: NOW,
      locale: 'en',
    });
    expect(news.chips.map((chip) => plain(chip.label))).toEqual([
      'marca.com',
      'News and sports',
      'until tomorrow 8:00 AM',
    ]);

    const games = parseIntent('sin juegos hora y media', { now: NOW, locale: 'en' });
    expect(games.chips.map((chip) => chip.label)).toEqual(['Games', '1 h 30 min']);

    const services = parseIntent('nada de TikTok ni Instagram durante 45 minutos', {
      now: NOW,
      locale: 'en',
    });
    expect(services.chips.map((chip) => chip.label)).toEqual(['TikTok', 'Instagram', '45 min']);

    // The study task is what the user typed, in any language.
    const study = parseIntent('estudiar mates 1 hora', { now: NOW, locale: 'en' });
    expect(study.chips.map((chip) => chip.label)).toEqual(['mates', '1 h']);
  });

  it('labels English phrases in either language', () => {
    const text = 'block social media and marca.com until tomorrow at 8';
    expect(
      parseIntent(text, { now: NOW, locale: 'en' }).chips.map((chip) => plain(chip.label)),
    ).toEqual(['Social media', 'marca.com', 'until tomorrow 8:00 AM']);
    expect(parseIntent(text, { now: NOW }).chips.map((chip) => chip.label)).toEqual([
      'Redes sociales',
      'marca.com',
      'hasta mañana 08:00',
    ]);
    const midnight = parseIntent('no games until midnight', { now: NOW, locale: 'en' });
    expect(midnight.chips.map((chip) => chip.label)).toEqual(['Games', 'until midnight']);
  });

  it('writes end times in the region of `languages`', () => {
    const text = 'no YouTube until 8:30 pm';
    const british = parseIntent(text, { now: NOW, locale: 'en', languages: ['en-GB'] });
    expect(british.chips.map((chip) => chip.label)).toEqual(['YouTube', 'until 20:30']);
    const american = parseIntent(text, { now: NOW, locale: 'en', languages: 'en-US' });
    expect(american.chips.map((chip) => plain(chip.label))).toEqual(['YouTube', 'until 8:30 PM']);
    expect(withoutLabels(british)).toEqual(withoutLabels(american));
  });

  it('keeps the Spanish chips as they were', () => {
    const social = parseIntent('bloquea las redes sociales hasta las 20:30', { now: NOW });
    expect(social.chips.map((chip) => chip.label)).toEqual(['Redes sociales', 'hasta 20:30']);
  });
});

describe('catalog names', () => {
  it('categoryName: the catalog name in Spanish, a translation in English', () => {
    for (const category of CATEGORIES) {
      expect(categoryName(category.id)).toBe(category.name);
      expect(categoryName(category.id, 'es')).toBe(category.name);
      const en = categoryName(category.id, 'en');
      expect(en).toBe(CATALOG_NAMES_EN.categories[category.id]);
      expect(en).not.toBe(category.name);
      expect(en).not.toMatch(SPANISH);
    }
    expect(categoryName('social', 'en')).toBe('Social media');
    expect(categoryName('social', NOT_A_LOCALE)).toBe('Redes sociales');
    expect(Object.keys(CATALOG_NAMES_EN.categories).sort()).toEqual([...CATEGORY_IDS].sort());
  });

  it('returns the id for unknown entries', () => {
    expect(categoryName('nope', 'en')).toBe('nope');
    expect(categoryName('toString', 'en')).toBe('toString');
    expect(appName('nope', 'en')).toBe('nope');
    expect(serviceName('nope', 'en')).toBe('nope');
    expect(studySiteName('nope')).toBe('nope');
    expect(studyAppName('nope', 'en')).toBe('nope');
  });

  it('keeps brand names in every language', () => {
    for (const service of SERVICES) {
      expect(serviceName(service.id)).toBe(service.name);
      expect(serviceName(service.id, 'en')).toBe(service.name);
    }
    expect(appName('steam', 'en')).toBe('Steam');
    expect(studySiteName('wikipedia', 'en')).toBe('Wikipedia');
    expect(studyAppName('word', 'en')).toBe('Microsoft Word');
    expect(serviceName('el-pais', 'en')).toBe('El País');
    expect(serviceName('meneame', 'en')).toBe('Menéame');
  });

  it('translates the Spanish names of apps and the study whitelist', () => {
    expect(appName('popular-pc-games')).toBe('Juegos de PC populares');
    expect(appName('popular-pc-games', 'en')).toBe('Popular PC games');
    expect(studySiteName('google-account')).toBe('Cuenta de Google');
    expect(studySiteName('google-account', 'en')).toBe('Google Account');
    expect(studySiteName('google-scholar', 'en')).toBe('Google Scholar');
    expect(studyAppName('calculator')).toBe('Calculadora');
    expect(studyAppName('calculator', 'en')).toBe('Calculator');
    expect(studyAppName('iwork', 'en')).toBe('Pages, Numbers and Keynote');
  });

  const sections = [
    ['apps', APPS, appName],
    ['studySites', STUDY_WHITELIST, studySiteName],
    ['studyApps', STUDY_APP_WHITELIST, studyAppName],
  ] as const;

  for (const [section, entries, name] of sections) {
    it(`${section}: every translation names an entry and every Spanish name has one`, () => {
      const ids = new Set(entries.map((entry) => entry.id));
      const names = CATALOG_NAMES_EN[section];
      for (const [id, english] of Object.entries(names)) {
        expect(ids.has(id), `${section}.${id} is not in the catalog`).toBe(true);
        expect(english).not.toMatch(SPANISH);
        expect(english.trim()).toBe(english);
      }
      for (const entry of entries) {
        expect(name(entry.id)).toBe(entry.name);
        const english = name(entry.id, 'en');
        if (Object.hasOwn(names, entry.id)) {
          expect(english).not.toBe(entry.name);
        } else {
          expect(english).toBe(entry.name);
          expect(entry.name, `${section}.${entry.id} looks Spanish: translate it`).not.toMatch(
            SPANISH,
          );
        }
      }
    });
  }

  it('leaves the snapshot the guardian embeds in Spanish', () => {
    const snapshot = catalogSnapshot();
    expect(snapshot.categories.map((c) => c.name)).toEqual(CATEGORIES.map((c) => c.name));
    expect(JSON.stringify(snapshot)).not.toContain('Social media');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CATALOG_NAMES_EN)).toBe(true);
    for (const section of Object.values(CATALOG_NAMES_EN)) {
      expect(Object.isFrozen(section)).toBe(true);
    }
  });
});

describe('emergency phrase', () => {
  it('shows each language its own phrase, Spanish by default', () => {
    expect(emergencyPhrase()).toBe('Acepto romper mi compromiso y perder mis puntos');
    expect(emergencyPhrase('es')).toBe(EMERGENCY_RULES.phrases.es);
    expect(emergencyPhrase('en')).toBe('I accept breaking my commitment and losing my points');
    expect(emergencyPhrase(NOT_A_LOCALE)).toBe(EMERGENCY_RULES.phrases.es);
    for (const locale of LOCALES) {
      expect(emergencyPhraseMatches(emergencyPhrase(locale))).toBe(true);
      expect(emergencyPhrase(locale)).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('achievement text', () => {
  it('names every achievement with a help line in both languages', () => {
    for (const locale of LOCALES) {
      const t = sharedMessages(locale).achievements;
      expect(Object.keys(t.titles).sort()).toEqual(ACHIEVEMENTS.map((a) => a.id).sort());
      for (const achievement of ACHIEVEMENTS) {
        const text = achievementText(achievement.id, locale);
        expect(text?.title.length).toBeGreaterThan(0);
        expect(text?.help.length).toBeGreaterThan(0);
        expect(text?.help).not.toContain('undefined');
        if (locale === 'en') {
          expect(text?.title).not.toMatch(SPANISH);
          expect(text?.help).not.toMatch(SPANISH);
        }
      }
    }
    expect(sharedMessages()).toBe(SHARED_ES);
    expect(sharedMessages('en')).toBe(SHARED_EN);
    expect(sharedMessages(NOT_A_LOCALE)).toBe(SHARED_ES);
  });

  it('reads naturally', () => {
    expect(achievementText('streak-7')).toEqual({
      title: '7 días de racha',
      help: 'Cumple tu objetivo diario 7 días seguidos',
    });
    expect(achievementText('streak-7', 'en')).toEqual({
      title: '7-day streak',
      help: 'Meet your daily goal 7 days in a row',
    });
    expect(achievementText('study-10h')).toEqual({
      title: '10 h de Study Mode',
      help: 'Suma 10 h concentrado en Study Mode',
    });
    expect(achievementText('study-10h', 'en')).toEqual({
      title: '10 h of Study Mode',
      help: 'Spend 10 h focused in Study Mode',
    });
    expect(achievementText('first-session', 'en')).toEqual({
      title: 'First session',
      help: 'Finish a Study Mode session',
    });
    expect(achievementText('clean-week', 'en')).toEqual({
      title: 'A week without attempts',
      help: 'Spend 7 days in a row with activity and no attempts',
    });
    expect(achievementText('nope')).toBeUndefined();
  });

  it('writes help lines for any threshold', () => {
    const es = SHARED_ES.achievements.help;
    const en = SHARED_EN.achievements.help;
    expect(es('completedBlocks', 1)).toBe('Cumple un bloqueo hasta el final');
    expect(es('completedBlocks', 1000)).toBe('Cumple 1.000 bloqueos hasta el final');
    expect(en('completedBlocks', 1)).toBe('Complete a block');
    expect(en('completedBlocks', 1000)).toBe('Complete 1,000 blocks');
    expect(en('bestStreakDays', 1)).toBe('Meet your daily goal for a day');
    expect(en('focusMinutesTotal', 90)).toBe('Spend 1 h 30 min focused in Study Mode');
    expect(en('completedStudySessions', 25)).toBe('Finish 25 Study Mode sessions');
    expect(en('bestCleanDayRun', 1)).toBe('Spend a day with activity and no attempts');
  });
});

describe('package exports', () => {
  const require = createRequire(import.meta.url);
  const src = new URL('../src/', import.meta.url);

  for (const [specifier, file] of [
    ['@centrate/shared/i18n', 'i18n.ts'],
    ['@centrate/shared/parser/format', 'parser/format.ts'],
  ] as const) {
    it(`${specifier} resolves to src/${file}`, () => {
      expect(realpathSync(require.resolve(specifier))).toBe(
        realpathSync(fileURLToPath(new URL(file, src))),
      );
    });
  }
});
