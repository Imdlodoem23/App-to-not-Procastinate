/**
 * Strings shared by main and the renderers in the active locale (`locale.ts`). Import
 * `SHARED` for copy; `SHARED_ES` / `SHARED_EN` only where one language is meant (tests).
 */
import { SHARED_EN } from './en';
import { SHARED_ES, type SharedMessages } from './es';
import { localized } from './locale';

export { SHARED_EN, SHARED_ES, type SharedMessages };
export const SHARED: SharedMessages = localized<SharedMessages>({ es: SHARED_ES, en: SHARED_EN });
export * from './locale';
