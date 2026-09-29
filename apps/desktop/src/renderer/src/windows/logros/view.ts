/**
 * The Logros window (PROMPT §7 «Logros», §10 «Ventanas de detalle › Logros»; ARCHITECTURE
 * §6.5), pure.
 *
 * - Header: «Logros: 3 de 8» and, on the right, the one reached last («Último: Una semana sin
 *   intentos»), or the new ones since Logros was last opened («Nuevo: 7 días de racha»).
 * - A 4-column grid with every achievement of `ACHIEVEMENTS` (points.ts) that can be earned, in
 *   its order: the badge over the name. The Study Mode ones (sessions, study hours) only show
 *   while Study Mode is (flag and guardian capability): a hidden feature's goals are hidden
 *   too, and the count leaves them out (PROMPT §10 «Oculta lo que no aplica»). Reached ones take the selected style in green (outline + tint, the
 *   badge's closed ring); pending ones keep the grey border (the badge's ring with its gap).
 * - The grid's help line says, for the achievement under the mouse or with the focus, how to
 *   get it and how far you are («Cumple tu objetivo diario 30 días seguidos · 12 de 30»), or
 *   when you got it («Conseguido el 24 de septiembre»).
 *
 * The statuses come from main (`achievements:list`, evaluated with `evaluateAchievements` over
 * the synced event log); names and «cómo conseguirlo» from `achievementText`.
 */
import { achievementText } from '@centrate/shared/i18n';
import {
  type Achievement,
  type AchievementId,
  type AchievementMetric,
} from '@centrate/shared/points';
import { formatInt, formatMinutes } from '../../../../shared/format';
import { activeLocale, intlTag } from '../../../../shared/i18n/locale';
import type { AchievementStatus, ProgressState } from '../../../../shared/platform';
import { isVisibleAchievement, progressCount, visibleAchievements } from './visible';
import { LOGROS } from './i18n';

const L = LOGROS;

/** Ids shared with the component, the fixtures (`help: {row: 'logros', item}`) and e2e. */
export const LGR_IDS = {
  root: 'lgr',
  section: 'lgr-grid',
  /** The grid's `TileRow` (its tiles are the achievement ids). */
  row: 'logros',
  retry: 'lgr-retry',
} as const;

export interface AchievementTileView {
  id: AchievementId;
  /** «7 días de racha». */
  title: string;
  achieved: boolean;
  /** Reached since Logros was last opened. */
  fresh: boolean;
  /** The help line while hovered or focused. */
  help: string;
  /** Alt + this key focuses it (a letter or digit of its name, unique in the grid). */
  mnemonic: string | undefined;
}

export interface LogrosView {
  title: string;
  /** «Último: …» / «Nuevo: …», or `null`. */
  datum: string | null;
  /** The datum in green when it announces something new. */
  datumFresh: boolean;
  tiles: AchievementTileView[];
  /** The grid's help when no achievement is hovered or focused. */
  rowHelp: string;
  /** Where a door puts the focus: the requested or new achievement, else `null`. */
  focus: AchievementId | null;
}

export interface LogrosInput {
  /** `achievements:list`, `null` until it answered. */
  list: readonly AchievementStatus[] | null;
  /** `snapshot.progress` (the count while the list loads). */
  progress: ProgressState | null;
  /** New since Logros was last opened, as it was when this door opened. */
  fresh: readonly AchievementId[];
  /** `DetailRequest.focus` (a «¡Logro!» notification click). */
  focus: AchievementId | null;
  /** Study Mode is shown (flag and capability): its achievements show and count. */
  study: boolean;
}

/** The name of an achievement in the active language. */
export function achievementTitle(id: AchievementId): string {
  return achievementText(id, activeLocale())?.title ?? id;
}

/** How to get it («Cumple tu objetivo diario 30 días seguidos»). */
export function achievementHow(id: AchievementId): string {
  return achievementText(id, activeLocale())?.help ?? '';
}

/** «24 de septiembre», «September 24» (local time). */
export function formatAchievedDay(ms: number): string {
  return new Intl.DateTimeFormat(intlTag(), { day: 'numeric', month: 'long' }).format(ms);
}

/** Minutes metrics read as durations («2 h 30 min de 10 h»), the rest as counts («12 de 30»). */
function isMinutes(metric: AchievementMetric): boolean {
  return metric === 'focusMinutesTotal';
}

/** How far a pending achievement is, or `null` when it has nothing to count (threshold 1). */
export function progressText(achievement: Achievement, current: number): string | null {
  if (achievement.threshold <= 1) return null;
  const now = Math.max(0, Math.min(current, achievement.threshold));
  if (isMinutes(achievement.metric)) {
    // «0 de 10 h» rather than «0 min de 10 h».
    const done = now > 0 ? formatMinutes(now) : formatInt(0);
    return L.help.minutes(done, formatMinutes(achievement.threshold));
  }
  return L.help.progress(formatInt(now), formatInt(achievement.threshold));
}

function helpOf(achievement: Achievement, status: AchievementStatus, fresh: boolean): string {
  if (status.achieved) {
    const at = status.achievedAt ? Date.parse(status.achievedAt) : Number.NaN;
    const day = Number.isFinite(at) ? formatAchievedDay(at) : null;
    if (fresh) return day ? L.help.freshOn(day) : L.help.fresh;
    return day ? L.help.achievedOn(day) : L.help.achieved;
  }
  const how = achievementHow(achievement.id);
  const progress = progressText(achievement, status.current);
  return progress ? L.help.pending(how, progress) : how;
}

function foldKey(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Alt + key of each name: its first letter or digit not taken by an earlier one or by
 * `reserved` («7 días de racha» 7, «Primera sesión» p, «Primer bloqueo» r…). `undefined` when a
 * name has none left (the audit would report it; eight names never run out).
 */
export function assignKeys(
  names: readonly string[],
  reserved: readonly string[] = [],
): (string | undefined)[] {
  const used = new Set(reserved.map(foldKey));
  return names.map((name) => {
    for (const char of name) {
      const key = foldKey(char);
      if (/^[a-z0-9]$/.test(key) && !used.has(key)) {
        used.add(key);
        return key;
      }
    }
    return undefined;
  });
}

/** The achievement reached last (by `achievedAt`), if any. */
function lastReached(list: readonly AchievementStatus[]): AchievementStatus | null {
  let last: AchievementStatus | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const status of list) {
    if (!status.achieved || !status.achievedAt) continue;
    const at = Date.parse(status.achievedAt);
    if (Number.isFinite(at) && at > lastAt) {
      last = status;
      lastAt = at;
    }
  }
  return last;
}

export function deriveLogrosView(input: LogrosInput): LogrosView {
  const { list, progress, study } = input;
  const shown = visibleAchievements(study);
  const visible = (list ?? []).filter((s) => isVisibleAchievement(s.id, study));
  const byId = new Map(visible.map((s) => [s.id, s] as const));
  const fresh = new Set(input.fresh.filter((id) => byId.get(id)?.achieved === true));

  // Keys over every shown name (not only the listed ones), so each keeps its key.
  const titles = shown.map((a) => achievementTitle(a.id));
  const keys = assignKeys(titles);
  const tiles: AchievementTileView[] = [];
  shown.forEach((a, index) => {
    const status = byId.get(a.id);
    if (!status) return;
    tiles.push({
      id: a.id,
      title: titles[index] ?? a.id,
      achieved: status.achieved,
      fresh: fresh.has(a.id),
      help: helpOf(a, status, fresh.has(a.id)),
      mnemonic: keys[index],
    });
  });

  const count = progress ? progressCount(progress, study) : null;
  const achieved = list ? tiles.filter((t) => t.achieved).length : (count?.achieved ?? null);
  const total = list ? tiles.length : (count?.total ?? shown.length);
  const title = achieved === null ? L.titleLoading : L.title(formatInt(achieved), formatInt(total));

  let datum: string | null = null;
  const freshTiles = tiles.filter((t) => t.fresh);
  const [firstFresh] = freshTiles;
  if (freshTiles.length > 1) datum = L.freshMany(formatInt(freshTiles.length));
  else if (firstFresh) datum = L.fresh(firstFresh.title);
  else if (list) {
    const last = lastReached(visible);
    if (last) datum = L.last(achievementTitle(last.id));
  }

  const requested = input.focus && tiles.some((t) => t.id === input.focus) ? input.focus : null;
  return {
    title,
    datum,
    datumFresh: freshTiles.length > 0,
    tiles,
    rowHelp: achieved === 0 ? L.rowHelpNone : L.rowHelp,
    focus: requested ?? firstFresh?.id ?? null,
  };
}

/**
 * Why the grid could not be read. The list comes from this computer's copy of the log, never
 * from the guardian, so the guardian's error copy would be wrong here.
 */
export function loadErrorText(): string {
  return L.errors.load;
}
