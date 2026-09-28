import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@centrate/shared/guardian-api';
import { GUARDIAN_NAME } from '@centrate/shared/guardian-api';
import {
  normalizePairingCode,
  pairErrorFor,
  pairWithCode,
  pinnedRulesKeys,
} from '../../src/background/pairing';
import type { BrowserInfo } from '../../src/background/state';
import type { RulesRecord } from '../../src/background/storage';
import { STORAGE_KEYS } from '../../src/background/storage';
import type { FakeGuardian } from './fakes';
import {
  EXT_1,
  EXT_2,
  MIN,
  NOW,
  TOKEN_1,
  TOKEN_2,
  fakeGuardian,
  iso,
  memoryArea,
  pairingFixture,
  rulesFixture,
  testContext,
} from './fakes';

const CHROME: BrowserInfo = { family: 'chrome', engine: 'chromium', version: '131.0.6778.86' };
const deps = { browser: async () => CHROME, extVersion: '0.1.0' };

describe('normalizePairingCode', () => {
  it('accepts the 6 digits however they are typed', () => {
    expect(normalizePairingCode('048392')).toBe('048392');
    expect(normalizePairingCode(' 048 392 ')).toBe('048392');
    expect(normalizePairingCode('048-392')).toBe('048392');
    expect(normalizePairingCode('048 392')).toBe('048392');
    expect(normalizePairingCode('０４８３９２')).toBe('048392');
  });

  it('refuses anything else', () => {
    for (const bad of ['', '04839', '0483921', '04839a', '048 39 2x', '1'.repeat(40)]) {
      expect(normalizePairingCode(bad)).toBeNull();
    }
  });
});

describe('pairErrorFor', () => {
  it('maps the claim errors of the contract', () => {
    expect(pairErrorFor('pairing_code_invalid', 401)).toBe('code_invalid');
    expect(pairErrorFor('pairing_code_expired', 410)).toBe('code_expired');
    expect(pairErrorFor('pairing_no_code', 409)).toBe('no_code');
    expect(pairErrorFor('peer_not_browser', 403)).toBe('peer_not_browser');
    expect(pairErrorFor('origin_not_allowed', 403)).toBe('origin_not_allowed');
    expect(pairErrorFor('rate_limited', 429)).toBe('rate_limited');
    expect(pairErrorFor('unreachable', 0)).toBe('unreachable');
    expect(pairErrorFor('read_only', 503)).toBe('read_only');
    expect(pairErrorFor('http_502', 502)).toBe('unexpected');
  });
});

describe('pairWithCode', () => {
  it('claims a token and stores the pairing', async () => {
    const guardian = await fakeGuardian();
    guardian.tokens.clear();
    const ctx = testContext(guardian.fetch);
    ctx.link = 'unreachable';
    await ctx.store.patchStatus({ lastError: { code: 'unreachable', status: 0, at: NOW - 1 } });

    const outcome = await pairWithCode(ctx, deps, { code: '048 392' });
    expect(outcome.ok).toBe(true);
    const claim = guardian.calls[0]!;
    expect(claim.url.pathname).toBe('/v1/pairing/claim');
    expect(claim.headers.get('Authorization')).toBeNull();
    expect(claim.body).toEqual({
      code: '048392',
      browser: 'chrome',
      browserVersion: '131.0.6778.86',
      extVersion: '0.1.0',
    });
    expect(await ctx.store.getPairing()).toEqual({
      v: 1,
      extensionId: EXT_1,
      token: TOKEN_1,
      rulesPublicKey: guardian.publicKey,
      guardianVersion: '0.1.0',
      boundOrigin: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah',
      browser: 'chrome',
      port: 47600,
      pairedAt: NOW,
      unauthorizedAt: null,
    });
    expect((await ctx.store.getStatus()).lastError).toBeNull();
    expect(ctx.link).toBe('unknown');
    expect(ctx.changes).toEqual(['pairing']);
  });

  it('uses the port the app shows', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    await pairWithCode(ctx, deps, { code: '048392', port: 47611 });
    expect(guardian.calls[0]?.url.host).toBe('127.0.0.1:47611');
    expect((await ctx.store.getPairing())?.port).toBe(47611);
  });

  it('replaces a previous (revoked) pairing', async () => {
    const guardian = await fakeGuardian();
    guardian.claim = { extensionId: EXT_2, token: TOKEN_2 };
    const ctx = testContext(guardian.fetch);
    await ctx.store.setPairing(pairingFixture(guardian.publicKey, { unauthorizedAt: NOW - 5 }));
    await pairWithCode(ctx, deps, { code: '048392' });
    expect(await ctx.store.getPairing()).toMatchObject({
      extensionId: EXT_2,
      token: TOKEN_2,
      unauthorizedAt: null,
    });
  });

  it('checks the code and the port before any request', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    expect(await pairWithCode(ctx, deps, { code: '12345' })).toEqual({
      ok: false,
      error: 'invalid_format',
      retryAfterSeconds: null,
    });
    expect(await pairWithCode(ctx, deps, { code: '123456', port: 0 })).toMatchObject({
      error: 'invalid_format',
    });
    expect(guardian.calls).toHaveLength(0);
  });

  it('reports a wrong code, no code and a missing guardian', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    expect(await pairWithCode(ctx, deps, { code: '111111' })).toMatchObject({
      ok: false,
      error: 'code_invalid',
    });
    guardian.code = null;
    expect(await pairWithCode(ctx, deps, { code: '048392' })).toMatchObject({ error: 'no_code' });
    guardian.mode = 'down';
    expect(await pairWithCode(ctx, deps, { code: '048392' })).toMatchObject({
      error: 'unreachable',
    });
    expect(await ctx.store.getPairing()).toBeNull();
  });

  it('shares one claim between concurrent submissions (codes are single use)', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    const [a, b] = await Promise.all([
      pairWithCode(ctx, deps, { code: '048392' }),
      pairWithCode(ctx, deps, { code: '048392' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(guardian.calls).toHaveLength(1);
  });

  it('refuses a claim answer that would not read back', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(async (input, init) => {
      const response = await guardian.fetch(input, init);
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, guardianVersion: 'x'.repeat(65) }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const outcome = await pairWithCode(ctx, deps, { code: '048392' });
    expect(outcome.ok).toBe(false);
    expect(await ctx.store.getPairing()).toBeNull();
  });
});

function verified(key: string, overrides: Partial<RulesRecord> = {}): RulesRecord {
  return {
    v: 1,
    rules: rulesFixture(),
    extensionId: EXT_1,
    etag: '"r-100"',
    rulesPublicKey: key,
    receivedAt: NOW - MIN,
    carried: null,
    ...overrides,
  };
}

const HEALTH: HealthResponse = {
  ok: true,
  name: GUARDIAN_NAME,
  version: '0.1.0',
  apiVersion: 1,
  capabilities: [],
  schemaVersion: 1,
  catalogVersion: 1,
  rulesVersion: 1,
  startedAt: iso(NOW - 60 * MIN),
  serverNow: iso(NOW),
  mode: 'normal',
  problems: [],
};

/** Routes by port: `ports[port]` answers, anything else is unreachable. */
function byPort(ports: Record<number, FakeGuardian | 'health'>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const target = ports[Number(url.port)];
    if (target === undefined) throw new TypeError('Failed to fetch');
    if (target === 'health') {
      return new Response(JSON.stringify(HEALTH), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return target.fetch(input, init);
  };
}

describe('rules key anchoring', () => {
  it('keeps the old key pinned when a claim returns another key while blocks are live', async () => {
    const real = await fakeGuardian();
    const impostor = await fakeGuardian();
    impostor.claim = { extensionId: EXT_2, token: TOKEN_2 };
    const ctx = testContext(impostor.fetch);
    const pairing = pairingFixture(real.publicKey);
    await ctx.store.setPairing(pairing);
    await ctx.store.setRules(verified(real.publicKey));

    expect(await pairWithCode(ctx, deps, { code: '048392' })).toEqual({
      ok: false,
      error: 'key_changed',
      retryAfterSeconds: null,
    });
    expect(await ctx.store.getPairing()).toEqual(pairing);
    expect((await ctx.store.getRules())?.rulesPublicKey).toBe(real.publicKey);
    expect(ctx.changes).toEqual([]);
  });

  it('accepts the same key while blocks are live, and a new key once they ended', async () => {
    const real = await fakeGuardian();
    real.claim = { extensionId: EXT_2, token: TOKEN_2 };
    const ctx = testContext(real.fetch);
    await ctx.store.setPairing(pairingFixture(real.publicKey));
    await ctx.store.setRules(verified(real.publicKey));
    expect((await pairWithCode(ctx, deps, { code: '048392' })).ok).toBe(true);

    const reinstalled = await fakeGuardian();
    const later = testContext(reinstalled.fetch);
    await later.store.setPairing(pairingFixture(real.publicKey));
    await later.store.setRules(verified(real.publicKey));
    later.clock.now = NOW + 31 * MIN; // the only block ended
    expect((await pairWithCode(later, deps, { code: '048392' })).ok).toBe(true);
    expect((await later.store.getPairing())?.rulesPublicKey).toBe(reinstalled.publicKey);
  });

  it('pins the keys of live carried rules and of a live punishment', async () => {
    const ctx = testContext(async () => new Response(null, { status: 500 }));
    const ended = rulesFixture({ blocks: [], blockDomains: [], nextChangeAt: null });
    await ctx.store.setRules(
      verified('KEY_NEW_000000000000000000000000000000000000', {
        rules: ended,
        carried: {
          rules: rulesFixture(),
          rulesPublicKey: 'KEY_OLD_0000000000000000000000000000000000',
        },
      }),
    );
    expect(await pinnedRulesKeys(ctx.store, NOW)).toEqual([
      'KEY_OLD_0000000000000000000000000000000000',
    ]);

    await ctx.store.setRules(
      verified('KEY_P_00000000000000000000000000000000000000', {
        rules: { ...ended, punishment: { endsAt: iso(NOW + 60 * MIN), level: 'whitelist' } },
      }),
    );
    expect(await pinnedRulesKeys(ctx.store, NOW)).toEqual([
      'KEY_P_00000000000000000000000000000000000000',
    ]);
    expect(await pinnedRulesKeys(ctx.store, NOW + 61 * MIN)).toEqual([]);
  });

  it('pins the paired key while an unreadable rules record still holds', async () => {
    const real = await fakeGuardian();
    const good = verified(real.publicKey);
    const area = memoryArea({
      [STORAGE_KEYS.rules]: { ...good, rules: { ...good.rules, blockDomains: ['not a host'] } },
    });
    const impostor = await fakeGuardian();
    const ctx = testContext(impostor.fetch, area);
    await ctx.store.setPairing(pairingFixture(real.publicKey));
    expect(await pairWithCode(ctx, deps, { code: '048392' })).toMatchObject({
      error: 'key_changed',
    });
  });
});

describe('port anchoring', () => {
  it('refuses another port while the guardian still answers on the paired one', async () => {
    const real = await fakeGuardian();
    const impostor = await fakeGuardian();
    const ctx = testContext(byPort({ 47600: 'health', 50000: impostor }));
    const pairing = pairingFixture(real.publicKey);
    await ctx.store.setPairing(pairing);

    expect(await pairWithCode(ctx, deps, { code: '048392', port: 50000 })).toEqual({
      ok: false,
      error: 'guardian_elsewhere',
      retryAfterSeconds: null,
    });
    expect(impostor.calls).toHaveLength(0); // the code never reached the other port
    expect(await ctx.store.getPairing()).toEqual(pairing);
  });

  it('moves to the port the app shows once nothing answers on the old one', async () => {
    const real = await fakeGuardian();
    const moved = await fakeGuardian();
    const ctx = testContext(byPort({ 47611: moved }));
    await ctx.store.setPairing(pairingFixture(real.publicKey));
    expect((await pairWithCode(ctx, deps, { code: '048392', port: 47611 })).ok).toBe(true);
    expect((await ctx.store.getPairing())?.port).toBe(47611);
  });
});
