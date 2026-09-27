/**
 * Catalog types. The catalog is plain data (no functions, no Dates) so it can be
 * serialized with `catalogSnapshot()` and embedded by the guardian as JSON.
 */

/** Distraction categories. Ids are stable identifiers; names are Spanish UI strings. */
export type CategoryId = 'social' | 'video' | 'games' | 'messaging' | 'shopping' | 'news';

/**
 * Operating systems for process names. Named `CatalogPlatform` (not `Platform`) so it
 * does not clash with other modules when re-exported from the package index.
 */
export type CatalogPlatform = 'win' | 'mac' | 'linux';

export interface Category {
  readonly id: CategoryId;
  /** Spanish display name, e.g. «Redes sociales». */
  readonly name: string;
  /** Lowercase words users type for the whole category («redes», «juegos», «series»…). */
  readonly aliases: readonly string[];
  /**
   * Apps blocked with the category that do not belong to a single service
   * (e.g. popular PC games that keep running after their launcher is closed).
   */
  readonly appIds?: readonly string[];
}

export interface Service {
  /** Kebab-case ASCII id, e.g. `youtube`, `x-twitter`, `prime-video`. */
  readonly id: string;
  /** Display name, e.g. «YouTube», «X (Twitter)». */
  readonly name: string;
  /**
   * Categories that include this service. An empty list marks an opt-in service: it is
   * only blocked when named explicitly (never by a category or a punishment).
   */
  readonly categories: readonly CategoryId[];
  /**
   * Every host to block, already expanded: the hosts file has no wildcards, so each
   * subdomain (www., m., short links, exclusive API/CDN hosts) is listed on its own.
   * Never shared infrastructure (googleapis.com, gstatic.com, akamai, cloudfront…).
   */
  readonly domains: readonly string[];
  /** Desktop apps that belong to the service (ids in `APPS`). */
  readonly appIds?: readonly string[];
  /** Lowercase forms users type, including typos and abbreviations. */
  readonly aliases: readonly string[];
  /** 1-2 characters shown as a fallback icon. */
  readonly monogram: string;
  /** The service can be used for learning (future «YouTube solo educativo»). */
  readonly educationalCapable?: boolean;
  /**
   * Extra window-title segments that identify the service (the name is always used).
   * See `findServiceByWindowTitle`.
   */
  readonly titleHints?: readonly string[];
}

/** Executable base names per platform, exactly as they appear in the process list. */
export type ProcessNames = Readonly<Record<CatalogPlatform, readonly string[]>>;

export interface App {
  readonly id: string;
  readonly name: string;
  readonly processes: ProcessNames;
}

/** A group of study domains in the default whitelist (e.g. «Microsoft 365»). */
export interface StudySite {
  readonly id: string;
  readonly name: string;
  /** Each entry also allows all of its subdomains. */
  readonly domains: readonly string[];
}

/** What the user chose to block (from the parser or the advanced form). */
export interface TargetSelection {
  readonly serviceIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  /** Custom domains or URLs typed by the user; normalized and expanded with `www.`. */
  readonly domains?: readonly string[];
  readonly appIds?: readonly string[];
  /** Custom process names picked by the user. */
  readonly processNames?: readonly string[];
}

export interface ResolvedTargets {
  /** Unique, sorted hosts ready for the hosts file and the extension. */
  domains: string[];
  /** Unique, sorted process names for the given platform. */
  processes: string[];
}

export interface CatalogSnapshot {
  version: number;
  categories: Array<{ id: CategoryId; name: string; aliases: string[]; appIds: string[] }>;
  services: Array<{
    id: string;
    name: string;
    categories: CategoryId[];
    domains: string[];
    appIds: string[];
    aliases: string[];
    monogram: string;
    educationalCapable: boolean;
    titleHints: string[];
  }>;
  apps: Array<{ id: string; name: string; processes: Record<CatalogPlatform, string[]> }>;
  studyWhitelist: Array<{ id: string; name: string; domains: string[] }>;
  studyAppWhitelist: Array<{
    id: string;
    name: string;
    processes: Record<CatalogPlatform, string[]>;
  }>;
  /** Process names the guardian must never kill (compared case-insensitively). */
  protectedProcesses: string[];
}
