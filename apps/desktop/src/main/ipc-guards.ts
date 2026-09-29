/**
 * Payload validators for every invoke channel (docs/DESKTOP.md §4, §11). Main checks the
 * sender first (`WindowHost.windowOf`), then the payload shape here, before any handler
 * runs: exact keys, types, lengths and id formats. The guardian validates again; these only
 * keep malformed or hostile renderer input away from the core.
 *
 * Pure module: no Electron import.
 */
import { isIdOf } from '@centrate/shared/domain';
import {
  GUARDIAN_LIMITS,
  isCreateBlockRequest,
  isDailyLimitInput,
} from '@centrate/shared/guardian-api';
import type { InvokeChannel, InvokeReq } from '../shared/ipc';
import { PHASE5_INVOKE_GUARDS } from '../shared/ipc-payloads';
import { isIntentId } from '../shared/ui-state';
import { isTemplateInput, isUiPrefsPatch } from './db/prefs-store';
import { isExtendEntryId } from './guardian/extend-queue';

type Guard<C extends InvokeChannel> = (req: unknown) => req is InvokeReq<C>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A plain object with exactly these keys. */
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && own.every((k) => keys.includes(k));
}

/** `null` payload (undefined is tolerated: a renderer may omit the argument). */
function isNone(v: unknown): v is null {
  return v === null || v === undefined;
}

function isBlockIds(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= GUARDIAN_LIMITS.emergencyMaxBlocks &&
    v.every((id) => isIdOf('block', id)) &&
    new Set(v).size === v.length
  );
}

export const INVOKE_GUARDS: { [C in InvokeChannel]: Guard<C> } = {
  'app:init': (req): req is null => isNone(req),

  'block:create': (req): req is InvokeReq<'block:create'> =>
    exact(req, ['intentId', 'request']) &&
    isIntentId(req['intentId']) &&
    isCreateBlockRequest(req['request']),

  'block:create-retry': (req): req is InvokeReq<'block:create-retry'> =>
    exact(req, ['intentId']) && isIntentId(req['intentId']),

  'block:extend': (req): req is InvokeReq<'block:extend'> =>
    exact(req, ['blockId', 'addMinutes']) &&
    isIdOf('block', req['blockId']) &&
    typeof req['addMinutes'] === 'number' &&
    Number.isInteger(req['addMinutes']) &&
    req['addMinutes'] >= 1 &&
    req['addMinutes'] <= GUARDIAN_LIMITS.extendMaxAddMinutes,

  'block:extend-undo': (req): req is InvokeReq<'block:extend-undo'> =>
    exact(req, ['entryId']) && isExtendEntryId(req['entryId']),

  'block:extend-retry': (req): req is InvokeReq<'block:extend-retry'> =>
    exact(req, ['entryId']) && isExtendEntryId(req['entryId']),

  'emergency:preview': (req): req is InvokeReq<'emergency:preview'> =>
    exact(req, ['blockIds']) && (req['blockIds'] === null || isBlockIds(req['blockIds'])),

  'emergency:request': (req): req is InvokeReq<'emergency:request'> =>
    exact(req, ['intentId', 'blockIds', 'phrase']) &&
    isIntentId(req['intentId']) &&
    isBlockIds(req['blockIds']) &&
    (req['blockIds'] as unknown[]).length > 0 &&
    typeof req['phrase'] === 'string' &&
    req['phrase'].length <= GUARDIAN_LIMITS.phraseMaxLength,

  'emergency:cancel': (req): req is InvokeReq<'emergency:cancel'> =>
    exact(req, ['id']) && isIdOf('emergency', req['id']),

  'emergency:confirm': (req): req is InvokeReq<'emergency:confirm'> =>
    exact(req, ['intentId', 'id']) && isIntentId(req['intentId']) && isIdOf('emergency', req['id']),

  'schedules:list': (req): req is null => isNone(req),

  'schedules:set-enabled': (req): req is InvokeReq<'schedules:set-enabled'> =>
    exact(req, ['id', 'enabled']) &&
    isIdOf('schedule', req['id']) &&
    typeof req['enabled'] === 'boolean',

  'limits:list': (req): req is null => isNone(req),

  'limits:create': (req): req is InvokeReq<'limits:create'> =>
    exact(req, ['intentId', 'input']) &&
    isIntentId(req['intentId']) &&
    isDailyLimitInput(req['input']),

  'limits:update': (req): req is InvokeReq<'limits:update'> =>
    exact(req, ['id', 'input']) && isIdOf('limit', req['id']) && isDailyLimitInput(req['input']),

  'limits:delete': (req): req is InvokeReq<'limits:delete'> =>
    exact(req, ['id']) && isIdOf('limit', req['id']),

  'templates:save': (req): req is InvokeReq<'templates:save'> => isTemplateInput(req),

  'templates:delete': (req): req is InvokeReq<'templates:delete'> =>
    exact(req, ['id']) &&
    typeof req['id'] === 'string' &&
    req['id'].length >= 1 &&
    req['id'].length <= 80,

  'prefs:set': (req): req is InvokeReq<'prefs:set'> => isUiPrefsPatch(req),

  'pairing:new-code': (req): req is null => isNone(req),

  'diagnostics:copy': (req): req is null => isNone(req),

  'data:delete': (req): req is InvokeReq<'data:delete'> =>
    exact(req, ['intentId', 'confirm']) &&
    isIntentId(req['intentId']) &&
    typeof req['confirm'] === 'string' &&
    req['confirm'].length <= 32,

  'guardian:repair': (req): req is null => isNone(req),

  'system:process-names': (req): req is null => isNone(req),

  // Phase 5: validators written with the contract (docs/DESKTOP.md §15).
  ...PHASE5_INVOKE_GUARDS,
};

/** Channels whose answer is not a `CommandResult` (a bad payload gets their own fallback). */
export const NON_RESULT_CHANNELS: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  'app:init',
  'block:extend-undo',
]);

export function isValidInvokePayload<C extends InvokeChannel>(
  channel: C,
  req: unknown,
): req is InvokeReq<C> {
  const guard = INVOKE_GUARDS[channel] as (req: unknown) => boolean;
  try {
    return guard(req);
  } catch {
    return false;
  }
}
