/** Renderer foundation copy in the active locale (`src/shared/i18n/locale.ts`). */
import { localized } from '../../../shared/i18n/locale';
import { RENDERER_EN } from './en';
import { RENDERER_ES, type RendererMessages } from './es';

export { RENDERER_EN, RENDERER_ES, type RendererMessages };
export const RENDERER: RendererMessages = localized<RendererMessages>({
  es: RENDERER_ES,
  en: RENDERER_EN,
});
