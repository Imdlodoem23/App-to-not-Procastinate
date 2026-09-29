/**
 * Notification policy, pure (docs/DESKTOP.md §6.4, PROMPT §5 and §10 «agrupadas y nunca más
 * de una por minuto»).
 *
 * Kinds and sources:
 * - block started: `block_created` with source `user` or `schedule`;
 * - five minutes left: a main timer at `endsAt − 5 min` for blocks lasting ≥ 10 min, once
 *   per `(blockId, endsAt)`;
 * - block finished: `block_completed` of a `manual` or `schedule` block («Hecho. +80 puntos»);
 * - attempt: `attempt` whose envelope `points < 0` («Intento bloqueado: −10 puntos»);
 * - daily limits: `limit_warning` («Te quedan 5 min de YouTube hoy») and `limit_reached`
 *   («Has gastado tus 30 min de YouTube de hoy»). Limit blocks never say «Bloqueo iniciado»
 *   (their `block_created` has source `limit`) nor «Quedan 5 min» (they end at midnight).
 *
 * Grouping: one notification carries everything queued, titled by the highest priority kind
 * (finished > limit reached > started > limit warning > five minutes > attempts) with the rest in one «También: …» line.
 * Events older than 2 minutes never notify (no storm after sleep or a restart).
 */
import { getService } from '@centrate/shared/catalog';
import type { BlockId, WireEvent } from '@centrate/shared/domain';
import { isKnownEvent } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { formatClock, formatPoints, targetsLabel } from '../../shared/format';
import { LIMIT_TEXT, isLimitBlock } from '../../shared/limits';
import type { LimitAlert } from '../contracts';
import { UI_TIMINGS } from '../../shared/ui-state';
import { NOTIFY } from './i18n';
import type { NotificationContent } from './types';

export type NoticeKind =
  | 'block_finished'
  | 'limit_reached'
  | 'block_started'
  | 'limit_warning'
  | 'five_minutes'
  | 'attempt';

/** Lower comes first. */
export const NOTICE_PRIORITY: Readonly<Record<NoticeKind, number>> = Object.freeze({
  block_finished: 0,
  limit_reached: 1,
  block_started: 2,
  limit_warning: 3,
  five_minutes: 4,
  attempt: 5,
});

/** Events whose display time is older than this never notify. */
export const EVENT_NOTIFY_MAX_AGE_MS = 120_000;
/** Blocks shorter than this get no «Quedan 5 min». */
export const FIVE_MINUTES_MIN_BLOCK_MS = 10 * 60_000;
/** An `endsAt` that moved more than this (an extension) makes a five-minute notice stale. */
export const END_TOLERANCE_MS = 60_000;

export interface Notice {
  kind: NoticeKind;
  /** Display time it refers to (event time, or the five-minute mark). */
  atMs: number;
  /** Source event, for the staleness check against `state.lastEventSeq`. */
  epoch: string | null;
  seq: number | null;
  blockId: BlockId | null;
  /** Display end of the block (started, five minutes). */
  endsAtMs: number | null;
  /** «YouTube, Instagram» (started, five minutes) or the service of an attempt. */
  label: string | null;
  /** Signed points (finished > 0, attempt < 0). */
  points: number;
  /**
   * Daily limits: the allowance (`limit_reached`) or the whole minutes left
   * (`limit_warning`); the limit's name is in `label`.
   */
  minutes?: number;
}

/** Notices from one page of `/v1/events` (already filtered by age). */
export function noticesFromEvents(events: readonly WireEvent[], nowMs: number): Notice[] {
  const out: Notice[] = [];
  // The display end of each limit block in the page (written with its `limit_reached`).
  const limitEnds = new Map<string, number>();
  for (const event of events) {
    if (!isKnownEvent(event) || event.type !== 'block_created') continue;
    if (event.data.source !== 'limit') continue;
    const endsAtMs = Date.parse(event.data.block.endsAt) + event.wallOffsetMs;
    if (Number.isFinite(endsAtMs)) limitEnds.set(event.data.block.id, endsAtMs);
  }
  for (const event of events) {
    if (!isKnownEvent(event)) continue;
    const atMs = Date.parse(event.at) + event.wallOffsetMs;
    if (!Number.isFinite(atMs) || nowMs - atMs > EVENT_NOTIFY_MAX_AGE_MS) continue;
    const base = { atMs, epoch: event.epoch, seq: event.seq };
    switch (event.type) {
      case 'block_created': {
        const { block, source } = event.data;
        if (source !== 'user' && source !== 'schedule') break;
        out.push({
          ...base,
          kind: 'block_started',
          blockId: block.id,
          endsAtMs: Date.parse(block.endsAt) + event.wallOffsetMs,
          label: targetsLabel(block.targets, block.whitelistOnly, 2),
          points: 0,
        });
        break;
      }
      case 'block_completed': {
        if (event.data.kind !== 'manual' && event.data.kind !== 'schedule') break;
        out.push({
          ...base,
          kind: 'block_finished',
          blockId: event.data.blockId,
          endsAtMs: null,
          label: null,
          points: event.points,
        });
        break;
      }
      case 'limit_warning': {
        const d = event.data;
        out.push({
          ...base,
          kind: 'limit_warning',
          blockId: null,
          endsAtMs: null,
          label: d.name,
          points: 0,
          minutes: Math.max(1, Math.ceil(d.remainingSeconds / 60)),
        });
        break;
      }
      case 'limit_reached': {
        const d = event.data;
        out.push({
          ...base,
          kind: 'limit_reached',
          // `blockId: null`: nothing was blocked (less than a minute before midnight).
          blockId: d.blockId,
          endsAtMs: d.blockId === null ? null : (limitEnds.get(d.blockId) ?? null),
          label: d.name,
          points: 0,
          minutes: d.dailyMinutes,
        });
        break;
      }
      case 'attempt': {
        if (event.points >= 0) break;
        const serviceId = event.data.serviceId;
        out.push({
          ...base,
          kind: 'attempt',
          blockId: null,
          endsAtMs: null,
          label: serviceId ? (getService(serviceId)?.name ?? null) : null,
          points: event.points,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export function fiveMinuteKey(blockId: BlockId, endsAtMs: number): string {
  return `${blockId}@${endsAtMs}`;
}

export interface FiveMinuteDue {
  key: string;
  dueAt: number;
  notice: Notice;
}

/**
 * The next «Quedan 5 min» to schedule: blocks lasting ≥ 10 min whose mark
 * (`endsAt − 5 min`) is still ahead and not fired for this `(blockId, endsAt)`.
 */
export function nextFiveMinuteDue(
  state: GuardianStateResponse | null,
  fired: ReadonlySet<string>,
  nowMs: number,
): FiveMinuteDue | null {
  if (!state) return null;
  let best: FiveMinuteDue | null = null;
  for (const block of state.blocks) {
    // A limit block ends at midnight: «Quedan 5 min» would only announce the new day.
    if (isLimitBlock(block)) continue;
    const endsAtMs = Date.parse(block.endsAt);
    const startsAtMs = Date.parse(block.startsAt);
    if (!Number.isFinite(endsAtMs) || endsAtMs - startsAtMs < FIVE_MINUTES_MIN_BLOCK_MS) continue;
    const dueAt = endsAtMs - UI_TIMINGS.fiveMinutesLeftMs;
    const key = fiveMinuteKey(block.id, endsAtMs);
    if (dueAt <= nowMs || fired.has(key)) continue;
    if (best === null || dueAt < best.dueAt) {
      best = {
        key,
        dueAt,
        notice: {
          kind: 'five_minutes',
          atMs: dueAt,
          epoch: state.epoch,
          seq: null,
          blockId: block.id,
          endsAtMs,
          label: targetsLabel(block.targets, block.whitelistOnly, 2),
          points: 0,
        },
      };
    }
  }
  return best;
}

/**
 * A `limit_reached` notice whose block's end was not in its page gets it from the state
 * (display time); the others are returned as they are.
 */
export function withLimitBlockEnds(
  notices: readonly Notice[],
  state: GuardianStateResponse | null,
): Notice[] {
  return notices.map((n) => {
    if (n.kind !== 'limit_reached' || n.blockId === null || n.endsAtMs !== null || !state) {
      return n;
    }
    const block = state.blocks.find((b) => b.id === n.blockId);
    const endsAtMs = block ? Date.parse(block.endsAt) : Number.NaN;
    return Number.isFinite(endsAtMs) ? { ...n, endsAtMs } : n;
  });
}

/**
 * Dropped at flush: a five-minute notice whose block ended or was extended; a started notice
 * whose block is no longer active (the state already reflects its event but lacks the block,
 * or its end passed).
 */
export function isStale(
  notice: Notice,
  state: GuardianStateResponse | null,
  nowMs: number,
): boolean {
  if (
    notice.kind === 'block_finished' ||
    notice.kind === 'attempt' ||
    notice.kind === 'limit_warning' ||
    notice.kind === 'limit_reached'
  ) {
    return false;
  }
  if (notice.endsAtMs !== null && notice.endsAtMs <= nowMs) return true;
  if (!state || notice.blockId === null) return false;
  const block = state.blocks.find((b) => b.id === notice.blockId) ?? null;
  if (notice.kind === 'five_minutes') {
    if (!block) return true;
    return Math.abs(Date.parse(block.endsAt) - (notice.endsAtMs ?? 0)) > END_TOLERANCE_MS;
  }
  // block_started: only judge by a state that already includes its event.
  const reflects =
    notice.seq !== null && state.epoch === notice.epoch && state.lastEventSeq >= notice.seq;
  return reflects && block === null;
}

function signedPoints(points: number): string {
  return formatPoints(points, { signed: true });
}

/** One notification for everything queued, or `null` when nothing is left. */
export function composeNotification(notices: readonly Notice[]): NotificationContent | null {
  if (notices.length === 0) return null;
  const groups = new Map<NoticeKind, Notice[]>();
  for (const n of notices) groups.set(n.kind, [...(groups.get(n.kind) ?? []), n]);
  const kinds = [...groups.keys()].sort((a, b) => NOTICE_PRIORITY[a] - NOTICE_PRIORITY[b]);
  const [top, ...rest] = kinds;
  if (top === undefined) return null;
  const group = groups.get(top) ?? [];
  const latest = group.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  const sum = group.reduce((total, n) => total + n.points, 0);
  let title: string;
  let body: string;
  switch (top) {
    case 'block_finished':
      title = NOTIFY.finished.title(group.length);
      body = NOTIFY.finished.body(sum > 0 ? signedPoints(sum) : null);
      break;
    case 'block_started':
      title = NOTIFY.started.title(group.length);
      body = NOTIFY.started.body(latest.label ?? '', formatClock(latest.endsAtMs ?? latest.atMs));
      break;
    case 'five_minutes':
      title = NOTIFY.fiveMinutes.title;
      body = NOTIFY.fiveMinutes.body(
        latest.label ?? '',
        formatClock(latest.endsAtMs ?? latest.atMs),
      );
      break;
    case 'limit_reached': {
      title =
        group.length === 1
          ? LIMIT_TEXT.reached(latest.label ?? '', latest.minutes ?? 0)
          : NOTIFY.limits.reachedTitleMany(group.length);
      // Only a real block, with its own end (the guardian's time zone, not this machine's).
      body =
        latest.blockId !== null && latest.endsAtMs !== null
          ? NOTIFY.limits.reachedBody(formatClock(latest.endsAtMs))
          : '';
      break;
    }
    case 'limit_warning': {
      title =
        group.length === 1
          ? LIMIT_TEXT.warning(latest.label ?? '', latest.minutes ?? 5)
          : NOTIFY.limits.warningTitleMany(group.length);
      const names = [...new Set(group.map((n) => n.label).filter((l): l is string => !!l))];
      body = group.length === 1 ? LIMIT_TEXT.title : names.slice(0, 2).join(', ');
      break;
    }
    case 'attempt': {
      title = NOTIFY.attempt.title(group.length, signedPoints(sum));
      const labels = [...new Set(group.map((n) => n.label).filter((l): l is string => !!l))];
      body = labels.slice(0, 2).join(', ');
      break;
    }
  }
  const also = rest.map((kind) => {
    const g = groups.get(kind) ?? [];
    const points = g.reduce((total, n) => total + n.points, 0);
    switch (kind) {
      case 'block_finished':
        return NOTIFY.finished.also(g.length, points > 0 ? signedPoints(points) : null);
      case 'block_started':
        return NOTIFY.started.also(g.length);
      case 'five_minutes':
        return NOTIFY.fiveMinutes.also;
      case 'attempt':
        return NOTIFY.attempt.also(g.length, signedPoints(points));
      case 'limit_reached':
        return NOTIFY.limits.reachedAlso(g.length);
      case 'limit_warning':
        return NOTIFY.limits.warningAlso(g.length);
    }
  });
  if (also.length > 0) {
    const line = NOTIFY.also(also);
    body = body ? `${body}\n${line}` : line;
  }
  return { title, body, kinds };
}

/**
 * The OSD's daily-limit alerts from a page of fresh events (the same age rule as
 * notifications): «Te quedan 5 min de YouTube hoy», «Has gastado tus 30 min de YouTube de hoy».
 */
export function limitAlertsFromEvents(events: readonly WireEvent[], nowMs: number): LimitAlert[] {
  const out: LimitAlert[] = [];
  for (const notice of noticesFromEvents(events, nowMs)) {
    if (notice.kind === 'limit_warning') {
      out.push({
        kind: 'warning',
        text: LIMIT_TEXT.warning(notice.label ?? '', notice.minutes ?? 5),
      });
    } else if (notice.kind === 'limit_reached') {
      out.push({
        kind: 'reached',
        text: LIMIT_TEXT.reached(notice.label ?? '', notice.minutes ?? 0),
      });
    }
  }
  return out;
}
