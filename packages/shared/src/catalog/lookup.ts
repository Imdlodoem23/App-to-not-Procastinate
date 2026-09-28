import {
  ALWAYS_ALLOWED_HOSTS,
  APPS,
  BROWSERS,
  CATEGORIES,
  PROTECTED_DOMAINS,
  SERVICES,
} from './data/index';
import { isSameOrSubdomain, normalizeDomain } from './domains';
import { processNameKey } from './processes';
import type { App, Browser, CatalogPlatform, Category, Service } from './types';

const SERVICES_BY_ID: ReadonlyMap<string, Service> = new Map(SERVICES.map((s) => [s.id, s]));
const CATEGORIES_BY_ID: ReadonlyMap<string, Category> = new Map(CATEGORIES.map((c) => [c.id, c]));
const APPS_BY_ID: ReadonlyMap<string, App> = new Map(APPS.map((a) => [a.id, a]));

/** Owner of each catalog host. If two services listed a host, the first one wins. */
const SERVICES_BY_DOMAIN: ReadonlyMap<string, Service> = (() => {
  const map = new Map<string, Service>();
  for (const service of SERVICES) {
    for (const domain of service.domains) if (!map.has(domain)) map.set(domain, service);
  }
  return map;
})();

export function getService(id: string): Service | undefined {
  return SERVICES_BY_ID.get(id);
}

export function getCategory(id: string): Category | undefined {
  return CATEGORIES_BY_ID.get(id);
}

export function getApp(id: string): App | undefined {
  return APPS_BY_ID.get(id);
}

/** Services in a category, in catalog order. Opt-in services belong to no category. */
export function servicesInCategory(id: string): Service[] {
  return SERVICES.filter((service) => (service.categories as readonly string[]).includes(id));
}

/**
 * Hosts that belong to no service although they sit under one: the services'
 * `excludedSubdomains` and the always-allowed hosts. Lookups stop there.
 */
const UNBLOCKED_HOSTS: ReadonlySet<string> = new Set([
  ...SERVICES.flatMap((service) => service.excludedSubdomains ?? []),
  ...ALWAYS_ALLOWED_HOSTS,
]);

/**
 * True when `domain` (a host or URL) is one of `ALWAYS_ALLOWED_HOSTS` or a subdomain of
 * one: it must never be blocked, in any mode.
 */
export function isAlwaysAllowedHost(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return false;
  return ALWAYS_ALLOWED_HOSTS.some((host) => isSameOrSubdomain(normalized, host));
}

/**
 * True when `domain` (a host or URL) is one of `PROTECTED_DOMAINS` or a subdomain of one:
 * no block may list it (422 `protected_target`). Invalid input is not protected (it is
 * rejected as invalid instead).
 */
export function isProtectedDomain(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return false;
  return PROTECTED_DOMAINS.some((host) => isSameOrSubdomain(normalized, host));
}

/**
 * The service a host or URL belongs to, matching exact catalog hosts first and then their
 * parents: `https://es.m.youtube.com/watch` → YouTube. Used to attribute attempts
 * reported by different layers to the same service. Hosts that stay reachable during a
 * block (a service's `excludedSubdomains` such as `docs.aws.amazon.com`, and
 * `ALWAYS_ALLOWED_HOSTS` such as `accounts.youtube.com`) belong to no service.
 */
export function findServiceByDomain(domain: string): Service | undefined {
  const normalized = normalizeDomain(domain);
  if (normalized === null) return undefined;
  let candidate = normalized;
  for (;;) {
    const service = SERVICES_BY_DOMAIN.get(candidate);
    if (service) return service;
    if (UNBLOCKED_HOSTS.has(candidate)) return undefined;
    const dot = candidate.indexOf('.');
    // Stop before reaching a bare top-level label.
    if (dot < 0 || !candidate.includes('.', dot + 1)) return undefined;
    candidate = candidate.slice(dot + 1);
  }
}

const APPS_BY_PROCESS: Readonly<Record<CatalogPlatform, ReadonlyMap<string, App>>> = (() => {
  const build = (platform: CatalogPlatform): Map<string, App> => {
    const map = new Map<string, App>();
    for (const app of APPS) {
      for (const name of app.processes[platform]) {
        const key = processNameKey(name, platform);
        if (!map.has(key)) map.set(key, app);
      }
    }
    return map;
  };
  return { win: build('win'), mac: build('mac'), linux: build('linux') };
})();

/** The catalog app that runs as `processName` on `platform` (case rules per platform). */
export function findAppByProcessName(
  processName: string,
  platform: CatalogPlatform,
): App | undefined {
  if (typeof processName !== 'string') return undefined;
  return APPS_BY_PROCESS[platform].get(processNameKey(processName.trim(), platform));
}

/** The service whose desktop app runs as `processName`, if any. */
export function findServiceByProcessName(
  processName: string,
  platform: CatalogPlatform,
): Service | undefined {
  const app = findAppByProcessName(processName, platform);
  if (!app) return undefined;
  return SERVICES.find((service) => service.appIds?.includes(app.id));
}

const BROWSERS_BY_ID: ReadonlyMap<string, Browser> = new Map(BROWSERS.map((b) => [b.id, b]));

export function getBrowser(id: string): Browser | undefined {
  return BROWSERS_BY_ID.get(id);
}

/**
 * The browsers that run as `processName` on `platform` (case rules per platform), in
 * catalog order. Several browsers can share a name (Chromium runs as `chrome.exe` on
 * Windows, like Google Chrome); they always share `family`.
 */
export function findBrowsersByProcessName(
  processName: string,
  platform: CatalogPlatform,
): Browser[] {
  if (typeof processName !== 'string') return [];
  const key = processNameKey(processName.trim(), platform);
  return BROWSERS.filter((browser) =>
    browser.processes[platform].some((name) => processNameKey(name, platform) === key),
  );
}

// ---------------------------------------------------------------------------------------
// Window titles (active-window layer and Study Mode foreground check).

/**
 * Separators between title parts: « - », « – », « — », « | », « • », « · », « / ». The
 * capturing group keeps them in `split`. «: » is not one of them (see below).
 */
const TITLE_SEPARATOR_RE = /(\s+[-–—|•·/]\s+)/u;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/gu;
/** Unread counters such as «(3) » at the start of a title. */
const COUNTER_RE = /^\(\d+\+?\)\s*/u;
/** Edge appends «and 3 more pages» («y 3 páginas más») to the active tab's title. */
const MORE_TABS_RE = /\s+(?:and \d+ more (?:pages?|tabs?)|y \d+ (?:páginas?|pestañas?) más)$/u;

/** Browser and private-window segments at the end of a title, as title keys. */
const BROWSER_SEGMENTS: ReadonlySet<string> = new Set([
  'google chrome',
  'chrome',
  'chromium',
  'microsoft edge',
  'microsoft edge beta',
  'microsoft edge dev',
  'edge',
  '[inprivate]',
  'inprivate',
  'mozilla firefox',
  'firefox',
  'firefox developer edition',
  'firefox nightly',
  'mozilla firefox private browsing',
  'navegación privada de mozilla firefox',
  'brave',
  'opera',
  'opera gx',
  'vivaldi',
  'safari',
  'arc',
]);

function titleKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(COUNTER_RE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

interface TitleParts {
  /** Part keys (see `titleKey`), left to right. */
  readonly keys: string[];
  /** The separator before each part, trimmed («-», «/»…); '' before the first one. */
  readonly separators: string[];
}

function splitTitle(title: string): TitleParts {
  const pieces = title.split(TITLE_SEPARATOR_RE);
  const keys: string[] = [];
  const separators: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    keys.push(titleKey(pieces[i] ?? ''));
    separators.push(i === 0 ? '' : (pieces[i - 1] ?? '').trim());
  }
  return { keys, separators };
}

/** Title key of a hint or title, with every separator written as « - ». */
function joinedTitleKey(text: string): string {
  return splitTitle(text).keys.join(' - ');
}

const SERVICES_BY_TITLE: ReadonlyMap<string, Service> = (() => {
  const map = new Map<string, Service>();
  for (const service of SERVICES) {
    for (const hint of [service.name, ...(service.titleHints ?? [])]) {
      const key = joinedTitleKey(hint);
      if (key && !map.has(key)) map.set(key, service);
    }
  }
  return map;
})();

/**
 * The service named by a title part. One-letter names («X») only count after « / »,
 * where X puts its name («Inicio / X»), so «Despejar: x» or a page called «X» never
 * matches.
 */
function serviceForTitlePart(key: string, separator: string): Service | undefined {
  const service = SERVICES_BY_TITLE.get(key);
  if (!service) return undefined;
  return [...key].length > 1 || separator === '/' ? service : undefined;
}

/**
 * The service a window title points to, e.g. «(3) Some video - YouTube - Google Chrome»
 * → YouTube. Only the positions where sites put their own name are read, so page titles
 * never count: a Wikipedia article «YouTube - Wikipedia», a search «youtube - Buscar con
 * Google» or a document «Max - Documentos de Google» return undefined.
 *
 * 1. The title is split on « - », « | », « / », « • »…, unread counters («(3) ») are
 *    dropped, and trailing browser segments («Google Chrome», «Mozilla Firefox»,
 *    «[InPrivate]») and Edge's «and 3 more pages» are removed.
 * 2. The whole remaining title may be a name or a hint («WhatsApp», «TikTok - Make Your
 *    Day»).
 * 3. With several parts, only the last one is the site's name («Vídeo - YouTube»).
 * 4. With a single part, a name before «: » counts («Amazon.es: compra online», «Prime
 *    Video: Título»). «: » never splits otherwise, so «Tema 3: X» is not X.
 *
 * Parts must equal a service name or one of its `titleHints`; words inside a part never
 * match. Known gap: Edge windows of a named profile add the profile after the site
 * («… - YouTube - Personal - Microsoft Edge») and are missed. Callers should skip windows
 * of protected processes (a File Explorer folder called «Steam»).
 */
export function findServiceByWindowTitle(title: string): Service | undefined {
  if (typeof title !== 'string' || title.length === 0) return undefined;
  const { keys, separators } = splitTitle(title);
  while (keys.length > 0 && BROWSER_SEGMENTS.has(keys[keys.length - 1] ?? '')) {
    keys.pop();
    separators.pop();
  }
  const lastIndex = keys.length - 1;
  if (lastIndex < 0) return undefined;
  keys[lastIndex] = (keys[lastIndex] ?? '').replace(MORE_TABS_RE, '');

  const whole = serviceForTitlePart(keys.join(' - '), '');
  if (whole) return whole;
  if (lastIndex > 0) return serviceForTitlePart(keys[lastIndex] ?? '', separators[lastIndex] ?? '');

  const only = keys[0] ?? '';
  const colon = only.indexOf(': ');
  return colon > 0 ? serviceForTitlePart(only.slice(0, colon).trim(), '') : undefined;
}
