/**
 * Pairing with the guardian (docs/ARCHITECTURE.md §9.3): the app shows a 6-digit code,
 * the user types it in the popup or the guide, and the background claims a token with
 * `POST /v1/pairing/claim` (no token; the guardian checks the extension `Origin` and that
 * the loopback peer is a browser of the reported family).
 *
 * The answer (token, rules public key, guardian version) is stored in
 * `chrome.storage.local`. A new pairing replaces the previous one; the rules verified under
 * it are carried until their blocks end (client.ts), so pairing again never shortens a
 * block. Revocation (401 on any extension route) is handled in client.ts.
 *
 * Anchoring (a server the user starts on another loopback port must not take over):
 * - While rules verified under a key still have a live block or punishment, a claim whose
 *   `rulesPublicKey` is none of those keys is refused (`key_changed`) and the current
 *   pairing stays: new sessions and penalties the real guardian signs keep applying.
 * - Moving to another port than the current pairing's is refused while a Céntrate guardian
 *   still answers `/v1/health` on the current one (`guardian_elsewhere`).
 * A first pairing on a non-default port is not checked here (the app shows «Puerto: N»
 * only then); the guardian closes browsers without a protecting extension (§10.8).
 */

import { DEFAULT_GUARDIAN_PORT, GUARDIAN_NAME } from '@centrate/shared/guardian-api';
import type { BackgroundContext } from './client';
import { createPairingClient, describeError } from './client';
import { pruneRules } from './state';
import type { BrowserInfo, PairErrorCode } from './state';
import type { BackgroundStore, PairingRecord } from './storage';
import { isValidPort, parsePairingRecord } from './storage';

/** Characters people type between digits («048 392», «048-392»). */
const SEPARATORS = /[\s.\-\u00a0\u2007\u202f\u2010-\u2015\u2212]/g;

/**
 * The 6 digits of a typed code, or `null`. Full-width and other Unicode decimal digits
 * are folded to ASCII (a phone keyboard or an IME may produce them).
 */
export function normalizePairingCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const folded = input.normalize('NFKC').replace(SEPARATORS, '');
  return /^\d{6}$/.test(folded) ? folded : null;
}

export interface PairingDeps {
  browser(): Promise<BrowserInfo>;
  extVersion: string;
}

export type PairOutcome =
  | { ok: true; pairing: PairingRecord }
  | { ok: false; error: PairErrorCode; retryAfterSeconds: number | null };

/** Maps a failed claim to what the popup explains. */
export function pairErrorFor(code: string, status: number): PairErrorCode {
  switch (code) {
    case 'pairing_code_invalid':
      return 'code_invalid';
    case 'pairing_code_expired':
      return 'code_expired';
    case 'pairing_no_code':
      return 'no_code';
    case 'peer_not_browser':
    case 'insufficient_scope':
      return 'peer_not_browser';
    case 'origin_not_allowed':
    case 'host_not_allowed':
      return 'origin_not_allowed';
    case 'rate_limited':
      return 'rate_limited';
    case 'unreachable':
      return 'unreachable';
    case 'timeout':
      return 'timeout';
    case 'read_only':
      return 'read_only';
    default:
      if (status === 401) return 'code_invalid';
      if (status === 410) return 'code_expired';
      if (status === 429) return 'rate_limited';
      return 'unexpected';
  }
}

/**
 * The rules keys that still vouch for a live block or punishment at `nowMs`: a claim must
 * return one of them. An unreadable rules record that still holds (or whose end cannot be
 * read) pins the current pairing's key.
 */
export async function pinnedRulesKeys(store: BackgroundStore, nowMs: number): Promise<string[]> {
  const keys = new Set<string>();
  const record = await store.getRules();
  if (record !== null) {
    const verified = [{ rules: record.rules, rulesPublicKey: record.rulesPublicKey }];
    if (record.carried !== null) verified.push(record.carried);
    for (const { rules, rulesPublicKey } of verified) {
      const live = pruneRules(rules, nowMs);
      if (live.blocks.length > 0 || live.punishment !== null) keys.add(rulesPublicKey);
    }
  } else {
    const unreadable = await store.getUnreadableRules();
    const pairing = await store.getPairing();
    if (
      unreadable !== null &&
      pairing !== null &&
      (unreadable.holdUntil === null || unreadable.holdUntil > nowMs)
    ) {
      keys.add(pairing.rulesPublicKey);
    }
  }
  return [...keys];
}

/** True when a Céntrate guardian answers `/v1/health` on `port`. */
async function guardianAnswers(ctx: BackgroundContext, port: number): Promise<boolean> {
  try {
    const health = await createPairingClient(port, ctx.fetch).health();
    return health.name === GUARDIAN_NAME;
  } catch {
    return false;
  }
}

let inFlight: Promise<PairOutcome> | null = null;

/**
 * Claims a token with `code` (and `port` when the app shows «Puerto: N»). Concurrent
 * calls share the first claim: a code is single use.
 */
export function pairWithCode(
  ctx: BackgroundContext,
  deps: PairingDeps,
  input: { code: string; port?: number },
): Promise<PairOutcome> {
  inFlight ??= claim(ctx, deps, input).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function claim(
  ctx: BackgroundContext,
  deps: PairingDeps,
  input: { code: string; port?: number },
): Promise<PairOutcome> {
  const code = normalizePairingCode(input.code);
  const port = input.port ?? DEFAULT_GUARDIAN_PORT;
  if (code === null || !isValidPort(port)) {
    return { ok: false, error: 'invalid_format', retryAfterSeconds: null };
  }
  const current = await ctx.store.getPairing();
  if (current !== null && current.port !== port && (await guardianAnswers(ctx, current.port))) {
    return { ok: false, error: 'guardian_elsewhere', retryAfterSeconds: null };
  }
  const browser = await deps.browser();
  let response;
  try {
    response = await createPairingClient(port, ctx.fetch).claimPairing({
      code,
      browser: browser.family,
      browserVersion: browser.version,
      extVersion: deps.extVersion,
    });
  } catch (error) {
    const failure = describeError(error, ctx.now());
    return {
      ok: false,
      error: pairErrorFor(failure.code, failure.status),
      retryAfterSeconds: null,
    };
  }
  const pinned = await pinnedRulesKeys(ctx.store, ctx.now());
  if (pinned.length > 0 && !pinned.includes(response.rulesPublicKey)) {
    return { ok: false, error: 'key_changed', retryAfterSeconds: null };
  }
  // Store only what reads back as valid (a malformed claim answer must not half-pair).
  const pairing = parsePairingRecord({
    v: 1,
    extensionId: response.extensionId,
    token: response.token,
    rulesPublicKey: response.rulesPublicKey,
    guardianVersion: response.guardianVersion,
    boundOrigin: response.boundOrigin,
    browser: browser.family,
    port,
    pairedAt: ctx.now(),
    unauthorizedAt: null,
  } satisfies PairingRecord);
  if (pairing === null) return { ok: false, error: 'unexpected', retryAfterSeconds: null };
  await ctx.store.setPairing(pairing);
  await ctx.store.patchStatus({ lastError: null, heartbeatError: null });
  ctx.setLink('unknown');
  await ctx.changed('pairing');
  return { ok: true, pairing };
}
