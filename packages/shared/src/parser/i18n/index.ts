import { toLocale, type Locale } from '../../i18n/locale';
import { PARSER_EN } from './en';
import { PARSER_ES, type ParserMessages } from './es';

export type { ParserMessages } from './es';
export { PARSER_EN } from './en';
export { PARSER_ES } from './es';

/** Parser strings per UI language. */
export const PARSER_MESSAGES: Readonly<Record<Locale, ParserMessages>> = Object.freeze({
  es: PARSER_ES,
  en: PARSER_EN,
});

/** The parser strings of `locale` (Spanish for anything that is not a locale). */
export function parserMessages(locale?: Locale): ParserMessages {
  return PARSER_MESSAGES[toLocale(locale)];
}
