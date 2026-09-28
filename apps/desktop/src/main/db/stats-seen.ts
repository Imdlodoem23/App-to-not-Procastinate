/**
 * Which achievements the user has already seen in Logros (`progress.fresh` are the reached ones
 * that are not here yet). `userData/achievements-seen.json`, per epoch: «Borrar todos mis
 * datos» starts a new epoch, so the list starts over with it. Written atomically; a damaged
 * file reads as nothing seen.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACHIEVEMENTS, type AchievementId } from '@centrate/shared/points';

export const SEEN_FILE = 'achievements-seen.json';

const IDS: ReadonlySet<string> = new Set(ACHIEVEMENTS.map((a) => a.id));

export interface SeenAchievements {
  epoch: string | null;
  ids: AchievementId[];
}

/** Parses the stored file (anything unexpected: nothing seen). */
export function parseSeen(text: string | null): SeenAchievements {
  if (text === null) return { epoch: null, ids: [] };
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return { epoch: null, ids: [] };
    const r = raw as Record<string, unknown>;
    const epoch = typeof r['epoch'] === 'string' && r['epoch'].length <= 64 ? r['epoch'] : null;
    const ids = Array.isArray(r['ids'])
      ? [
          ...new Set(
            r['ids'].filter((id): id is AchievementId => typeof id === 'string' && IDS.has(id)),
          ),
        ]
      : [];
    return { epoch, ids };
  } catch {
    return { epoch: null, ids: [] };
  }
}

/** Reached achievements not seen in this epoch. */
export function freshAchievements(
  reached: readonly AchievementId[],
  seen: SeenAchievements,
  epoch: string | null,
): AchievementId[] {
  const known = seen.epoch === epoch ? new Set(seen.ids) : new Set<string>();
  return reached.filter((id) => !known.has(id));
}

export interface SeenStore {
  read(): SeenAchievements;
  write(value: SeenAchievements): void;
}

export function fileSeenStore(userDataDir: string): SeenStore {
  const path = join(userDataDir, SEEN_FILE);
  return {
    read() {
      try {
        return parseSeen(readFileSync(path, 'utf8'));
      } catch {
        return parseSeen(null);
      }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(value), 'utf8');
      renameSync(temp, path);
    },
  };
}

export function memorySeenStore(initial: SeenAchievements = { epoch: null, ids: [] }): SeenStore {
  let value = { epoch: initial.epoch, ids: [...initial.ids] };
  return {
    read: () => ({ epoch: value.epoch, ids: [...value.ids] }),
    write(next) {
      value = { epoch: next.epoch, ids: [...next.ids] };
    },
  };
}
