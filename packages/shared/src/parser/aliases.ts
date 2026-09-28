import {
  aliasKey,
  findCategoryByAlias,
  findServiceByAlias,
  getCategory,
  getService,
  listAliases,
  type CategoryId,
} from '../catalog';

export type TargetRef =
  | { readonly kind: 'service'; readonly id: string; readonly label: string }
  | { readonly kind: 'category'; readonly id: CategoryId; readonly label: string };

/**
 * Parser-side aliases the catalog does not have (yet). Keys go through `aliasKey`, like
 * the catalog's. Candidates to move into the catalog data.
 */
export const PARSER_EXTRA_ALIASES: ReadonlyArray<{
  readonly alias: string;
  readonly kind: 'service' | 'category';
  readonly id: string;
}> = Object.freeze([
  { alias: 'peli', kind: 'category', id: 'video' },
  { alias: 'streamer', kind: 'category', id: 'video' },
  { alias: 'streamers', kind: 'category', id: 'video' },
  { alias: 'tiktoks', kind: 'service', id: 'tiktok' },
  { alias: 'yt music', kind: 'service', id: 'youtube' },
  { alias: 'yt kids', kind: 'service', id: 'youtube' },
  { alias: 'youtube kids', kind: 'service', id: 'youtube' },
  { alias: 'youtuber', kind: 'service', id: 'youtube' },
  { alias: 'youtubers', kind: 'service', id: 'youtube' },
  { alias: 'tick tock', kind: 'service', id: 'tiktok' },
  { alias: 'tick tok', kind: 'service', id: 'tiktok' },
  { alias: 'tik tock', kind: 'service', id: 'tiktok' },
  // English category words.
  { alias: 'social networks', kind: 'category', id: 'social' },
  { alias: 'social network', kind: 'category', id: 'social' },
  { alias: 'movies', kind: 'category', id: 'video' },
  { alias: 'films', kind: 'category', id: 'video' },
  { alias: 'tv shows', kind: 'category', id: 'video' },
  { alias: 'shows', kind: 'category', id: 'video' },
  { alias: 'livestreams', kind: 'category', id: 'video' },
  { alias: 'live streams', kind: 'category', id: 'video' },
  { alias: 'video games', kind: 'category', id: 'games' },
  { alias: 'videogames', kind: 'category', id: 'games' },
  { alias: 'game', kind: 'category', id: 'games' },
  { alias: 'messages', kind: 'category', id: 'messaging' },
  { alias: 'texting', kind: 'category', id: 'messaging' },
  { alias: 'texts', kind: 'category', id: 'messaging' },
  { alias: 'dms', kind: 'category', id: 'messaging' },
  { alias: 'online stores', kind: 'category', id: 'shopping' },
  { alias: 'newspapers', kind: 'category', id: 'news' },
]);

function refFor(kind: 'service' | 'category', id: string): TargetRef | undefined {
  if (kind === 'service') {
    const service = getService(id);
    return service && { kind, id: service.id, label: service.name };
  }
  const category = getCategory(id);
  return category && { kind, id: category.id, label: category.name };
}

const EXTRA_INDEX: ReadonlyMap<string, TargetRef> = (() => {
  const index = new Map<string, TargetRef>();
  for (const entry of PARSER_EXTRA_ALIASES) {
    const ref = refFor(entry.kind, entry.id);
    if (ref) index.set(aliasKey(entry.alias), ref);
  }
  return index;
})();

/**
 * The target `text` names exactly: catalog services first (the more specific target),
 * then catalog categories, then the parser-side aliases above.
 */
export function lookupAlias(text: string): TargetRef | undefined {
  const service = findServiceByAlias(text);
  if (service) return { kind: 'service', id: service.id, label: service.name };
  const category = findCategoryByAlias(text);
  if (category) return { kind: 'category', id: category.id, label: category.name };
  return EXTRA_INDEX.get(aliasKey(text));
}

/**
 * Aliases that are common words or too short to trust in free text: they count only right
 * after a block word («no», «sin», «bloquea»…), a list connector or another target (see
 * `scanTargets`). They are never fuzzy-matched. Two-letter keys are weak too, except the
 * unmistakable ones.
 */
const WEAK_KEYS: ReadonlySet<string> = new Set([
  'x',
  'video',
  'social',
  'chat',
  'comprar',
  'as',
  'max',
  'lol',
  'wa',
  'ea',
  'ali',
  'abc',
  'marca',
  'sport',
  'relevo',
  'jugar',
  'juego',
  'face',
  'prime',
  'chess',
  'league',
  'riot',
  'epic',
  'origin',
  'kick',
  'snap',
  'thread',
  'threads',
  'treads',
  'steam',
  'stim',
  'estim',
  'whats',
  'shorts',
  'reels',
  'valo',
  'atres',
  'tve',
  'vanguardia',
  'mine',
  'anime',
  'ajedrez',
  // English words that are also category aliases.
  'shows',
  'game',
  'texts',
]);
const STRONG_SHORT_KEYS: ReadonlySet<string> = new Set(['yt', 'ig', 'fb']);

/**
 * Weak aliases that are also interjections or chat noise («lol», «¡ea!», «wa»). A comma or
 * another target before them is not enough: they need a block word or a word connector
 * («ni», «y»…) next to them, so a trailing «…1h, lol» is laughter.
 */
export const INTERJECTION_KEYS: ReadonlySet<string> = new Set(['lol', 'ea', 'wa', 'abc']);

export function isWeakAliasKey(key: string): boolean {
  if (key.length <= 2) return !STRONG_SHORT_KEYS.has(key);
  return WEAK_KEYS.has(key);
}

interface FuzzyEntry {
  readonly key: string;
  readonly ref: TargetRef;
}

const MIN_FUZZY_LENGTH = 5;
let fuzzyIndex: Map<string, FuzzyEntry[]> | undefined;

function getFuzzyIndex(): Map<string, FuzzyEntry[]> {
  if (fuzzyIndex) return fuzzyIndex;
  const index = new Map<string, FuzzyEntry[]>();
  const add = (key: string, ref: TargetRef | undefined): void => {
    if (!ref || key.length < MIN_FUZZY_LENGTH || isWeakAliasKey(key)) return;
    const bucket = index.get(key[0] ?? '') ?? [];
    bucket.push({ key, ref });
    index.set(key[0] ?? '', bucket);
  };
  for (const entry of listAliases())
    add(entry.alias.replace(/ /g, ''), refFor(entry.kind, entry.id));
  for (const [key, ref] of EXTRA_INDEX) add(key, ref);
  fuzzyIndex = index;
  return index;
}

/** Optimal string alignment distance (Damerau-Levenshtein without repeated edits). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[] = new Array<number>(rows * cols).fill(0);
  const at = (i: number, j: number): number => d[i * cols + j] ?? 0;
  for (let i = 0; i < rows; i += 1) d[i * cols] = i;
  for (let j = 0; j < cols; j += 1) d[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = value;
    }
  }
  return at(a.length, b.length);
}

/**
 * The single target within edit distance 1 of `key` («instagarm» → Instagram), for keys of
 * at least 5 characters. The first letter must match (typos rarely touch it, and it keeps
 * «mates» away from «games»). Ambiguous keys match nothing.
 */
export function fuzzyLookup(key: string): TargetRef | undefined {
  if (key.length < MIN_FUZZY_LENGTH) return undefined;
  let found: TargetRef | undefined;
  for (const entry of getFuzzyIndex().get(key[0] ?? '') ?? []) {
    if (Math.abs(entry.key.length - key.length) > 1 || editDistance(entry.key, key) > 1) continue;
    if (found && (found.kind !== entry.ref.kind || found.id !== entry.ref.id)) return undefined;
    found = entry.ref;
  }
  return found;
}
