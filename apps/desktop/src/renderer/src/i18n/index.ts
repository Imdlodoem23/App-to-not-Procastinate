/**
 * One import point for renderer copy and formatting: the renderer strings, the guardian error
 * copy, the strings shared with main, the active locale and the shared formatters (numbers
 * with `useGrouping: 'always'`, the locale's clock, typographic minus «−», countdown and
 * remaining time). Every message object reads the active locale at access time.
 */
export { RENDERER, RENDERER_EN, RENDERER_ES, type RendererMessages } from './messages';
export { errorCopy, errorActionLabel, type ErrorAction, type ErrorCopy } from './errors';
export { SHARED, SHARED_EN, SHARED_ES, type SharedMessages } from '../../../shared/i18n';
export {
  activeLocale,
  intlTag,
  onLocaleChange,
  resolveLocale,
  setActiveLocale,
  type LanguagePreference,
  type Locale,
} from '../../../shared/i18n/locale';
export {
  MINUS,
  categoryName,
  countdownAria,
  formatClock,
  formatInt,
  formatList,
  formatMinutes,
  formatPoints,
  formatPointsShort,
  formatRemaining,
  formatSignedInt,
  formatWeekday,
  intlLocale,
  modeLabel,
  remainingMinutes,
  splitCountdown,
  targetNames,
  targetsLabel,
} from '../../../shared/format';
