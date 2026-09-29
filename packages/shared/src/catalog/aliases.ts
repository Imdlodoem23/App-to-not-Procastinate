import { CATEGORIES, SERVICES } from './data/index';
import { findServiceByDomain, getCategory, getService } from './lookup';
import type { Category, Service } from './types';

export type AliasKind = 'service' | 'category';

export interface AliasEntry {
  /** Normalized alias with single spaces between words, e.g. `disney plus`. */
  readonly alias: string;
  readonly kind: AliasKind;
  readonly id: string;
}

export interface AliasConflict {
  /** Lookup key (normalized alias without spaces). */
  readonly key: string;
  readonly targets: ReadonlyArray<{ readonly kind: AliasKind; readonly id: string }>;
}

/**
 * Normalizes free text for alias matching: lowercase, accents removed («vídeo» → video),
 * «+» read as «plus» («Disney+» → disney plus) and every other symbol turned into a
 * single space.
 */
export function normalizeAlias(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Lookup key: the normalized alias without spaces, so «you tube», «YouTube» and
 * «tik-tok»/«tiktok» meet.
 */
export function aliasKey(text: string): string {
  return normalizeAlias(text).replace(/ /g, '');
}

function namesOf(item: Service | Category): string[] {
  return [item.id, item.name, ...item.aliases];
}

function collectEntries(): AliasEntry[] {
  const entries: AliasEntry[] = [];
  const seen = new Set<string>();
  const add = (kind: AliasKind, id: string, text: string): void => {
    const alias = normalizeAlias(text);
    const dedupeKey = `${kind}\u0000${id}\u0000${alias}`;
    if (alias.length === 0 || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    entries.push({ alias, kind, id });
  };
  for (const service of SERVICES) {
    for (const text of namesOf(service)) add('service', service.id, text);
  }
  for (const category of CATEGORIES) {
    for (const text of namesOf(category)) add('category', category.id, text);
  }
  return entries;
}

const ENTRIES: readonly AliasEntry[] = Object.freeze(collectEntries().map((e) => Object.freeze(e)));

/**
 * Precedence if a key were shared (the catalog tests forbid it; user-defined aliases might
 * not): within a kind, the first entry in catalog order wins. `findServiceByAlias` and
 * `findCategoryByAlias` use separate indexes, so a caller that tries both decides which
 * kind wins; the NL parser should try services first (the more specific target).
 */
function buildIndex<T>(kind: AliasKind, resolve: (id: string) => T | undefined): Map<string, T> {
  const index = new Map<string, T>();
  for (const entry of ENTRIES) {
    if (entry.kind !== kind) continue;
    const key = entry.alias.replace(/ /g, '');
    const target = resolve(entry.id);
    if (target !== undefined && !index.has(key)) index.set(key, target);
  }
  return index;
}

const SERVICE_INDEX = buildIndex('service', getService);
const CATEGORY_INDEX = buildIndex('category', getCategory);

/**
 * The service a user means by `text` («yt», «Tik Tok», «disney+», «netflis»…). The whole
 * text must be an alias, the service id or its name; text that looks like a domain or URL
 * («m.youtube.com/watch») falls back to `findServiceByDomain`.
 */
export function findServiceByAlias(text: string): Service | undefined {
  const key = aliasKey(text);
  if (key.length === 0) return undefined;
  const service = SERVICE_INDEX.get(key);
  if (service) return service;
  return typeof text === 'string' && text.includes('.') ? findServiceByDomain(text) : undefined;
}

/** The category a user means by `text` («redes», «RRSS», «videojuegos», «series»…). */
export function findCategoryByAlias(text: string): Category | undefined {
  const key = aliasKey(text);
  return key.length === 0 ? undefined : CATEGORY_INDEX.get(key);
}

/**
 * Every alias (ids and names included), normalized, for callers that scan free text
 * word by word (the NL parser).
 */
export function listAliases(): readonly AliasEntry[] {
  return ENTRIES;
}

/** Keys that point to more than one target. Must be empty for the built-in catalog. */
export function findAliasConflicts(): AliasConflict[] {
  const byKey = new Map<string, Map<string, { kind: AliasKind; id: string }>>();
  for (const entry of ENTRIES) {
    const key = entry.alias.replace(/ /g, '');
    const targets = byKey.get(key) ?? new Map<string, { kind: AliasKind; id: string }>();
    targets.set(`${entry.kind}:${entry.id}`, { kind: entry.kind, id: entry.id });
    byKey.set(key, targets);
  }
  const conflicts: AliasConflict[] = [];
  for (const [key, targets] of byKey) {
    if (targets.size > 1) conflicts.push({ key, targets: [...targets.values()] });
  }
  return conflicts;
}
