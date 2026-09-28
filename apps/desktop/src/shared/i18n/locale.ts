/**
 * The app language (Spanish or English) and how every surface reads its copy in it.
 *
 * - `LanguagePreference` is what Ajustes stores (`prefs.language`): «Sistema», «Español» or
 *   «English». `resolveLocale` turns it into a `Locale` with the system languages main reads
 *   once at start (`app.getPreferredSystemLanguages()`): a first language starting with `en`
 *   gives English, anything else Spanish.
 * - Each process keeps one active locale (`setActiveLocale`): main sets it from every
 *   snapshot before the tray, titles and notifications are built; each renderer before its
 *   store publishes the snapshot.
 * - `localized({ es, en })` gives one object typed like the Spanish table whose properties are
 *   read from the active locale's table **at access time**, at any depth. Code can keep module
 *   aliases (`const E = BLOQUEOS.targets`) and read `E.title(…)` inside functions; only a leaf
 *   read at module load (a string or function copied into a module constant) would freeze.
 *
 * Pure module: no DOM, Node or Electron imports.
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LANGUAGE_PREFERENCES = ['system', 'es', 'en'] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === 'string' && (LANGUAGE_PREFERENCES as readonly string[]).includes(value);
}

/** The OS language list (`app.getPreferredSystemLanguages()`, `app.getLocale()`) as a locale. */
export function systemLocaleFrom(languages: readonly (string | null | undefined)[]): Locale {
  const first = languages.find((l): l is string => typeof l === 'string' && l.trim() !== '');
  return first !== undefined && /^en(?:[-_]|$)/i.test(first.trim()) ? 'en' : 'es';
}

/** «Sistema» follows the OS; «Español» / «English» are fixed. */
export function resolveLocale(preference: LanguagePreference, systemLocale: Locale): Locale {
  return preference === 'system' ? systemLocale : preference;
}

/** BCP 47 tag for `Intl` (numbers, clock times, weekdays, lists). */
export function intlTag(locale: Locale = activeLocale()): string {
  return locale === 'en' ? 'en-US' : 'es-ES';
}

let active: Locale = DEFAULT_LOCALE;
const listeners = new Set<(locale: Locale) => void>();

export function activeLocale(): Locale {
  return active;
}

/** Switch this process's copy; listeners run only when it actually changes. */
export function setActiveLocale(locale: Locale): void {
  if (locale === active) return;
  active = locale;
  for (const listener of listeners) listener(locale);
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Run `fn` with `locale` active (tests and one-off formatting), then restore. */
export function withLocale<T>(locale: Locale, fn: () => T): T {
  const previous = active;
  active = locale;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

type Table = Readonly<Record<PropertyKey, unknown>>;

function isNested(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(root: unknown, path: readonly PropertyKey[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isNested(node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * One message table per locale behind a single object typed `T` (see the module comment).
 * Arrays and functions are returned as they are in the active table; nested objects as
 * further live views. Read-only.
 */
export function localized<T extends object>(tables: Readonly<Record<Locale, T>>): T {
  const views = new Map<string, object>();
  const current = (path: readonly PropertyKey[]): Table => {
    const node = at(tables[active], path);
    return isNested(node) ? node : {};
  };
  const view = (path: readonly PropertyKey[]): object => {
    const id = path.map(String).join('\u0000');
    const cached = views.get(id);
    if (cached) return cached;
    const proxy = new Proxy(
      {},
      {
        get(_target, key) {
          const value = current(path)[key];
          return isNested(value) ? view([...path, key]) : value;
        },
        has: (_target, key) => key in current(path),
        ownKeys: () => Reflect.ownKeys(current(path)),
        getOwnPropertyDescriptor(_target, key) {
          const table = current(path);
          if (!Object.prototype.hasOwnProperty.call(table, key)) return undefined;
          const value = table[key];
          return {
            configurable: true,
            enumerable: true,
            writable: false,
            value: isNested(value) ? view([...path, key]) : value,
          };
        },
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
      },
    );
    views.set(id, proxy);
    return proxy;
  };
  return view([]) as T;
}

/** Deep-widened shape of a message table: every locale file must match the Spanish one. */
export type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { [K in keyof T]: Widen<T[K]> };
