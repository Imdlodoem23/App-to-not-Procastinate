// Test doubles for the background: in-memory storage, a fake guardian that signs rules
// with a real ECDSA P-256 key, and a BackgroundContext that records what changed.
import type { ExtRulesResponse } from '@centrate/shared/guardian-api';
import { computeRulesSignature, generateRulesKeyPair } from '@centrate/shared/guardian-api';
import type { BackgroundContext } from '../../src/background/client';
import type { GuardianLink } from '../../src/background/state';
import type { BackgroundStore, PairingRecord, StorageAreaLike } from '../../src/background/storage';
import { createBackgroundStore } from '../../src/background/storage';

export const MIN = 60_000;
export const NOW = Date.parse('2026-09-28T10:00:00.000Z');
export const iso = (ms: number): string => new Date(ms).toISOString();

export const BLK_A = 'blk_0123456789abcdefAAAA' as const;
export const BLK_B = 'blk_0123456789abcdefBBBB' as const;
export const BLK_W = 'blk_0123456789abcdefWWWW' as const;
export const EXT_1 = 'ext_0123456789abcdef0001' as const;
export const EXT_2 = 'ext_0123456789abcdef0002' as const;
export const TOKEN_1 = 'cte_token_one_0123456789abcdef';
export const TOKEN_2 = 'cte_token_two_0123456789abcdef';

export const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
export const TIKTOK_HOSTS = ['tiktok.com', 'www.tiktok.com'];

export interface MemoryArea extends StorageAreaLike {
  data: Map<string, unknown>;
  writes: number;
}

/** chrome.storage.local in memory; values are cloned like the real (JSON) storage. */
export function memoryArea(initial: Record<string, unknown> = {}): MemoryArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: MemoryArea = {
    data,
    writes: 0,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (data.has(key)) out[key] = structuredClone(data.get(key));
      return out;
    },
    async set(items) {
      area.writes += 1;
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of keys) data.delete(key);
    },
  };
  return area;
}

export function rulesFixture(overrides: Partial<ExtRulesResponse> = {}): ExtRulesResponse {
  return {
    extRulesVersion: 100,
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    serverNow: iso(NOW),
    blockDomains: [...YOUTUBE_HOSTS],
    excludedDomains: ['accounts.youtube.com'],
    whitelist: null,
    blocks: [
      {
        id: BLK_A,
        kind: 'manual',
        mode: 'strict',
        endsAt: iso(NOW + 30 * MIN),
        reason: 'Quiero aprobar mates',
        serviceIds: ['youtube'],
        domains: [...YOUTUBE_HOSTS],
        whitelistOnly: false,
      },
    ],
    allowances: [],
    punishment: null,
    nextChangeAt: iso(NOW + 30 * MIN),
    penaltiesEnabled: true,
    ...overrides,
  };
}

export function pairingFixture(
  rulesPublicKey: string,
  overrides: Partial<PairingRecord> = {},
): PairingRecord {
  return {
    v: 1,
    extensionId: EXT_1,
    token: TOKEN_1,
    rulesPublicKey,
    guardianVersion: '0.1.0',
    boundOrigin: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah',
    browser: 'chrome',
    port: 47600,
    pairedAt: NOW - 60 * MIN,
    unauthorizedAt: null,
    ...overrides,
  };
}

export interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

type Mode = 'ok' | 'down' | 'unsigned' | 'wrong-key' | 'replay' | 'hang';

export interface FakeGuardian {
  fetch: typeof fetch;
  calls: Captured[];
  publicKey: string;
  /** The body served by `/v1/ext/rules` (the nonce is echoed from each request). */
  rules: ExtRulesResponse;
  mode: Mode;
  /** Tokens the guardian accepts (others get 401). */
  tokens: Set<string>;
  /** The pairing code the app is showing, or `null`. */
  code: string | null;
  /** What the next claim returns. */
  claim: { extensionId: string; token: string };
  /** Forced error for the next heartbeat: [status, code, details]. */
  heartbeatError: [number, string, Record<string, unknown> | null] | null;
  heartbeatVersion: number | null;
  rulesCalls(): Captured[];
}

const errorBody = (status: number, code: string, details: Record<string, unknown> | null = null) =>
  new Response(JSON.stringify({ error: { code, message: code, details } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const jsonBody = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export async function fakeGuardian(
  rules: ExtRulesResponse = rulesFixture(),
): Promise<FakeGuardian> {
  const { privateKey, publicKey } = await generateRulesKeyPair();
  const other = await generateRulesKeyPair();
  const calls: Captured[] = [];
  let replayable: { body: string; signature: string } | null = null;

  const g: FakeGuardian = {
    calls,
    publicKey,
    rules,
    mode: 'ok',
    tokens: new Set([TOKEN_1]),
    code: '048392',
    claim: { extensionId: EXT_1, token: TOKEN_1 },
    heartbeatError: null,
    heartbeatVersion: null,
    rulesCalls: () => calls.filter((c) => c.url.pathname === '/v1/ext/rules'),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const text = typeof init?.body === 'string' ? init.body : null;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: text === null ? null : JSON.parse(text),
      });
      if (g.mode === 'down') throw new TypeError('Failed to fetch');
      if (g.mode === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      const auth = headers.get('Authorization');
      const authorized = auth !== null && g.tokens.has(auth.replace(/^Bearer /, ''));

      switch (url.pathname) {
        case '/v1/pairing/claim': {
          const body = JSON.parse(text ?? '{}') as { code?: string };
          if (g.code === null) return errorBody(409, 'pairing_no_code');
          if (body.code !== g.code) return errorBody(401, 'pairing_code_invalid');
          g.code = null;
          g.tokens.add(g.claim.token);
          return jsonBody(201, {
            extensionId: g.claim.extensionId,
            token: g.claim.token,
            guardianVersion: '0.1.0',
            boundOrigin: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah',
            rulesPublicKey: publicKey,
          });
        }
        case '/v1/ext/rules': {
          if (!authorized) return errorBody(401, 'unauthorized');
          const version = g.rules.extRulesVersion;
          const etag = `"r-${version}"`;
          if (headers.get('If-None-Match') === etag) {
            return new Response(null, { status: 304, headers: { ETag: etag } });
          }
          if (g.mode === 'replay' && replayable !== null) {
            return new Response(replayable.body, {
              status: 200,
              headers: { 'X-Centrate-Signature': replayable.signature, ETag: etag },
            });
          }
          const body = JSON.stringify({ ...g.rules, nonce: url.searchParams.get('nonce') });
          const key = g.mode === 'wrong-key' ? other.privateKey : privateKey;
          const signature = await computeRulesSignature(body, key);
          replayable = { body, signature };
          const extra: Record<string, string> =
            g.mode === 'unsigned' ? {} : { 'X-Centrate-Signature': signature };
          return new Response(body, { status: 200, headers: { ETag: etag, ...extra } });
        }
        case '/v1/ext/heartbeat': {
          if (!authorized) return errorBody(401, 'unauthorized');
          if (g.heartbeatError !== null) {
            const [status, code, details] = g.heartbeatError;
            return errorBody(status, code, details);
          }
          return jsonBody(200, {
            extRulesVersion: g.heartbeatVersion ?? g.rules.extRulesVersion,
            serverNow: iso(NOW),
          });
        }
        case '/v1/attempts': {
          if (!authorized) return errorBody(401, 'unauthorized');
          return jsonBody(200, {
            blocked: true,
            counted: true,
            merged: false,
            attemptId: 'att_0123456789abcdef0001',
            pointsDelta: -10,
            episodePointsDelta: -10,
            escalationIndex: 0,
            nextPenalty: 20,
            serviceId: 'youtube',
            block: {
              id: BLK_A,
              kind: 'manual',
              mode: 'strict',
              endsAt: iso(NOW + 30 * MIN),
              reason: 'Quiero aprobar mates',
            },
            reason: null,
          });
        }
        case '/v1/usage': {
          if (!authorized) return errorBody(401, 'unauthorized');
          return jsonBody(200, {
            day: '2026-09-28',
            limits: [
              {
                limitId: 'lim_0123456789abcdefYTYT',
                usedTodaySeconds: 600,
                remainingTodaySeconds: 1_200,
                appliesToday: true,
                creditedSeconds: 30,
                blockedUntil: null,
              },
            ],
            serverNow: iso(NOW),
          });
        }
        default:
          return errorBody(404, 'not_found');
      }
    },
  };
  return g;
}

export interface TestContext extends BackgroundContext {
  store: BackgroundStore;
  area: MemoryArea;
  changes: string[];
  clock: { now: number };
  link: GuardianLink;
}

export function testContext(fetchImpl: typeof fetch, area: MemoryArea = memoryArea()): TestContext {
  const clock = { now: NOW };
  const ctx: TestContext = {
    area,
    store: createBackgroundStore(area),
    changes: [],
    clock,
    link: 'unknown',
    now: () => clock.now,
    fetch: fetchImpl,
    getLink: () => ctx.link,
    setLink: (link) => {
      ctx.link = link;
    },
    changed: async (what) => {
      ctx.changes.push(what);
    },
  };
  return ctx;
}
