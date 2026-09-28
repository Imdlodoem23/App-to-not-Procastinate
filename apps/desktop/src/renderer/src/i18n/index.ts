/**
 * One import point for renderer copy and formatting: the renderer strings, the guardian error
 * copy, the strings shared with main, and the shared formatters (es-ES numbers with
 * `useGrouping: 'always'`, 24 h clock, typographic minus «−», countdown and remaining time).
 */
export { RENDERER_ES, type RendererMessages } from './es';
export { errorCopy, errorActionLabel, type ErrorAction, type ErrorCopy } from './errors';
export { SHARED_ES, type SharedMessages } from '../../../shared/i18n/es';
export {
  LOCALE,
  MINUS,
  countdownAria,
  formatClock,
  formatInt,
  formatMinutes,
  formatPoints,
  formatPointsShort,
  formatRemaining,
  formatSignedInt,
  modeLabel,
  remainingMinutes,
  splitCountdown,
  targetNames,
  targetsLabel,
} from '../../../shared/format';
