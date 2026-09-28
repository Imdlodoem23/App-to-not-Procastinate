/**
 * Payload validators of the **send** channels (renderer → main, fire-and-forget), which
 * MAIN-WINDOW handles in `ipc-window.ts`. Invoke payloads are MAIN-GUARDIAN's
 * (`src/main/ipc-guards.ts`). Pure.
 *
 * Structured clone already guarantees plain data; these check shape and bounds so a
 * compromised renderer can only send what a real one would. Drafts are checked loosely here
 * (main only routes them back to the main window's card); the create request built from
 * them is validated strictly by `isCreateBlockRequest` before anything reaches the guardian.
 */
import { BLOCK_MODES, type BlockMode, type TargetSpec } from '@centrate/shared/domain';
import { GUIDE_IDS, type SendChannel, type SendPayload } from '../../shared/ipc';
import {
  AJUSTES_GROUPS,
  isDetailName,
  isIntentId,
  type BlockDraft,
  type DetailRequest,
  type DraftEnd,
  type DraftSeed,
  type LayoutReport,
} from '../../shared/ui-state';

const MAX_HEIGHT = 20_000;
const MAX_LIST = 256;
const MAX_ITEM = 253;
const MAX_REASON = 280;
const MAX_TEXT = 500;
const MAX_ERROR_MESSAGE = 20_000;
const MAX_STACK = 100_000;

type Guard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => isShortString(item, MAX_ITEM) && item.length > 0)
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBlockMode(value: unknown): value is BlockMode {
  return typeof value === 'string' && (BLOCK_MODES as readonly string[]).includes(value);
}

export function isTargetSpecShape(value: unknown): value is TargetSpec {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'serviceIds',
      'categoryIds',
      'appIds',
      'customDomains',
      'customProcesses',
    ]) &&
    isStringList(value['serviceIds']) &&
    isStringList(value['categoryIds']) &&
    isStringList(value['appIds']) &&
    isStringList(value['customDomains']) &&
    isStringList(value['customProcesses'])
  );
}

function isIsoString(value: unknown): value is string {
  return isShortString(value, 40) && !Number.isNaN(Date.parse(value));
}

export function isDraftEnd(value: unknown): value is DraftEnd {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'duration') {
    return (
      hasOnlyKeys(value, ['kind', 'minutes']) &&
      isNonNegativeInt(value['minutes']) &&
      value['minutes'] <= 100_000
    );
  }
  if (value['kind'] === 'until') {
    return hasOnlyKeys(value, ['kind', 'endsAt']) && isIsoString(value['endsAt']);
  }
  return false;
}

export function isBlockDraft(value: unknown): value is BlockDraft {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['targets', 'whitelistOnly', 'savedTargets', 'mode', 'end', 'reason']) &&
    isTargetSpecShape(value['targets']) &&
    typeof value['whitelistOnly'] === 'boolean' &&
    (value['savedTargets'] === null || isTargetSpecShape(value['savedTargets'])) &&
    isBlockMode(value['mode']) &&
    isDraftEnd(value['end']) &&
    isShortString(value['reason'], MAX_REASON)
  );
}

export function isDraftSeed(value: unknown): value is DraftSeed {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['phrase', 'targets', 'end', 'mode', 'reason']) &&
    (value['phrase'] === null || isShortString(value['phrase'], MAX_TEXT)) &&
    (value['targets'] === null || isTargetSpecShape(value['targets'])) &&
    (value['end'] === null || isDraftEnd(value['end'])) &&
    (value['mode'] === null || isBlockMode(value['mode'])) &&
    (value['reason'] === null || isShortString(value['reason'], MAX_REASON))
  );
}

const BLOQUEOS_FOCUS = ['form', 'active', 'templates', 'schedules'] as const;

export function isDetailRequest(value: unknown): value is DetailRequest {
  if (!isRecord(value) || !isDetailName(value['name'])) return false;
  switch (value['name']) {
    case 'bloqueos':
      return (
        hasOnlyKeys(value, ['name', 'seed', 'focus']) &&
        (value['seed'] === null || isDraftSeed(value['seed'])) &&
        (value['focus'] === null ||
          (typeof value['focus'] === 'string' &&
            (BLOQUEOS_FOCUS as readonly string[]).includes(value['focus'])))
      );
    case 'emergencia':
      return (
        hasOnlyKeys(value, ['name', 'blockIds']) &&
        (value['blockIds'] === null ||
          (isStringList(value['blockIds']) &&
            value['blockIds'].every((id) => id.startsWith('blk_'))))
      );
    case 'ajustes':
      return (
        hasOnlyKeys(value, ['name', 'group']) &&
        (value['group'] === null ||
          (typeof value['group'] === 'string' &&
            (AJUSTES_GROUPS as readonly string[]).includes(value['group'])))
      );
  }
}

export function isLayoutReport(value: unknown): value is LayoutReport {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['height', 'density', 'scroll']) &&
    typeof value['height'] === 'number' &&
    Number.isFinite(value['height']) &&
    value['height'] > 0 &&
    value['height'] <= MAX_HEIGHT &&
    (value['density'] === 'regular' || value['density'] === 'compact') &&
    typeof value['scroll'] === 'boolean'
  );
}

function isNull(value: unknown): value is null {
  return value === null;
}

/** One guard per send channel (the typecheck makes the table exhaustive). */
export const SEND_GUARDS: { readonly [C in SendChannel]: Guard<SendPayload<C>> } = {
  'window:layout': isLayoutReport,
  'window:show-ack': (v): v is SendPayload<'window:show-ack'> =>
    isRecord(v) &&
    hasOnlyKeys(v, ['seq', 'layout']) &&
    isNonNegativeInt(v['seq']) &&
    isLayoutReport(v['layout']),
  'window:ready': (v): v is SendPayload<'window:ready'> =>
    isRecord(v) &&
    hasOnlyKeys(v, ['stateId', 'rev']) &&
    (v['stateId'] === null || isShortString(v['stateId'], 64)) &&
    isNonNegativeInt(v['rev']),
  'window:hide': isNull,
  'window:open-detail': isDetailRequest,
  'window:close-detail': isNull,
  'window:confirm-draft': (v): v is SendPayload<'window:confirm-draft'> =>
    isRecord(v) && hasOnlyKeys(v, ['draft']) && isBlockDraft(v['draft']),
  'block:create-dismiss': (v): v is SendPayload<'block:create-dismiss'> =>
    isRecord(v) && hasOnlyKeys(v, ['intentId']) && isIntentId(v['intentId']),
  'app:open-guide': (v): v is SendPayload<'app:open-guide'> =>
    isRecord(v) &&
    hasOnlyKeys(v, ['guide']) &&
    typeof v['guide'] === 'string' &&
    (GUIDE_IDS as readonly string[]).includes(v['guide']),
  'app:quit': isNull,
  'app:renderer-error': (v): v is SendPayload<'app:renderer-error'> =>
    isRecord(v) &&
    hasOnlyKeys(v, ['message', 'stack']) &&
    isShortString(v['message'], MAX_ERROR_MESSAGE) &&
    (v['stack'] === null || isShortString(v['stack'], MAX_STACK)),
};
