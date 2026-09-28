/**
 * Typed, validated access to `chrome.storage.local` for the background.
 *
 * Three records:
 * - `pairing`: the extension token, the guardian's rules public key and what the claim
 *   returned. Written by pairing.ts; the token never leaves the background.
 * - `rules`: the last `/v1/ext/rules` body whose signature, nonce and version were verified,
 *   so a restarted service worker (or a browser start while the guardian is down) re-applies
 *   it at once. Also the rules «carried» from a previous pairing (see state.ts).
 * - `status`: timestamps and the last error, for the popup.
 * - `syncRequest`: a timestamp the incognito instance writes to ask the main one to sync
 *   now (index.ts; the two instances of Chromium's split mode share this storage).
 *
 * Every read is validated: a record with an unexpected shape reads as absent, never as a
 * half-trusted object. A stored rules record that no longer parses (an extension update
 * that tightened validation, or corruption) is not «no rules», though: `getUnreadableRules`
 * reports it, with the latest block end still readable in it, so the background keeps
 * whatever the browser enforces until then instead of lifting every block
 * (docs/ARCHITECTURE.md §8.8: never unblock early because the guardian is down).
 *
 * Records carry `v`. A change to a record's shape bumps its version and adds a migration
 * from the previous one to its parser, so an update never makes the cached rules unreadable.
 */

import type { BrowserFamily, ExtensionId } from '@centrate/shared/domain';
import { BROWSER_FAMILIES } from '@centrate/shared/domain';
import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import {
  DEFAULT_GUARDIAN_PORT,
  EXT_TOKEN_PREFIX,
  isExtRulesResponse,
} from '@centrate/shared/guardian-api';

export const STORAGE_KEYS = Object.freeze({
  pairing: 'centrate.pairing',
  rules: 'centrate.rules',
  status: 'centrate.status',
  syncRequest: 'centrate.syncRequest',
});

/** Current version of `RulesRecord` (see the module comment on migrations). */
export const RULES_RECORD_VERSION = 1;

/** What a successful `POST /v1/pairing/claim` leaves behind. */
export interface PairingRecord {
  v: 1;
  extensionId: ExtensionId;
  /** `cte_…`; sent only to the guardian, never to pages. */
  token: string;
  /** base64url SPKI of the guardian's ECDSA P-256 rules key. */
  rulesPublicKey: string;
  guardianVersion: string;
  boundOrigin: string | null;
  /** Family bound to the token at pairing; heartbeats must report the same. */
  browser: BrowserFamily;
  /** Guardian port (47600 unless the app showed «Puerto: N»). */
  port: number;
  /** `Date.now()` of the claim. */
  pairedAt: number;
  /**
   * `Date.now()` of the first 401 with this token (revoked from the app, or the guardian
   * lost its pairings). The token is kept so a transient 401 from something squatting the
   * port cannot unpair the extension; a verified rules response clears it.
   */
  unauthorizedAt: number | null;
}

/** Rules verified under a previous pairing (or rules key), kept until their blocks end (state.ts). */
export interface CarriedRules {
  rules: ExtRulesResponse;
  rulesPublicKey: string;
}

export interface RulesRecord {
  v: 1;
  /** The last verified body (parsed). */
  rules: ExtRulesResponse;
  /**
   * The pairing it was verified under (`PairingRecord.extensionId`). After a new pairing
   * the first request carries no version baseline, and these rules become `carried`.
   */
  extensionId: ExtensionId;
  /** `ETag` that came with it (`"r-<extRulesVersion>"`). */
  etag: string | null;
  /** The key that verified it. */
  rulesPublicKey: string;
  /** `Date.now()` when it was verified. */
  receivedAt: number;
  carried: CarriedRules | null;
}

/** A stored rules record that `parseRulesRecord` refuses. */
export interface UnreadableRules {
  /**
   * The latest end (epoch ms) of a block or punishment still readable in it, 0 when it
   * lists none; `null` when some end cannot be read (an unreadable time never ends a block).
   */
  holdUntil: number | null;
}

export interface StatusError {
  /** A guardian error code or a client code (`unreachable`, `invalid_signature`, …). */
  code: string;
  /** HTTP status, 0 without a response. */
  status: number;
  at: number;
}

export interface StatusRecord {
  v: 1;
  /** Last verified rules response (200 or 304). */
  lastRulesAt: number | null;
  /** Last accepted heartbeat. */
  lastHeartbeatAt: number | null;
  /** Guardian `extRulesVersion` in the last heartbeat response. */
  guardianExtRulesVersion: number | null;
  /** Last failed rules request (cleared by a verified response). */
  lastError: StatusError | null;
  /** Last failed heartbeat (cleared by an accepted one); `code` is `details.reason` for 403s. */
  heartbeatError: StatusError | null;
}

export const EMPTY_STATUS: Readonly<StatusRecord> = Object.freeze({
  v: 1,
  lastRulesAt: null,
  lastHeartbeatAt: null,
  guardianExtRulesVersion: null,
  lastError: null,
  heartbeatError: null,
});

/** The subset of `chrome.storage.StorageArea` the store needs (a fake in tests). */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** `chrome.storage.local` behind `StorageAreaLike` (promise API: Chrome 121+, Firefox 128+). */
export function chromeLocalArea(): StorageAreaLike {
  const area = chrome.storage.local;
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

export interface BackgroundStore {
  getPairing(): Promise<PairingRecord | null>;
  setPairing(record: PairingRecord): Promise<void>;
  clearPairing(): Promise<void>;
  /** The stored rules record, `null` when absent or unreadable. */
  getRules(): Promise<RulesRecord | null>;
  /** A stored rules record that could not be read, `null` when absent or readable. */
  getUnreadableRules(): Promise<UnreadableRules | null>;
  setRules(record: RulesRecord): Promise<void>;
  clearRules(): Promise<void>;
  getStatus(): Promise<StatusRecord>;
  /** Merges `patch` into the status record (serialized with other writes). */
  patchStatus(patch: Partial<Omit<StatusRecord, 'v'>>): Promise<StatusRecord>;
  /** Asks the main instance to sync now (written by the incognito instance). */
  requestSync(at: number): Promise<void>;
  /**
   * Drops the cached values of these storage keys: another instance wrote them
   * (`chrome.storage.onChanged`). Unknown keys are ignored.
   */
  invalidate(keys: readonly string[]): void;
}

interface Slot<T> {
  value: T | undefined;
  /** Bumped by every write and invalidation: a read that started before is not cached. */
  gen: number;
}

/**
 * A store over `area`. Values are cached in memory after the first read and dropped by
 * `invalidate` when another instance writes (index.ts wires `chrome.storage.onChanged`);
 * writes are serialized so a heartbeat and a rules sync that finish together cannot lose
 * each other's status fields.
 */
export function createBackgroundStore(area: StorageAreaLike): BackgroundStore {
  const pairing: Slot<PairingRecord | null> = { value: undefined, gen: 0 };
  const rules: Slot<{ record: RulesRecord | null; unreadable: UnreadableRules | null }> = {
    value: undefined,
    gen: 0,
  };
  const status: Slot<StatusRecord> = { value: undefined, gen: 0 };
  const slots: Readonly<Record<string, Slot<unknown>>> = {
    [STORAGE_KEYS.pairing]: pairing,
    [STORAGE_KEYS.rules]: rules,
    [STORAGE_KEYS.status]: status,
  };
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function load<T>(slot: Slot<T>, key: string, parse: (raw: unknown) => T): Promise<T> {
    if (slot.value !== undefined) return slot.value;
    const gen = slot.gen;
    const items = await area.get([key]);
    const value = parse(items[key]);
    if (slot.gen === gen) slot.value = value;
    return value;
  }

  function store<T>(slot: Slot<T>, value: T): void {
    slot.gen += 1;
    slot.value = value;
  }

  const readRules = (): Promise<{
    record: RulesRecord | null;
    unreadable: UnreadableRules | null;
  }> =>
    load(rules, STORAGE_KEYS.rules, (raw) => {
      const record = parseRulesRecord(raw);
      return {
        record,
        unreadable: record === null && raw !== undefined ? { holdUntil: readHoldUntil(raw) } : null,
      };
    });

  return {
    getPairing: () => load(pairing, STORAGE_KEYS.pairing, parsePairingRecord),
    setPairing: (record) =>
      serial(async () => {
        await area.set({ [STORAGE_KEYS.pairing]: record });
        store(pairing, record);
      }),
    clearPairing: () =>
      serial(async () => {
        await area.remove([STORAGE_KEYS.pairing]);
        store(pairing, null);
      }),
    getRules: async () => (await readRules()).record,
    getUnreadableRules: async () => (await readRules()).unreadable,
    setRules: (record) =>
      serial(async () => {
        await area.set({ [STORAGE_KEYS.rules]: record });
        store(rules, { record, unreadable: null });
      }),
    clearRules: () =>
      serial(async () => {
        await area.remove([STORAGE_KEYS.rules]);
        store(rules, { record: null, unreadable: null });
      }),
    getStatus: () => load(status, STORAGE_KEYS.status, parseStatusRecord),
    patchStatus: (patch) =>
      serial(async () => {
        const current = await load(status, STORAGE_KEYS.status, parseStatusRecord);
        const next: StatusRecord = { ...current, ...patch, v: 1 };
        await area.set({ [STORAGE_KEYS.status]: next });
        store(status, next);
        return next;
      }),
    requestSync: (at) => serial(() => area.set({ [STORAGE_KEYS.syncRequest]: at })),
    invalidate(keys) {
      for (const key of keys) {
        const slot = slots[key];
        if (slot === undefined) continue;
        slot.gen += 1;
        slot.value = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Validation of stored values
// ---------------------------------------------------------------------------------------

type Loose = Record<string, unknown>;

const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTimeOrNull = (v: unknown): v is number | null => v === null || isTime(v);
const isText = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65_535;
}

export function parsePairingRecord(v: unknown): PairingRecord | null {
  if (!isObject(v) || v['v'] !== 1) return null;
  const { extensionId, token, rulesPublicKey, guardianVersion, boundOrigin, browser } = v;
  if (typeof extensionId !== 'string' || !extensionId.startsWith('ext_')) return null;
  if (!isText(token, 256) || !token.startsWith(EXT_TOKEN_PREFIX)) return null;
  if (!isText(rulesPublicKey, 1024) || !BASE64URL.test(rulesPublicKey)) return null;
  if (!isText(guardianVersion, 64)) return null;
  if (boundOrigin !== null && !isText(boundOrigin, 256)) return null;
  if (!(BROWSER_FAMILIES as readonly unknown[]).includes(browser)) return null;
  const port = v['port'] ?? DEFAULT_GUARDIAN_PORT;
  if (!isValidPort(port) || !isTime(v['pairedAt']) || !isTimeOrNull(v['unauthorizedAt'] ?? null)) {
    return null;
  }
  return {
    v: 1,
    extensionId: extensionId as ExtensionId,
    token,
    rulesPublicKey,
    guardianVersion,
    boundOrigin: boundOrigin as string | null,
    browser: browser as BrowserFamily,
    port,
    pairedAt: v['pairedAt'] as number,
    unauthorizedAt: (v['unauthorizedAt'] ?? null) as number | null,
  };
}

function parseCarried(v: unknown): CarriedRules | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || !isExtRulesResponse(v['rules']) || !isText(v['rulesPublicKey'], 1024)) {
    return undefined;
  }
  return { rules: v['rules'], rulesPublicKey: v['rulesPublicKey'] };
}

export function parseRulesRecord(v: unknown): RulesRecord | null {
  if (!isObject(v) || v['v'] !== RULES_RECORD_VERSION) return null;
  const { rules, etag, rulesPublicKey, receivedAt, extensionId } = v;
  if (!isExtRulesResponse(rules)) return null;
  if (typeof extensionId !== 'string' || !extensionId.startsWith('ext_')) return null;
  if (etag !== null && !isText(etag, 256)) return null;
  if (!isText(rulesPublicKey, 1024) || !isTime(receivedAt)) return null;
  const carried = parseCarried(v['carried']);
  if (carried === undefined) return null;
  return {
    v: 1,
    rules,
    extensionId: extensionId as ExtensionId,
    etag: etag as string | null,
    rulesPublicKey,
    receivedAt,
    carried,
  };
}

/**
 * `UnreadableRules.holdUntil` of a stored value `parseRulesRecord` refused: reads only the
 * `endsAt` of the blocks and punishments of `rules` and `carried.rules`, which every past
 * and future shape keeps. `null` when a block list or an end cannot be read.
 */
export function readHoldUntil(raw: unknown): number | null {
  if (!isObject(raw) || !isObject(raw['rules'])) return null;
  const carried = raw['carried'];
  const bodies = [raw['rules'], isObject(carried) ? carried['rules'] : undefined];
  let latest = 0;
  const end = (value: unknown): number | null => {
    const t = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  for (const body of bodies) {
    if (body === undefined) continue;
    if (!isObject(body) || !Array.isArray(body['blocks'])) return null;
    const ends: unknown[] = body['blocks'].map((b: unknown) => (isObject(b) ? b['endsAt'] : null));
    const punishment = body['punishment'];
    if (punishment !== null && punishment !== undefined) {
      ends.push(isObject(punishment) ? punishment['endsAt'] : null);
    }
    for (const value of ends) {
      const t = end(value);
      if (t === null) return null;
      latest = Math.max(latest, t);
    }
  }
  return latest;
}

export function parseStatusRecord(v: unknown): StatusRecord {
  if (!isObject(v) || v['v'] !== 1) return { ...EMPTY_STATUS };
  const pickTime = (key: string): number | null => {
    const value = v[key];
    return isTime(value) ? value : null;
  };
  const pickError = (key: string): StatusError | null => {
    const error = v[key];
    return isObject(error) &&
      isText(error['code'], 64) &&
      typeof error['status'] === 'number' &&
      isTime(error['at'])
      ? { code: error['code'], status: error['status'], at: error['at'] }
      : null;
  };
  return {
    v: 1,
    lastRulesAt: pickTime('lastRulesAt'),
    lastHeartbeatAt: pickTime('lastHeartbeatAt'),
    guardianExtRulesVersion: pickTime('guardianExtRulesVersion'),
    lastError: pickError('lastError'),
    heartbeatError: pickError('heartbeatError'),
  };
}
