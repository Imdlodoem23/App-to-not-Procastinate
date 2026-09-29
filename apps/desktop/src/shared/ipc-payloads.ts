/**
 * Payload validators of the Phase 5 channels (docs/DESKTOP.md §15), written with the contract
 * so main never trusts a renderer: `src/main/ipc-guards.ts` spreads
 * `PHASE5_INVOKE_GUARDS` into its table and `src/main/windows/send-guards.ts` spreads
 * `PHASE5_SEND_GUARDS`. Exact keys, types, bounds and id formats; the guardian validates its
 * own requests again (`isScheduleInput`, `isSettingsRequest` are its validators).
 *
 * Pure module: no DOM, Node or Electron imports.
 */
import { isIdOf } from '@centrate/shared/domain';
import { isScheduleInput, isSettingsRequest } from '@centrate/shared/guardian-api';
import { isLocalDay } from '@centrate/shared/points';
import type { InvokeReq, Phase5InvokeChannel, Phase5SendChannel, SendPayload } from './ipc';
import { OSD_ICONS, OSD_TEXT_MAX, OSD_TONES } from './platform';
import { isSoundId } from './prefs';
import { STATS_LIMITS, isCsvExportKind, isEventLogFilter, isStatsRange } from './stats';
import { isIntentId } from './ui-state';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A plain object with exactly these keys. */
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && own.every((k) => keys.includes(k));
}

/** An invoke without payload (`undefined` tolerated: a renderer may omit the argument). */
function isNone(v: unknown): v is null {
  return v === null || v === undefined;
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** `REWARD_OFFERS` ids look like `youtube-15`. */
const OFFER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Opaque event-log cursor (`${epoch}:${seq}` or similar). */
const CURSOR_RE = /^[A-Za-z0-9_:.-]+$/;

function isPosition(v: unknown): v is { x: number; y: number } {
  return (
    exact(v, ['x', 'y']) && intIn(v['x'], -100_000, 100_000) && intIn(v['y'], -100_000, 100_000)
  );
}

type InvokeGuard<C extends Phase5InvokeChannel> = (req: unknown) => req is InvokeReq<C>;
type SendGuard<C extends Phase5SendChannel> = (payload: unknown) => payload is SendPayload<C>;

export const PHASE5_INVOKE_GUARDS: { readonly [C in Phase5InvokeChannel]: InvokeGuard<C> } = {
  'schedules:create': (req): req is InvokeReq<'schedules:create'> =>
    exact(req, ['intentId', 'input']) &&
    isIntentId(req['intentId']) &&
    isScheduleInput(req['input']),

  'schedules:update': (req): req is InvokeReq<'schedules:update'> =>
    exact(req, ['id', 'input']) && isIdOf('schedule', req['id']) && isScheduleInput(req['input']),

  'schedules:delete': (req): req is InvokeReq<'schedules:delete'> =>
    exact(req, ['id']) && isIdOf('schedule', req['id']),

  'settings:get': (req): req is null => isNone(req),

  'settings:put': (req): req is InvokeReq<'settings:put'> =>
    exact(req, ['settings']) && isSettingsRequest(req['settings']),

  'rewards:list': (req): req is null => isNone(req),

  'rewards:redeem': (req): req is InvokeReq<'rewards:redeem'> =>
    exact(req, ['intentId', 'offerId']) &&
    isIntentId(req['intentId']) &&
    typeof req['offerId'] === 'string' &&
    OFFER_ID_RE.test(req['offerId']),

  'points:summary': (req): req is null => isNone(req),

  'achievements:list': (req): req is null => isNone(req),

  'stats:overview': (req): req is InvokeReq<'stats:overview'> =>
    exact(req, ['range', 'anchor']) &&
    isStatsRange(req['range']) &&
    (req['anchor'] === null || isLocalDay(req['anchor'])),

  'stats:heatmap': (req): req is InvokeReq<'stats:heatmap'> =>
    exact(req, ['end', 'weeks']) &&
    (req['end'] === null || isLocalDay(req['end'])) &&
    intIn(req['weeks'], 1, STATS_LIMITS.heatmapMaxWeeks),

  'stats:events': (req): req is InvokeReq<'stats:events'> =>
    exact(req, ['filter', 'before', 'limit']) &&
    isEventLogFilter(req['filter']) &&
    (req['before'] === null ||
      (typeof req['before'] === 'string' &&
        req['before'].length <= STATS_LIMITS.cursorMaxLength &&
        CURSOR_RE.test(req['before']))) &&
    intIn(req['limit'], 1, STATS_LIMITS.eventPageMax),

  'stats:export-csv': (req): req is InvokeReq<'stats:export-csv'> =>
    exact(req, ['kind']) && isCsvExportKind(req['kind']),

  'system:processes': (req): req is null => isNone(req),

  'activewin:request-permission': (req): req is null => isNone(req),

  'updater:check': (req): req is null => isNone(req),

  'updater:download': (req): req is null => isNone(req),

  'updater:install': (req): req is null => isNone(req),

  'sounds:load': (req): req is InvokeReq<'sounds:load'> =>
    exact(req, ['sound']) && isSoundId(req['sound']),

  'onboarding:install-guardian': (req): req is null => isNone(req),

  'onboarding:test-camera': (req): req is null => isNone(req),
};

export const PHASE5_SEND_GUARDS: { readonly [C in Phase5SendChannel]: SendGuard<C> } = {
  'mini-timer:toggle': (v): v is SendPayload<'mini-timer:toggle'> =>
    exact(v, ['visible']) && (v['visible'] === null || typeof v['visible'] === 'boolean'),

  'mini-timer:position': (v): v is SendPayload<'mini-timer:position'> =>
    exact(v, ['position']) && (v['position'] === null || isPosition(v['position'])),

  'osd:show': (v): v is SendPayload<'osd:show'> =>
    exact(v, ['text', 'icon', 'tone']) &&
    typeof v['text'] === 'string' &&
    v['text'].trim().length > 0 &&
    v['text'].length <= OSD_TEXT_MAX &&
    (OSD_ICONS as readonly unknown[]).includes(v['icon']) &&
    (OSD_TONES as readonly unknown[]).includes(v['tone']),

  'nuclear:emergency-exit': (v): v is null => v === null,
};
