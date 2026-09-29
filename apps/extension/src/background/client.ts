/**
 * The guardian client for the extension and the `/v1/ext/rules` sync.
 *
 * Every request goes through the shared `createGuardianClient` (`@centrate/shared`), which
 * sends a fresh nonce and checks, before anything is returned, the ECDSA P-256 signature
 * with the pinned `rulesPublicKey`, the echoed nonce and that `extRulesVersion` is not
 * older than the one applied (docs/ARCHITECTURE.md §8.8, §14). Only then is the body
 * persisted and handed to the rules appliers.
 *
 * The long poll (`waitVersion` + `waitMs` ≤ 25 s) keeps a pending request open; each
 * answer writes to `chrome.storage`, which resets the worker's idle timer, and the 30 s
 * `chrome.alarms` tick (index.ts) restarts the loop whenever MV3 suspended the worker.
 *
 * A 304 carries no signature, nonce or version: anything squatting the port can send one.
 * It only keeps the link `connected` for a signed body younger than `RULES_PROOF_MAX_AGE_MS`
 * and before that body's `nextChangeAt`; past that horizon the request carries no ETag, so
 * only a new signed 200 confirms the link and a 304 is refused (`invalid_response`).
 */

import type { GuardianClient } from '@centrate/shared/guardian-api';
import {
  GuardianApiError,
  createGuardianClient,
  guardianBaseUrl,
} from '@centrate/shared/guardian-api';
import type { GuardianLink } from './state';
import { LONG_POLL_WAIT_MS, mergeCarriedRules, pruneRules } from './state';
import type {
  BackgroundStore,
  CarriedRules,
  PairingRecord,
  RulesRecord,
  StatusError,
  StatusRecord,
} from './storage';

/** What the sync, the heartbeat and the pairing need from the background. */
export interface BackgroundContext {
  store: BackgroundStore;
  /** `Date.now()` (a fake clock in tests). */
  now(): number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  getLink(): GuardianLink;
  /** Records the outcome of the latest rules request (in memory). */
  setLink(link: GuardianLink): void;
  /**
   * Something the pages or the appliers care about changed: `rules` (a new verified body),
   * `link`, `pairing` (claimed or marked unauthorized) or `status` (heartbeat, errors).
   */
  changed(what: 'rules' | 'link' | 'pairing' | 'status'): Promise<void>;
}

/** A client that authenticates with the paired extension token and pins the rules key. */
export function createExtensionClient(
  pairing: Pick<PairingRecord, 'token' | 'rulesPublicKey' | 'port'>,
  fetchImpl?: typeof fetch,
): GuardianClient {
  return createGuardianClient({
    baseUrl: guardianBaseUrl(pairing.port),
    token: pairing.token,
    rulesPublicKey: pairing.rulesPublicKey,
    fetch: fetchImpl,
  });
}

/** An anonymous client for `POST /v1/pairing/claim` (the only route without a token). */
export function createPairingClient(port: number, fetchImpl?: typeof fetch): GuardianClient {
  return createGuardianClient({ baseUrl: guardianBaseUrl(port), fetch: fetchImpl });
}

/** `{ code, status }` of any thrown value (`unexpected` when it is not a guardian error). */
export function describeError(error: unknown, at: number): StatusError {
  if (error instanceof GuardianApiError) {
    const reason = error.details?.['reason'];
    const code =
      error.code === 'insufficient_scope' && typeof reason === 'string' && reason.length <= 64
        ? reason
        : String(error.code).slice(0, 64);
    return { code: code.length > 0 ? code : 'unexpected', status: error.status, at };
  }
  return { code: 'unexpected', status: 0, at };
}

/** The link state an error puts the background in. */
export function linkForError(error: StatusError): GuardianLink {
  if (error.status === 401) return 'unauthorized';
  if (error.code === 'unreachable' || error.code === 'timeout') return 'unreachable';
  if (
    error.code === 'invalid_signature' ||
    error.code === 'stale_rules' ||
    error.code === 'invalid_response'
  ) {
    return 'untrusted';
  }
  return 'error';
}

/**
 * The link as the last recorded outcome shows it: the error of a request that failed after
 * the last verified answer, else `connected` once any answer was verified. The main
 * instance starts from it; the incognito instance (index.ts), which never syncs, uses it
 * throughout.
 */
export function linkFromStatus(status: StatusRecord): GuardianLink {
  const error = status.lastError;
  if (error !== null && error.at > (status.lastRulesAt ?? -1)) return linkForError(error);
  return status.lastRulesAt !== null ? 'connected' : 'unknown';
}

/** A 304 vouches for the cached body only while it is younger than this. */
export const RULES_PROOF_MAX_AGE_MS = 5 * 60_000;

/**
 * True when only a signed 200 may confirm `record` at `nowMs`: it was verified
 * `RULES_PROOF_MAX_AGE_MS` ago or more (or the clock went back), or its `nextChangeAt` has
 * come (a block or allowance ended, so the guardian has news or is holding an ended block).
 */
export function needsSignedProof(record: RulesRecord, nowMs: number): boolean {
  const age = nowMs - record.receivedAt;
  if (age < 0 || age >= RULES_PROOF_MAX_AGE_MS) return true;
  const next = record.rules.nextChangeAt === null ? NaN : Date.parse(record.rules.nextChangeAt);
  return !Number.isNaN(next) && nowMs >= next;
}

/** True when `record` was verified under `pairing` (same claim, same key). */
export function sameBaseline(record: RulesRecord | null, pairing: PairingRecord): boolean {
  return (
    record !== null &&
    record.extensionId === pairing.extensionId &&
    record.rulesPublicKey === pairing.rulesPublicKey
  );
}

/**
 * Rules to carry after a new pairing: whatever the previous record still enforced
 * (its primary rules and anything it already carried), pruned; `null` once no block of
 * theirs is live.
 */
export function carryForward(record: RulesRecord | null, nowMs: number): CarriedRules | null {
  if (record === null) return null;
  let rules = pruneRules(record.rules, nowMs);
  let key = record.rulesPublicKey;
  if (record.carried !== null) {
    const older = pruneRules(record.carried.rules, nowMs);
    if (rules.blocks.length === 0) {
      rules = older;
      key = record.carried.rulesPublicKey;
    } else {
      rules = mergeCarriedRules(rules, older);
    }
  }
  return rules.blocks.length > 0 ? { rules, rulesPublicKey: key } : null;
}

/**
 * `updated`: a new verified body was stored; `unchanged`: 304, or the same version;
 * `unpaired`; `unauthorized`: 401; `unreachable`: no answer; `rejected`: an answer that
 * failed verification; `error`: another error status; `superseded`: aborted, or the
 * pairing changed meanwhile (nothing recorded).
 */
export type SyncOutcome =
  | 'updated'
  | 'unchanged'
  | 'unpaired'
  | 'unauthorized'
  | 'unreachable'
  | 'rejected'
  | 'error'
  | 'superseded';

/** `base` (or the global fetch) that also aborts with `signal`. */
function fetchWithSignal(
  base: typeof fetch | undefined,
  signal: AbortSignal | undefined,
): typeof fetch | undefined {
  if (signal === undefined) return base;
  const inner: typeof fetch = base ?? ((input, init) => globalThis.fetch(input, init));
  return (input, init) =>
    inner(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    });
}

async function stillCurrent(ctx: BackgroundContext, pairing: PairingRecord): Promise<boolean> {
  const latest = await ctx.store.getPairing();
  return latest !== null && latest.extensionId === pairing.extensionId;
}

/**
 * One `GET /v1/ext/rules`. With a baseline (rules verified under this pairing) it sends
 * `waitVersion`, waits up to `waitMs` while connected, and sends `If-None-Match` unless the
 * baseline needs a signed proof (`needsSignedProof`); right after a pairing, or while the
 * token is marked unauthorized, it asks for a fresh signed body at once. A failed or
 * unverifiable answer never touches the stored rules.
 */
export async function syncRulesOnce(
  ctx: BackgroundContext,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<SyncOutcome> {
  const pairing = await ctx.store.getPairing();
  if (pairing === null) return 'unpaired';
  const record = await ctx.store.getRules();
  // Rules verified under this pairing are the baseline: never accept an older version.
  const current = sameBaseline(record, pairing) ? record : null;
  // After a 401 only a signed 200 proves the token works again: no ETag, no waiting.
  const unauthorized = pairing.unauthorizedAt !== null;
  // Past the baseline's horizon a bare 304 proves nothing either: no ETag.
  const fresh = unauthorized || (current !== null && needsSignedProof(current, ctx.now()));
  // Until an answer confirms the link (worker start, guardian back after being down, an
  // error), ask without waiting: a long poll on unchanged rules would keep the popup on
  // «Guardián no responde» for up to 25 s after the guardian is back.
  const wait = !unauthorized && ctx.getLink() === 'connected';
  const client = createExtensionClient(pairing, fetchWithSignal(ctx.fetch, options.signal));
  const waitMs = Math.max(0, Math.min(options.waitMs ?? LONG_POLL_WAIT_MS, LONG_POLL_WAIT_MS));
  const superseded = async (): Promise<boolean> =>
    options.signal?.aborted === true || !(await stillCurrent(ctx, pairing));

  let result: Awaited<ReturnType<GuardianClient['getExtRules']>>;
  try {
    result = await client.getExtRules(
      current === null
        ? {}
        : {
            etag: fresh ? null : current.etag,
            waitVersion: current.rules.extRulesVersion,
            waitMs: wait ? waitMs : undefined,
          },
    );
  } catch (error) {
    if (await superseded()) return 'superseded';
    return fail(ctx, pairing, describeError(error, ctx.now()));
  }
  if (await superseded()) return 'superseded';

  const now = ctx.now();
  if (result.notModified) {
    // A 304 carries no signature: it only confirms the ETag we sent, if we sent one.
    if (current === null || fresh) {
      return fail(ctx, pairing, { code: 'invalid_response', status: 304, at: now });
    }
    await ctx.store.patchStatus({ lastRulesAt: now, lastError: null });
    await setLink(ctx, 'connected');
    return 'unchanged';
  }

  const rules = result.rules;
  // A new pairing (another claim or another key) cannot shorten what the old one enforced.
  let carried = current !== null ? current.carried : carryForward(record, now);
  if (carried !== null && pruneRules(carried.rules, now).blocks.length === 0) carried = null;
  const unchanged =
    current !== null &&
    current.rules.extRulesVersion === rules.extRulesVersion &&
    current.carried === carried;
  await ctx.store.setRules({
    v: 1,
    rules,
    extensionId: pairing.extensionId,
    etag: result.etag,
    rulesPublicKey: pairing.rulesPublicKey,
    receivedAt: now,
    carried,
  });
  if (pairing.unauthorizedAt !== null) {
    await ctx.store.setPairing({ ...pairing, unauthorizedAt: null });
    await ctx.changed('pairing');
  }
  await ctx.store.patchStatus({ lastRulesAt: now, lastError: null });
  await setLink(ctx, 'connected');
  if (unchanged) return 'unchanged';
  await ctx.changed('rules');
  return 'updated';
}

async function setLink(ctx: BackgroundContext, link: GuardianLink): Promise<void> {
  if (ctx.getLink() === link) return;
  ctx.setLink(link);
  await ctx.changed('link');
}

async function fail(
  ctx: BackgroundContext,
  pairing: PairingRecord,
  error: StatusError,
): Promise<SyncOutcome> {
  const link = linkForError(error);
  await ctx.store.patchStatus({ lastError: error });
  if (link === 'unauthorized') await markUnauthorized(ctx, pairing, error.at);
  await setLink(ctx, link);
  await ctx.changed('status');
  switch (link) {
    case 'unauthorized':
      return 'unauthorized';
    case 'unreachable':
      return 'unreachable';
    case 'untrusted':
      return 'rejected';
    default:
      return 'error';
  }
}

/**
 * 401: the app revoked this extension, or the guardian lost its pairings. The pairing is
 * kept but marked (the popup asks to pair again, heartbeats stop, the rules request is
 * only retried on the 30 s tick); the cached rules stay in force until their `endsAt`.
 */
export async function markUnauthorized(
  ctx: BackgroundContext,
  pairing: PairingRecord,
  at: number,
): Promise<void> {
  if (pairing.unauthorizedAt !== null) return;
  await ctx.store.setPairing({ ...pairing, unauthorizedAt: at });
  await ctx.changed('pairing');
}

// ---------------------------------------------------------------------------------------
// Long-poll loop
// ---------------------------------------------------------------------------------------

export interface RulesLoopOptions {
  /** Delays after consecutive failures; past the last one the loop stops until the tick. */
  retryDelaysMs?: readonly number[];
  /** Minimum time between two requests (a server answering at once cannot spin the loop). */
  minPeriodMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RulesLoop {
  /** Starts the loop unless it is running (on start, on the tick). */
  ensureRunning(): void;
  /**
   * Drops the pending request and any retry delay and asks again at once (after pairing,
   * when a heartbeat reports another version, when the guide obtained a permission).
   */
  restart(): void;
  isRunning(): boolean;
  /** Resolves when the current run ends (tests). */
  idle(): Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

/**
 * One loop per worker, so at most one long poll per token from here (the guardian allows
 * four). It stops when unpaired or unauthorized, and once the retry delays run out; the
 * 30 s tick calls `ensureRunning` again.
 */
export function createRulesLoop(ctx: BackgroundContext, options: RulesLoopOptions = {}): RulesLoop {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const minPeriodMs = options.minPeriodMs ?? 1_000;
  const sleep = options.sleep ?? abortableSleep;
  let running: Promise<void> | null = null;
  /** Aborted by `restart()`: the pending request and any delay. */
  let interrupt = new AbortController();

  async function run(): Promise<void> {
    let failures = 0;
    for (;;) {
      if (interrupt.signal.aborted) interrupt = new AbortController();
      const signal = interrupt.signal;
      const startedAt = ctx.now();
      let outcome: SyncOutcome;
      try {
        outcome = await syncRulesOnce(ctx, { waitMs: LONG_POLL_WAIT_MS, signal });
      } catch {
        outcome = 'error'; // storage failure: retry like a guardian error
      }
      if (signal.aborted || outcome === 'superseded') {
        failures = 0;
        continue;
      }
      if (outcome === 'unpaired' || outcome === 'unauthorized') return;
      if (outcome === 'updated' || outcome === 'unchanged') {
        failures = 0;
        const elapsed = ctx.now() - startedAt;
        if (elapsed < minPeriodMs) await sleep(minPeriodMs - elapsed, signal);
        continue;
      }
      const delay = retryDelays[failures];
      failures += 1;
      if (delay === undefined) return;
      await sleep(delay, signal);
    }
  }

  const start = (): void => {
    running = run().finally(() => {
      running = null;
    });
  };

  return {
    ensureRunning() {
      if (running === null) start();
    },
    restart() {
      interrupt.abort();
      if (running === null) start();
    },
    isRunning: () => running !== null,
    idle: () => running ?? Promise.resolve(),
  };
}
