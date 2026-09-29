/**
 * Self-test of the mock guardian (no browser): it must honour the same contract as the Go
 * guardian as far as the extension can tell, checked with the shared client
 * (`createGuardianClient`, which verifies the signature and the nonce) and raw HTTP.
 */
import { request } from 'node:http';
import { expect, test } from '@playwright/test';
import type { GuardianClient, PairingClaimRequest } from '@centrate/shared/guardian-api';
import {
  CHROMIUM_EXTENSION_ID,
  GuardianApiError,
  createGuardianClient,
  generateRulesKeyPair,
} from '@centrate/shared/guardian-api';
import type { MockGuardian } from '../test/mock-guardian';
import { startMockGuardian } from '../test/mock-guardian';

const CLAIM: Omit<PairingClaimRequest, 'code'> = {
  browser: 'chrome',
  browserVersion: '141.0.7390.37',
  extVersion: '0.1.0',
};

async function withGuardian(run: (g: MockGuardian) => Promise<void>): Promise<void> {
  const guardian = await startMockGuardian();
  try {
    await run(guardian);
  } finally {
    await guardian.close();
  }
}

async function paired(g: MockGuardian): Promise<GuardianClient> {
  const claim = await createGuardianClient({ baseUrl: g.baseUrl }).claimPairing({
    ...CLAIM,
    code: g.newPairingCode(),
  });
  return createGuardianClient({
    baseUrl: g.baseUrl,
    token: claim.token,
    rulesPublicKey: claim.rulesPublicKey,
  });
}

async function rejection(promise: Promise<unknown>): Promise<GuardianApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GuardianApiError) return error;
    throw error;
  }
  throw new Error('expected a GuardianApiError');
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  g: MockGuardian,
  options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: g.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test.describe('mock guardian', () => {
  test('pairing: single-use code, wrong codes, burned after five failures', async () => {
    await withGuardian(async (g) => {
      const anon = createGuardianClient({ baseUrl: g.baseUrl });
      const code = g.newPairingCode('048392');
      expect((await rejection(anon.claimPairing({ ...CLAIM, code: '111111' }))).code).toBe(
        'pairing_code_invalid',
      );
      const claim = await anon.claimPairing({ ...CLAIM, code });
      expect(claim.token).toMatch(/^cte_/);
      expect(claim.rulesPublicKey).toBe(g.rulesPublicKey);
      expect(claim.boundOrigin).toBeNull(); // Node's fetch sends no Origin
      expect((await rejection(anon.claimPairing({ ...CLAIM, code }))).code).toBe('pairing_no_code');

      const next = g.newPairingCode('222222');
      for (let i = 0; i < 4; i += 1) {
        const error = await rejection(anon.claimPairing({ ...CLAIM, code: '333333' }));
        expect(error.status).toBe(401);
      }
      expect((await rejection(anon.claimPairing({ ...CLAIM, code: '333333' }))).code).toBe(
        'pairing_code_expired',
      );
      expect((await rejection(anon.claimPairing({ ...CLAIM, code: next }))).code).toBe(
        'pairing_no_code',
      );
      expect(
        (await rejection(anon.claimPairing({ ...CLAIM, code: 'abc' } as PairingClaimRequest)))
          .status,
      ).toBe(422);
    });
  });

  test('rules: signed, nonce echoed, ETag and 304, forged keys rejected', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      g.addBlock({ services: ['youtube'], minutes: 25, reason: 'Estudiar' });
      const first = await client.getExtRules();
      if (first.notModified) throw new Error('expected a body');
      expect(first.etag).toBe(`"r-${g.extRulesVersion}"`);
      expect(first.rules.blockDomains).toContain('www.youtube.com');
      expect(first.rules.excludedDomains).toContain('accounts.youtube.com');
      expect(first.rules.blocks[0]).toMatchObject({ reason: 'Estudiar', serviceIds: ['youtube'] });

      const again = await client.getExtRules({ etag: first.etag });
      expect(again.notModified).toBe(true);

      const other = await generateRulesKeyPair();
      const forged = createGuardianClient({
        baseUrl: g.baseUrl,
        token: g.extensions()[0]?.token ?? null,
        rulesPublicKey: other.publicKey,
      });
      expect((await rejection(forged.getExtRules())).code).toBe('invalid_signature');

      // A version newer than the guardian's is `stale_rules` for the client.
      const stale = await rejection(client.getExtRules({ waitVersion: g.extRulesVersion + 1 }));
      expect(stale.code).toBe('stale_rules');
    });
  });

  test('rules: the long poll returns as soon as the version changes', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      const version = g.extRulesVersion;
      const started = Date.now();
      const pending = client.getExtRules({ waitVersion: version, waitMs: 20_000 });
      setTimeout(() => g.addBlock({ domains: ['example.com'] }), 300);
      const result = await pending;
      if (result.notModified) throw new Error('expected a body');
      expect(result.rules.extRulesVersion).toBe(version + 1);
      expect(result.rules.blockDomains).toEqual(['example.com', 'www.example.com']);
      expect(Date.now() - started).toBeLessThan(5_000);

      // Unchanged: waits for waitMs, then 304 with the same ETag.
      const idle = await client.getExtRules({
        etag: result.etag,
        waitVersion: version + 1,
        waitMs: 300,
      });
      expect(idle.notModified).toBe(true);
    });
  });

  test('rules: whitelist, allowances and blocks that end by themselves', async () => {
    await withGuardian(async (g) => {
      const block = g.addBlock({ services: ['youtube'], minutes: 25 });
      g.addBlock({ whitelistOnly: true, minutes: 60, reason: 'Examen' });
      g.addAllowance('youtube', 15);
      const rules = g.rules();
      expect(rules.blockDomains).not.toContain('www.youtube.com');
      expect(rules.whitelist?.allowDomains).toEqual(
        expect.arrayContaining(['wikipedia.org', 'www.youtube.com', 'accounts.youtube.com']),
      );
      expect(rules.blocks.find((b) => b.whitelistOnly)?.mode).toBe('exam');
      expect(rules.allowances).toEqual([{ serviceId: 'youtube', endsAt: expect.any(String) }]);

      const before = g.extRulesVersion;
      g.removeBlock(block.id);
      expect(g.extRulesVersion).toBe(before + 1);

      const ending = g.addBlock({ domains: ['example.net'], endsAt: Date.now() + 400 });
      expect(g.rules().nextChangeAt).toBe(new Date(ending.endsAt).toISOString());
      const version = g.extRulesVersion;
      await expect.poll(() => g.extRulesVersion, { timeout: 3_000 }).toBe(version + 1);
      expect(g.rules().blockDomains).not.toContain('example.net');
    });
  });

  test('attempts: −10, −20, merged repeats, allowances, not blocked', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      g.addBlock({ services: ['youtube', 'instagram'], minutes: 25, reason: 'Estudiar' });
      const attempt = (host: string) =>
        client.reportAttempt({
          layer: 'extension',
          target: { type: 'domain', value: host },
          browser: 'chrome',
          incognito: false,
        });

      const first = await attempt('www.youtube.com');
      expect(first).toMatchObject({
        blocked: true,
        counted: true,
        pointsDelta: -10,
        escalationIndex: 0,
        nextPenalty: 20,
        serviceId: 'youtube',
        block: { reason: 'Estudiar' },
      });
      const second = await attempt('www.instagram.com');
      expect(second).toMatchObject({ counted: true, pointsDelta: -20, escalationIndex: 1 });
      const merged = await attempt('m.youtube.com');
      expect(merged).toMatchObject({
        counted: false,
        merged: true,
        pointsDelta: 0,
        episodePointsDelta: -10,
        attemptId: first.attemptId,
      });
      expect(g.balance).toBe(-30);

      expect(await attempt('accounts.youtube.com')).toMatchObject({
        blocked: false,
        reason: 'not_blocked',
      });
      expect(await attempt('example.com')).toMatchObject({ blocked: false, reason: 'not_blocked' });
      g.addAllowance('instagram');
      expect(await attempt('www.instagram.com')).toMatchObject({
        blocked: false,
        reason: 'allowance_active',
      });

      const window = await rejection(
        client.reportAttempt({
          layer: 'window',
          target: { type: 'service', value: 'youtube' },
          browser: null,
          incognito: false,
        }),
      );
      expect(window).toMatchObject({ status: 403, code: 'insufficient_scope' });
    });
  });

  test('usage: credited once and never beyond real time; a used-up limit blocks as manual', async () => {
    let clock = Date.parse('2026-09-28T10:00:00.000Z');
    const guardian = await startMockGuardian({ now: () => clock });
    try {
      const client = await paired(guardian);
      const limit = guardian.addLimit({ services: ['youtube'], dailyMinutes: 5 });
      const rules = await client.getExtRules({});
      expect(rules.notModified ? null : rules.rules.limits).toEqual([
        expect.objectContaining({ id: limit.id, name: 'YouTube', dailyMinutes: 5 }),
      ]);
      const report = (seconds: number, intervalMs = 30_000, value = 'www.youtube.com') =>
        client.reportUsage({ intervalMs, items: [{ type: 'domain', value, seconds }] });

      const first = await report(30);
      expect(first.limits[0]).toMatchObject({ usedTodaySeconds: 30, creditedSeconds: 30 });
      // The same seconds sent again at once (an answer lost): only the 2 s of slack.
      const again = await report(30);
      expect(again.limits[0]).toMatchObject({ usedTodaySeconds: 32, creditedSeconds: 2 });
      // Unlimited sites count nothing.
      clock += 30_000;
      expect((await report(30, 30_000, 'example.com')).limits[0]?.creditedSeconds).toBe(0);
      // More than the time since the previous report is clamped to it (+ slack).
      clock += 10_000;
      expect((await report(30)).limits[0]?.creditedSeconds).toBe(12);

      guardian.setLimitUsage(limit.id, 5 * 60);
      const blocked = await client.getExtRules({});
      const block = blocked.notModified ? undefined : blocked.rules.blocks[0];
      expect(block).toMatchObject({ kind: 'manual', limitId: limit.id });
      expect((await report(5, 5_000)).limits[0]?.blockedUntil).toBe('2026-09-29T00:00:00.000Z');

      const scope = await rejection(
        client.reportUsage({
          intervalMs: 5_000,
          items: [{ type: 'process', value: 'chrome.exe', seconds: 5 }],
        }),
      );
      expect(scope).toMatchObject({ status: 403, code: 'insufficient_scope' });
    } finally {
      await guardian.close();
    }
  });

  test('attempts: the whitelist covers every site but the allowed ones', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      const block = g.addBlock({ whitelistOnly: true, minutes: 30 });
      const attempt = (host: string) =>
        client.reportAttempt({
          layer: 'extension',
          target: { type: 'domain', value: host },
          browser: 'chrome',
          incognito: false,
        });
      expect(await attempt('example.org')).toMatchObject({
        blocked: true,
        counted: true,
        block: { id: block.id, mode: 'exam' },
      });
      expect(await attempt('es.wikipedia.org')).toMatchObject({ blocked: false });
    });
  });

  test('heartbeats: recorded, and the browser family must match the pairing', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      const body = {
        extVersion: '0.1.0',
        browser: 'chrome' as const,
        browserVersion: '141.0.7390.37',
        incognitoAllowed: true,
        hostPermission: true,
        appliedExtRulesVersion: g.extRulesVersion,
      };
      const answer = await client.extHeartbeat(body);
      expect(answer.extRulesVersion).toBe(g.extRulesVersion);
      await g.waitForApplied();
      const mismatch = await rejection(client.extHeartbeat({ ...body, browser: 'edge' }));
      expect(mismatch).toMatchObject({ status: 403, details: { reason: 'browser_mismatch' } });
    });
  });

  test('pipeline: Host, Origin, CORS preflight, tokens and revocation', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      const token = g.extensions()[0]?.token ?? '';
      const extOrigin = `chrome-extension://${CHROMIUM_EXTENSION_ID}`;

      const rebinding = await raw(g, { path: '/v1/health', headers: { Host: 'evil.example' } });
      expect(rebinding.status).toBe(403);
      expect(JSON.parse(rebinding.body).error.code).toBe('host_not_allowed');

      const web = await raw(g, { path: '/v1/health', headers: { Origin: 'https://evil.example' } });
      expect(web.status).toBe(403);
      expect(web.headers['access-control-allow-origin']).toBeUndefined();

      const preflight = await raw(g, {
        method: 'OPTIONS',
        path: '/v1/ext/rules',
        headers: {
          Origin: extOrigin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(extOrigin);
      expect(preflight.headers['access-control-allow-private-network']).toBe('true');
      expect(String(preflight.headers['access-control-allow-headers'])).toContain('If-None-Match');

      const firefox = await raw(g, {
        path: '/v1/health',
        headers: { Origin: 'moz-extension://0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f' },
      });
      expect(firefox.status).toBe(200);

      const rules = await raw(g, {
        path: '/v1/ext/rules?nonce=AAAAAAAAAAAAAAAAAAAAAA',
        headers: { Authorization: `Bearer ${token}`, Origin: extOrigin },
      });
      expect(rules.status).toBe(200);
      expect(rules.headers['x-centrate-signature']).toMatch(/^v1=[A-Za-z0-9_-]{86}$/);
      expect(rules.headers['access-control-expose-headers']).toContain('X-Centrate-Signature');
      expect(rules.headers['cache-control']).toBe('no-store');

      const noNonce = await raw(g, {
        path: '/v1/ext/rules',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(noNonce.status).toBe(400);

      g.revokeExtensions();
      expect((await rejection(client.getExtRules())).status).toBe(401);
    });
  });

  test('stop and start: same port, the version counter only grows', async () => {
    await withGuardian(async (g) => {
      const client = await paired(g);
      const port = g.port;
      const before = g.extRulesVersion;
      await g.stop();
      expect((await rejection(client.getExtRules())).code).toBe('unreachable');
      g.addBlock({ services: ['youtube'] });
      await g.start();
      expect(g.port).toBe(port);
      const result = await client.getExtRules();
      if (result.notModified) throw new Error('expected a body');
      expect(result.rules.extRulesVersion).toBeGreaterThan(before);
    });
  });
});
