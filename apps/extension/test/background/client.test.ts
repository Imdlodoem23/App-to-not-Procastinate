import { describe, expect, it, vi } from 'vitest';
import {
  RULES_PROOF_MAX_AGE_MS,
  carryForward,
  createRulesLoop,
  describeError,
  linkForError,
  linkFromStatus,
  needsSignedProof,
  syncRulesOnce,
} from '../../src/background/client';
import { computeEffectiveRules, linkTrustsRules, matchHost } from '../../src/background/state';
import { EMPTY_STATUS } from '../../src/background/storage';
import { GuardianApiError } from '@centrate/shared/guardian-api';
import {
  BLK_A,
  BLK_B,
  EXT_2,
  MIN,
  NOW,
  TOKEN_2,
  fakeGuardian,
  iso,
  pairingFixture,
  rulesFixture,
  testContext,
} from './fakes';

async function paired() {
  const guardian = await fakeGuardian();
  const ctx = testContext(guardian.fetch);
  await ctx.store.setPairing(pairingFixture(guardian.publicKey));
  return { guardian, ctx };
}

describe('syncRulesOnce', () => {
  it('does nothing while unpaired', async () => {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    expect(await syncRulesOnce(ctx)).toBe('unpaired');
    expect(guardian.calls).toHaveLength(0);
  });

  it('stores the first verified body, then long-polls with the version and the ETag', async () => {
    const { guardian, ctx } = await paired();
    expect(await syncRulesOnce(ctx)).toBe('updated');
    const first = guardian.rulesCalls()[0]!;
    expect(first.url.searchParams.get('waitVersion')).toBeNull();
    expect(first.url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.headers.get('Authorization')).toBe(`Bearer ${pairingFixture('').token}`);
    const stored = await ctx.store.getRules();
    expect(stored?.rules.extRulesVersion).toBe(100);
    expect(stored?.etag).toBe('"r-100"');
    expect(stored?.rulesPublicKey).toBe(guardian.publicKey);
    expect(ctx.link).toBe('connected');
    expect(ctx.changes).toEqual(['link', 'rules']);

    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    const second = guardian.rulesCalls()[1]!;
    expect(second.url.searchParams.get('waitVersion')).toBe('100');
    expect(second.url.searchParams.get('waitMs')).toBe('25000');
    expect(second.headers.get('If-None-Match')).toBe('"r-100"');
    expect(second.url.searchParams.get('nonce')).not.toBe(first.url.searchParams.get('nonce'));

    guardian.rules = rulesFixture({ extRulesVersion: 101, blockDomains: [], blocks: [] });
    ctx.clock.now += MIN;
    expect(await syncRulesOnce(ctx)).toBe('updated');
    expect((await ctx.store.getRules())?.rules.blocks).toEqual([]);
    expect((await ctx.store.getStatus()).lastRulesAt).toBe(NOW + MIN);
  });

  it.each([
    ['unsigned', 'invalid_signature'],
    ['wrong-key', 'invalid_signature'],
    ['replay', 'invalid_signature'],
  ] as const)('ignores a %s body and keeps the cached rules', async (mode, code) => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    guardian.rules = rulesFixture({ extRulesVersion: 101, blockDomains: [], blocks: [] });
    guardian.mode = mode;
    if (mode === 'replay') {
      // The attacker replays the last body it saw, signed for another nonce.
      guardian.mode = 'ok';
      await ctx.store.setRules({ ...(await ctx.store.getRules())!, etag: null });
      await syncRulesOnce(ctx);
      guardian.rules = rulesFixture({ extRulesVersion: 102, blockDomains: [], blocks: [] });
      guardian.mode = 'replay';
      await ctx.store.setRules({ ...(await ctx.store.getRules())!, etag: null });
    }
    const before = await ctx.store.getRules();
    expect(await syncRulesOnce(ctx)).toBe('rejected');
    expect(ctx.link).toBe('untrusted');
    expect((await ctx.store.getStatus()).lastError?.code).toBe(code);
    expect(await ctx.store.getRules()).toEqual(before);
  });

  it('rejects rules older than the applied version', async () => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    guardian.rules = rulesFixture({ extRulesVersion: 99, blockDomains: [], blocks: [] });
    expect(await syncRulesOnce(ctx)).toBe('rejected');
    expect((await ctx.store.getStatus()).lastError?.code).toBe('stale_rules');
    expect((await ctx.store.getRules())?.rules.extRulesVersion).toBe(100);
  });

  it('keeps the cached rules when the guardian is down', async () => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    guardian.mode = 'down';
    expect(await syncRulesOnce(ctx)).toBe('unreachable');
    expect(ctx.link).toBe('unreachable');
    expect((await ctx.store.getStatus()).lastError).toMatchObject({
      code: 'unreachable',
      status: 0,
    });
    expect((await ctx.store.getRules())?.rules.blocks.map((b) => b.id)).toEqual([BLK_A]);
  });

  it('asks without waiting until an answer confirms the link again', async () => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    guardian.mode = 'down';
    expect(await syncRulesOnce(ctx)).toBe('unreachable');
    guardian.mode = 'ok';
    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    const probe = guardian.rulesCalls().at(-1)!;
    expect(probe.url.searchParams.get('waitMs')).toBeNull();
    expect(probe.headers.get('If-None-Match')).toBe('"r-100"');
    expect(ctx.link).toBe('connected');
    // Connected again: back to the long poll.
    await syncRulesOnce(ctx);
    expect(guardian.rulesCalls().at(-1)!.url.searchParams.get('waitMs')).toBe('25000');
  });

  it('marks the pairing on 401 and clears it with the next signed body', async () => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    guardian.tokens.clear();
    ctx.clock.now += MIN;
    expect(await syncRulesOnce(ctx)).toBe('unauthorized');
    expect((await ctx.store.getPairing())?.unauthorizedAt).toBe(NOW + MIN);
    expect((await ctx.store.getRules())?.rules.extRulesVersion).toBe(100);
    expect(ctx.link).toBe('unauthorized');

    // Back: the probe asks for a signed body at once (no ETag, no wait).
    guardian.tokens.add(pairingFixture('').token);
    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    const probe = guardian.rulesCalls().at(-1)!;
    expect(probe.headers.get('If-None-Match')).toBeNull();
    expect(probe.url.searchParams.get('waitMs')).toBeNull();
    expect(probe.url.searchParams.get('waitVersion')).toBe('100');
    expect((await ctx.store.getPairing())?.unauthorizedAt).toBeNull();
    expect(ctx.changes).toContain('pairing');
  });

  it('refuses a 304 it did not ask for', async () => {
    const { guardian, ctx } = await paired();
    const fetch304: typeof fetch = async (input, init) => {
      const r = await guardian.fetch(input, init);
      return new URL(String(input)).pathname === '/v1/ext/rules'
        ? new Response(null, { status: 304 })
        : r;
    };
    ctx.fetch = fetch304;
    expect(await syncRulesOnce(ctx)).toBe('rejected');
    expect(await ctx.store.getRules()).toBeNull();
  });

  it('carries the previous rules after a new pairing until their blocks end', async () => {
    const { guardian, ctx } = await paired();
    guardian.rules = rulesFixture({
      blocks: [{ ...rulesFixture().blocks[0]!, id: BLK_B, endsAt: iso(NOW + 90 * MIN) }],
    });
    await syncRulesOnce(ctx);

    // A reinstalled guardian (another key) that knows no blocks.
    const fresh = await fakeGuardian(
      rulesFixture({ extRulesVersion: 5, blockDomains: [], blocks: [], nextChangeAt: null }),
    );
    fresh.tokens.add(TOKEN_2);
    ctx.fetch = fresh.fetch;
    await ctx.store.setPairing(
      pairingFixture(fresh.publicKey, { extensionId: EXT_2, token: TOKEN_2, pairedAt: NOW }),
    );
    expect(await syncRulesOnce(ctx)).toBe('updated');
    // No version baseline from the old pairing (5 < 100 would be refused otherwise).
    expect(fresh.rulesCalls()[0]?.url.searchParams.get('waitVersion')).toBeNull();
    const stored = (await ctx.store.getRules())!;
    expect(stored.rules.extRulesVersion).toBe(5);
    expect(stored.carried?.rulesPublicKey).toBe(guardian.publicKey);
    const effective = computeEffectiveRules(stored, NOW, true);
    expect(effective?.blocks.map((b) => b.id)).toEqual([BLK_B]);
    expect(effective?.blockDomains).toContain('www.youtube.com');

    // Once the carried block ends, the next body drops it for good.
    ctx.clock.now = NOW + 91 * MIN;
    fresh.rules = { ...fresh.rules, extRulesVersion: 6 };
    expect(await syncRulesOnce(ctx)).toBe('updated');
    expect((await ctx.store.getRules())?.carried).toBeNull();
  });

  it('records nothing when the pairing changes during the request', async () => {
    const { guardian, ctx } = await paired();
    const slow: typeof fetch = async (input, init) => {
      await ctx.store.setPairing(pairingFixture(guardian.publicKey, { extensionId: EXT_2 }));
      return guardian.fetch(input, init);
    };
    ctx.fetch = slow;
    expect(await syncRulesOnce(ctx)).toBe('superseded');
    expect(await ctx.store.getRules()).toBeNull();
    expect(ctx.changes).toEqual([]);
  });
});

describe('bare 304 answers', () => {
  /** Something squatting the port: a bare 304 to every rules request, whatever it asks. */
  function always304(guardian: Awaited<ReturnType<typeof fakeGuardian>>): typeof fetch {
    return async (input, init) =>
      new URL(String(input)).pathname === '/v1/ext/rules'
        ? new Response(null, { status: 304 })
        : guardian.fetch(input, init);
  }
  const lastRulesCall = (calls: Awaited<ReturnType<typeof fakeGuardian>>['calls']) =>
    calls.filter((c) => c.url.pathname === '/v1/ext/rules').at(-1)!;

  it('keep the link only until the signed body is RULES_PROOF_MAX_AGE_MS old', async () => {
    const { guardian, ctx } = await paired();
    expect(await syncRulesOnce(ctx)).toBe('updated');
    const calls: typeof guardian.calls = [];
    ctx.fetch = async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: null,
      });
      return always304(guardian)(input, init);
    };

    ctx.clock.now = NOW + MIN;
    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    expect(lastRulesCall(calls).headers.get('If-None-Match')).toBe('"r-100"');
    expect(ctx.link).toBe('connected');

    ctx.clock.now = NOW + RULES_PROOF_MAX_AGE_MS;
    for (let i = 0; i < 2; i += 1) {
      expect(await syncRulesOnce(ctx)).toBe('rejected');
      const probe = lastRulesCall(calls);
      // Only a signed 200 can answer: no ETag, still the version baseline.
      expect(probe.headers.get('If-None-Match')).toBeNull();
      expect(probe.url.searchParams.get('waitVersion')).toBe('100');
      expect(ctx.link).toBe('untrusted');
      expect((await ctx.store.getStatus()).lastError).toMatchObject({
        code: 'invalid_response',
        status: 304,
      });
    }
    expect((await ctx.store.getRules())?.receivedAt).toBe(NOW);
  });

  it('cannot keep an ended allowance open past its end', async () => {
    const { guardian, ctx } = await paired();
    guardian.rules = rulesFixture({
      blockDomains: [],
      allowances: [{ serviceId: 'youtube', endsAt: iso(NOW + 2 * MIN) }],
      nextChangeAt: iso(NOW + 2 * MIN),
    });
    await syncRulesOnce(ctx);
    ctx.fetch = always304(guardian);

    ctx.clock.now = NOW + MIN;
    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    const open = computeEffectiveRules(await ctx.store.getRules(), ctx.clock.now, true);
    expect(matchHost(open, 'www.youtube.com').blocked).toBe(false);

    // Past nextChangeAt (the allowance ended) a 304 is refused, and the cached rules are
    // pruned; even trusted, the allowance would close at its signed end.
    ctx.clock.now = NOW + 3 * MIN;
    expect(await syncRulesOnce(ctx)).toBe('rejected');
    expect(linkTrustsRules(ctx.link)).toBe(false);
    const stored = await ctx.store.getRules();
    for (const trusted of [false, true]) {
      const effective = computeEffectiveRules(stored, ctx.clock.now, trusted);
      expect(matchHost(effective, 'www.youtube.com').blocked).toBe(true);
    }
  });

  it('a real guardian answers the proof with a signed body, then 304s resume', async () => {
    const { guardian, ctx } = await paired();
    await syncRulesOnce(ctx);
    ctx.clock.now = NOW + RULES_PROOF_MAX_AGE_MS + MIN;
    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    const proof = guardian.rulesCalls().at(-1)!;
    expect(proof.headers.get('If-None-Match')).toBeNull();
    // Connected: still a long poll (the guardian answers 200 when it times out).
    expect(proof.url.searchParams.get('waitMs')).toBe('25000');
    expect((await ctx.store.getRules())?.receivedAt).toBe(ctx.clock.now);
    expect(ctx.link).toBe('connected');
    expect(ctx.changes).not.toContain('status');

    expect(await syncRulesOnce(ctx)).toBe('unchanged');
    expect(guardian.rulesCalls().at(-1)!.headers.get('If-None-Match')).toBe('"r-100"');
  });

  it('needsSignedProof: age, a clock that went back, and nextChangeAt', () => {
    const record = {
      v: 1 as const,
      rules: rulesFixture({ nextChangeAt: iso(NOW + 30 * MIN) }),
      extensionId: pairingFixture('').extensionId,
      etag: '"r-100"',
      rulesPublicKey: 'K',
      receivedAt: NOW,
      carried: null,
    };
    expect(needsSignedProof(record, NOW)).toBe(false);
    expect(needsSignedProof(record, NOW + RULES_PROOF_MAX_AGE_MS - 1)).toBe(false);
    expect(needsSignedProof(record, NOW + RULES_PROOF_MAX_AGE_MS)).toBe(true);
    expect(needsSignedProof(record, NOW - 1)).toBe(true);
    const soon = { ...record, rules: rulesFixture({ nextChangeAt: iso(NOW + MIN) }) };
    expect(needsSignedProof(soon, NOW + MIN - 1)).toBe(false);
    expect(needsSignedProof(soon, NOW + MIN)).toBe(true);
    const never = { ...record, rules: rulesFixture({ nextChangeAt: null }) };
    expect(needsSignedProof(never, NOW + MIN)).toBe(false);
  });
});

describe('linkFromStatus', () => {
  it('is the error newer than the last verified answer, else connected once verified', () => {
    expect(linkFromStatus(EMPTY_STATUS)).toBe('unknown');
    expect(linkFromStatus({ ...EMPTY_STATUS, lastRulesAt: NOW })).toBe('connected');
    const down = { code: 'unreachable', status: 0, at: NOW + 1 };
    expect(linkFromStatus({ ...EMPTY_STATUS, lastRulesAt: NOW, lastError: down })).toBe(
      'unreachable',
    );
    expect(linkFromStatus({ ...EMPTY_STATUS, lastRulesAt: NOW + 2, lastError: down })).toBe(
      'connected',
    );
    const forged = { code: 'invalid_signature', status: 200, at: NOW };
    expect(linkFromStatus({ ...EMPTY_STATUS, lastError: forged })).toBe('untrusted');
  });
});

describe('carryForward', () => {
  it('keeps only live blocks, from the record and what it already carried', () => {
    const rules = rulesFixture();
    const older = rulesFixture({
      blocks: [{ ...rulesFixture().blocks[0]!, id: BLK_B, endsAt: iso(NOW + 60 * MIN) }],
    });
    const record = {
      v: 1 as const,
      rules,
      extensionId: pairingFixture('').extensionId,
      etag: null,
      rulesPublicKey: 'K1',
      receivedAt: NOW,
      carried: { rules: older, rulesPublicKey: 'K0' },
    };
    expect(carryForward(record, NOW)?.rules.blocks.map((b) => b.id)).toEqual([BLK_A, BLK_B]);
    expect(carryForward(record, NOW + 31 * MIN)).toMatchObject({ rulesPublicKey: 'K0' });
    expect(carryForward(record, NOW + 61 * MIN)).toBeNull();
    expect(carryForward(null, NOW)).toBeNull();
  });
});

describe('errors', () => {
  it('maps errors to link states, with the 403 reason as the code', () => {
    const scope = new GuardianApiError(403, 'insufficient_scope', 'x', {
      reason: 'browser_mismatch',
    });
    expect(describeError(scope, NOW)).toEqual({ code: 'browser_mismatch', status: 403, at: NOW });
    expect(describeError(new Error('boom'), NOW).code).toBe('unexpected');
    expect(linkForError({ code: 'unauthorized', status: 401, at: NOW })).toBe('unauthorized');
    expect(linkForError({ code: 'timeout', status: 0, at: NOW })).toBe('unreachable');
    expect(linkForError({ code: 'stale_rules', status: 200, at: NOW })).toBe('untrusted');
    expect(linkForError({ code: 'rate_limited', status: 429, at: NOW })).toBe('error');
  });
});

describe('createRulesLoop', () => {
  it('backs off, then stops until the next tick while the guardian is down', async () => {
    const { guardian, ctx } = await paired();
    guardian.mode = 'down';
    const sleeps: number[] = [];
    const loop = createRulesLoop(ctx, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    loop.ensureRunning();
    loop.ensureRunning(); // a second call does not start a second loop
    await loop.idle();
    expect(sleeps).toEqual([1_000, 3_000, 10_000]);
    expect(guardian.rulesCalls()).toHaveLength(4);
    expect(loop.isRunning()).toBe(false);
  });

  it('stops when unauthorized, and keeps long-polling while connected', async () => {
    const { guardian, ctx } = await paired();
    let polls = 0;
    const loop = createRulesLoop(ctx, {
      sleep: async () => {
        polls += 1;
        if (polls === 3) guardian.tokens.clear();
      },
    });
    loop.ensureRunning();
    await loop.idle();
    // updated, unchanged, unchanged (then 401).
    expect(guardian.rulesCalls()).toHaveLength(4);
    expect(ctx.link).toBe('unauthorized');
  });

  it('restart() drops a pending long poll and asks again at once', async () => {
    const { guardian, ctx } = await paired();
    guardian.mode = 'hang';
    const loop = createRulesLoop(ctx, {
      sleep: async () => {
        await ctx.store.clearPairing(); // end the test after the next answer
      },
    });
    loop.ensureRunning();
    await vi.waitFor(() => expect(guardian.rulesCalls()).toHaveLength(1));
    guardian.mode = 'ok';
    loop.restart();
    await loop.idle();
    expect(guardian.rulesCalls()).toHaveLength(2);
    expect(ctx.link).toBe('connected');
    expect((await ctx.store.getStatus()).lastError).toBeNull();
    expect((await ctx.store.getRules())?.rules.extRulesVersion).toBe(100);
  });
});
