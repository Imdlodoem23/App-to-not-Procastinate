import { describe, expect, it } from 'vitest';
import { normalizePairingCode, pairErrorFor, pairWithCode } from '../../src/background/pairing';
import type { BrowserInfo } from '../../src/background/state';
import {
  EXT_1,
  EXT_2,
  NOW,
  TOKEN_1,
  TOKEN_2,
  fakeGuardian,
  pairingFixture,
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
