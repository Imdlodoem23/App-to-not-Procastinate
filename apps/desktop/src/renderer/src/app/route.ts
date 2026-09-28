/**
 * Which window this renderer is, from its URL (docs/DESKTOP.md §7.2). Main loads the one bundle
 * as `index.html?window=main|detail` (plus `&state=<id>` in the harness). The browser harness
 * also accepts a detail view as the window (`?window=bloqueos|emergencia|ajustes&state=…`), which
 * opens the detail window on that view. Pure.
 */
import { isDetailName, type DetailName, type WindowKind } from '../../../shared/ui-state';

export interface RendererRoute {
  window: WindowKind;
  /** Browser harness only: the detail view named in `?window=`. */
  detail: DetailName | null;
  /** Harness state id (`?state=`); validated against the fixtures where it is used. */
  stateId: string | null;
  /** Browser harness only (`?kit`): the UI kit gallery instead of the window. */
  kit: boolean;
}

const STATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseRoute(search: string): RendererRoute {
  const params = new URLSearchParams(search);
  const window = params.get('window');
  const state = params.get('state');
  const stateId = state !== null && STATE_ID_RE.test(state) ? state : null;
  const kit = params.has('kit');
  if (window === 'detail') return { window: 'detail', detail: null, stateId, kit };
  if (isDetailName(window)) return { window: 'detail', detail: window, stateId, kit };
  return { window: 'main', detail: null, stateId, kit };
}
