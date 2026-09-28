import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { accountabilityEvents, friendInvites, presence, userBlocks } from '../src/db/schema';
import { pageAssets } from '../src/pages/layout';
import { exportSocialData } from '../src/social/export';
import { hashInviteCode } from '../src/social/codes';
import { buildTestApp, createTestUser, fakeClock } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/db';
import { befriend, linkPartners } from './helpers/social';

describe('/i/:code (public invite page)', () => {
  it('works without a database or account and never looks the code up', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    const res = await app.inject({ method: 'GET', url: '/i/abcde-fghjk' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    const body = res.body;
    expect(body).toContain('<html lang="es">');
    expect(body).toContain('Te han invitado a Céntrate');
    expect(body).toContain('<code class="invite-code" id="codigo">ABCDE-FGHJK</code>');
    expect(body).toContain('data-copy="ABCDE-FGHJK"');
    expect(body).toContain('«Tengo un código»');
    expect(body).toContain('href="https://centrate.onrender.com/descargar"');
    expect(body).toContain('<script src="/cuenta/assets/invitacion.js" defer></script>');
    // No inline scripts or styles (strict CSP).
    expect(body).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(body).not.toMatch(/\sstyle=/);
    expect(pageAssets.get('invitacion.js')?.body).toContain('navigator.clipboard');
    await app.close();
  });

  it('answers a 404 page for malformed codes without echoing them', async () => {
    const app = await buildApp({ config: loadConfig({}), logger: false });
    const res = await app.inject({
      method: 'GET',
      url: `/i/${encodeURIComponent('<script>alert(1)</script>')}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('Este enlace de invitación no es válido');
    expect(res.body).not.toContain('alert(1)');
    await app.close();
  });
});

describe('social part of the GDPR export', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it('includes every social row about the user, other people only by id and name', async () => {
    const clock = fakeClock();
    const now = clock.now();
    const ana = await createTestUser(t.db, { displayName: 'Ana', now });
    const bea = await createTestUser(t.db, { displayName: 'Bea', now });
    const carlos = await createTestUser(t.db, { displayName: 'Carlos', now });
    await befriend(t.db, ana, bea, now);
    await linkPartners(t.db, ana, bea, { requireApproval: true, at: now });
    await linkPartners(t.db, bea, ana, { at: now });
    await t.db.insert(userBlocks).values({ blockerId: ana.userId, blockedId: carlos.userId });
    await t.db.insert(friendInvites).values({
      inviterId: ana.userId,
      codeHash: hashInviteCode('ABCDEFGHJK'),
      expiresAt: new Date(now.getTime() - 1000), // expired, still stored
    });
    await t.db
      .insert(presence)
      .values({ userId: ana.userId, state: 'study', since: now, expiresAt: now });
    await t.db.insert(accountabilityEvents).values([
      { ownerId: ana.userId, clientRef: 'a'.repeat(16), kind: 'study_abandoned', occurredAt: now },
      {
        ownerId: bea.userId,
        clientRef: 'b'.repeat(16),
        kind: 'emergency_requested',
        occurredAt: now,
        approvalStatus: 'approved',
        approvalDeadline: now,
        decidedBy: ana.userId,
        decidedAt: now,
        note: 'Vale',
      },
    ]);

    const data = await exportSocialData(t.db, ana.userId, now);
    expect(data.friends).toEqual([
      { userId: bea.userId, displayName: 'Bea', since: now.toISOString() },
    ]);
    expect(data.invites).toHaveLength(1);
    expect(data.blocks).toMatchObject([{ userId: carlos.userId, displayName: 'Carlos' }]);
    expect(data.presence).toEqual({ state: 'study', since: now.toISOString(), endsAt: null });
    expect(data.partnerLinks.map((l) => l.role).sort()).toEqual(['owner', 'partner']);
    expect(data.accountabilityEvents).toMatchObject([{ kind: 'study_abandoned', approval: null }]);
    expect(data.approvalDecisions).toEqual([
      {
        eventId: expect.any(String),
        owner: { userId: bea.userId, displayName: 'Bea' },
        decision: 'approved',
        note: 'Vale',
        decidedAt: now.toISOString(),
      },
    ]);
    const json = JSON.stringify(data);
    expect(json).not.toContain('@');
    expect(json).not.toContain(hashInviteCode('ABCDEFGHJK'));

    // Nothing leaks through the app either: the routes still answer for this database.
    const app = await buildTestApp({ db: t.db, clock });
    const res = await app.inject({ method: 'GET', url: '/v1/friends', headers: ana.headers });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
