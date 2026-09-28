/**
 * The window in the snapshot's language. The store switches the active locale before it
 * publishes a snapshot; a language change remounts the window (keyed by locale), so no
 * memoized value keeps the old copy. Store state (drafts, cards, detail requests) survives.
 *
 * The remount must not lose the user's place (WCAG 3.2.2: changing a setting does not move you
 * elsewhere). Ajustes › Idioma is a radiogroup where selection follows focus, so a focus that
 * jumped to another row would make the next arrow key change a setting nobody touched:
 * - while rendering the new locale (the old tree is still on screen) `Localized` notes the
 *   focused control and the scroll offsets of the `[data-keep-scroll]` containers;
 * - once the new tree is committed (its own layout effects run after its children's) it puts
 *   them back;
 * - `useLocaleSwitch()` tells mount effects (a detail window's door focus) that this mount is
 *   a language switch, so they leave the focus alone.
 */
import {
  Fragment,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useAppStore } from '../store/context';
import { snapshotLocale } from '../../../shared/ui-state';

/** `current` is true only during the commit that remounts the window for a new language. */
export interface LocaleSwitch {
  readonly current: boolean;
}

const LocaleSwitchContext = createContext<LocaleSwitch>({ current: false });

/** Read it inside a layout effect: true when this mount comes from a language switch. */
export function useLocaleSwitch(): LocaleSwitch {
  return useContext(LocaleSwitchContext);
}

/** Where the user was: the focused control and each kept scroll offset. */
export interface Place {
  focus: string | null;
  scroll: readonly (readonly [string, number])[];
}

const KEEP_SCROLL = 'data-keep-scroll';

/**
 * A selector that finds the same control after the remount: its `id`, else a row tile's
 * `data-row-tile` + `data-tile-id` (both independent of the language). `null` for anything
 * else (the body, an element without a stable handle).
 */
export function placeSelector(element: Element | null): string | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const row = element.dataset['rowTile'];
  const tile = element.dataset['tileId'];
  if (row !== undefined && tile !== undefined) {
    return `[data-row-tile="${CSS.escape(row)}"][data-tile-id="${CSS.escape(tile)}"]`;
  }
  return null;
}

export function capturePlace(): Place {
  const scroll: (readonly [string, number])[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(`[${KEEP_SCROLL}]`)) {
    const key = el.getAttribute(KEEP_SCROLL) ?? '';
    if (el.scrollTop > 0) scroll.push([key, el.scrollTop]);
  }
  return { focus: placeSelector(document.activeElement), scroll };
}

/** Puts back what `capturePlace` saw; `false` when the focused control is not there (yet). */
export function restorePlace(place: Place): boolean {
  for (const [key, top] of place.scroll) {
    const el = document.querySelector<HTMLElement>(`[${KEEP_SCROLL}="${CSS.escape(key)}"]`);
    if (el) el.scrollTop = top;
  }
  if (place.focus === null) return true;
  const target = document.querySelector<HTMLElement>(place.focus);
  if (!target) return false;
  if (target !== document.activeElement) target.focus({ preventScroll: true });
  return true;
}

export function Localized(props: { children: ReactNode }): React.JSX.Element {
  const locale = useAppStore((s) => snapshotLocale(s.snapshot));
  const shown = useRef(locale);
  const pending = useRef<Place | null>(null);
  const switching = useRef(false);

  if (shown.current !== locale) {
    // Render phase of the new locale: the old tree is still mounted and focused. Reading (not
    // changing) the DOM here is the only moment the user's place can still be seen.
    shown.current = locale;
    pending.current = capturePlace();
    switching.current = true;
  }

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    switching.current = false;
    const place = pending.current;
    pending.current = null;
    if (!place || restorePlace(place)) return undefined;
    // A view that suspended mounts a moment later: one more try on the next frame.
    const frame = requestAnimationFrame(() => restorePlace(place));
    return () => cancelAnimationFrame(frame);
  }, [locale]);

  return (
    <LocaleSwitchContext.Provider value={switching}>
      <Fragment key={locale}>{props.children}</Fragment>
    </LocaleSwitchContext.Provider>
  );
}
