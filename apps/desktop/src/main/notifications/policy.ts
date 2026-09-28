/**
 * Notification policy, pure (docs/DESKTOP.md §6.4, PROMPT §5 and §10 «agrupadas y nunca más
 * de una por minuto»).
 *
 * Kinds and sources:
 * - block started: `block_created` with source `user` or `schedule`;
 * - five minutes left: a main timer at `endsAt − 5 min` for blocks lasting ≥ 10 min, once
 *   per `(blockId, endsAt)`;
 * - block finished: `block_completed` of a `manual` or `schedule` block («Hecho. +80 puntos»);
 * - attempt: `attempt` whose envelope `points < 0` («Intento bloqueado: −10 puntos»).
 *
 * Grouping: one notification carries everything queued, titled by the highest priority kind
 * (finished > started > five minutes > attempts) with the rest in one «También: …» line.
 * Events older than 2 minutes never notify (no storm after sleep or a restart).
 */
import { getService } from '@centrate/shared/catalog';
import type { BlockId, WireEvent } from '@centrate/shared/domain';
import { isKnownEvent } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import { formatClock, formatPoints, targetsLabel } from '../../shared/format';
import { UI_TIMINGS } from '../../shared/ui-state';
import { NOTIFY_ES } from './i18n/es';
import type { NotificationContent } from './types';

export type NoticeKind = 'block_finished' | 'block_started' | 'five_minutes' | 'attempt';

/** Lower comes first. */
export const NOTICE_PRIORITY: Readonly<Record<NoticeKind, number>> = Object.freeze({
  block_finished: 0,
  block_started: 1,
  five_minutes: 2,
  attempt: 3,
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
}

/** Notices from one page of `/v1/events` (already filtered by age). */
export function noticesFromEvents(events: readonly WireEvent[], nowMs: number): Notice[] {
  const out: Notice[] = [];
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
 * Dropped at flush: a five-minute notice whose block ended or was extended; a started notice
 * whose block is no longer active (the state already reflects its event but lacks the block,
 * or its end passed).
 */
export function isStale(
  notice: Notice,
  state: GuardianStateResponse | null,
  nowMs: number,
): boolean {
  if (notice.kind === 'block_finished' || notice.kind === 'attempt') return false;
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
      title = NOTIFY_ES.finished.title(group.length);
      body = NOTIFY_ES.finished.body(sum > 0 ? signedPoints(sum) : null);
      break;
    case 'block_started':
      title = NOTIFY_ES.started.title(group.length);
      body = NOTIFY_ES.started.body(
        latest.label ?? '',
        formatClock(latest.endsAtMs ?? latest.atMs),
      );
      break;
    case 'five_minutes':
      title = NOTIFY_ES.fiveMinutes.title;
      body = NOTIFY_ES.fiveMinutes.body(
        latest.label ?? '',
        formatClock(latest.endsAtMs ?? latest.atMs),
      );
      break;
    case 'attempt': {
      title = NOTIFY_ES.attempt.title(group.length, signedPoints(sum));
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
        return NOTIFY_ES.finished.also(g.length, points > 0 ? signedPoints(points) : null);
      case 'block_started':
        return NOTIFY_ES.started.also(g.length);
      case 'five_minutes':
        return NOTIFY_ES.fiveMinutes.also;
      case 'attempt':
        return NOTIFY_ES.attempt.also(g.length, signedPoints(points));
    }
  });
  if (also.length > 0) {
    const line = NOTIFY_ES.also(also);
    body = body ? `${body}\n${line}` : line;
  }
  return { title, body, kinds };
}
