/**
 * Which window this renderer is, from its URL (docs/DESKTOP.md §7.2). Main loads the one bundle
 * as `index.html?window=main|detail` (plus `&state=<id>` in the harness). The browser harness
 * also accepts a detail view as the window (`?window=bloqueos|emergencia|ajustes&state=…`), which
 * opens the detail window on that view, and `?lang=en` for an English system. Phase 5 surfaces
 * load as `?window=mini-timer|osd|nuclear`. Pure.
 */
import { isLocale, type Locale } from '../../../shared/i18n/locale';
import {
  isDetailName,
  isSurfaceKind,
  type DetailName,
  type UiWindow,
} from '../../../shared/ui-state';

export interface RendererRoute {
  window: UiWindow;
  /** Browser harness only: the detail view named in `?window=`. */
  detail: DetailName | null;
  /** Harness state id (`?state=`); validated against the fixtures where it is used. */
  stateId: string | null;
  /** Browser harness only (`?kit`): the UI kit gallery instead of the window. */
  kit: boolean;
  /** Browser harness only (`?lang=es|en`): the fake OS language. */
  lang: Locale | null;
}

const STATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseRoute(search: string): RendererRoute {
  const params = new URLSearchParams(search);
  const window = params.get('window');
  const state = params.get('state');
  const stateId = state !== null && STATE_ID_RE.test(state) ? state : null;
  const kit = params.has('kit');
  const langParam = params.get('lang');
  const lang = isLocale(langParam) ? langParam : null;
  if (window === 'detail') return { window: 'detail', detail: null, stateId, kit, lang };
  if (isSurfaceKind(window)) return { window, detail: null, stateId, kit, lang };
  if (isDetailName(window)) return { window: 'detail', detail: window, stateId, kit, lang };
  return { window: 'main', detail: null, stateId, kit, lang };
}
