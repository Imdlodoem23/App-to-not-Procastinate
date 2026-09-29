import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATUS,
  STORAGE_KEYS,
  createBackgroundStore,
  parsePairingRecord,
  parseRulesRecord,
  parseStatusRecord,
  readHoldUntil,
} from '../../src/background/storage';
import type { RulesRecord } from '../../src/background/storage';
import { EXT_1, MIN, NOW, iso, memoryArea, pairingFixture, rulesFixture } from './fakes';

const KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(86);

function rulesRecord(overrides: Partial<RulesRecord> = {}): RulesRecord {
  return {
    v: 1,
    rules: rulesFixture(),
    extensionId: EXT_1,
    etag: '"r-100"',
    rulesPublicKey: KEY,
    receivedAt: NOW,
    carried: null,
    ...overrides,
  };
}

describe('background store', () => {
  it('round-trips the pairing, the rules and the status through storage', async () => {
    const area = memoryArea();
    const store = createBackgroundStore(area);
    expect(await store.getPairing()).toBeNull();
    expect(await store.getRules()).toBeNull();
    expect(await store.getStatus()).toEqual(EMPTY_STATUS);

    const pairing = pairingFixture(KEY);
    await store.setPairing(pairing);
    await store.setRules(rulesRecord({ carried: { rules: rulesFixture(), rulesPublicKey: KEY } }));
    await store.patchStatus({ lastRulesAt: NOW });

    // A new worker reads what the previous one wrote.
    const reloaded = createBackgroundStore(area);
    expect(await reloaded.getPairing()).toEqual(pairing);
    expect((await reloaded.getRules())?.rules.extRulesVersion).toBe(100);
    expect((await reloaded.getRules())?.carried?.rulesPublicKey).toBe(KEY);
    expect((await reloaded.getStatus()).lastRulesAt).toBe(NOW);

    await reloaded.clearPairing();
    await reloaded.clearRules();
    expect(area.data.has(STORAGE_KEYS.pairing)).toBe(false);
    expect(area.data.has(STORAGE_KEYS.rules)).toBe(false);
    expect(await createBackgroundStore(area).getPairing()).toBeNull();
  });

  it('serializes status patches so concurrent writers keep each other’s fields', async () => {
    const area = memoryArea();
    const store = createBackgroundStore(area);
    await Promise.all([
      store.patchStatus({ lastRulesAt: NOW }),
      store.patchStatus({ lastHeartbeatAt: NOW + 1 }),
      store.patchStatus({ lastError: { code: 'unreachable', status: 0, at: NOW + 2 } }),
    ]);
    const status = await createBackgroundStore(area).getStatus();
    expect(status.lastRulesAt).toBe(NOW);
    expect(status.lastHeartbeatAt).toBe(NOW + 1);
    expect(status.lastError?.code).toBe('unreachable');
  });

  it('keeps working after a failed write', async () => {
    const area = memoryArea();
    let full = true;
    const store = createBackgroundStore({
      ...area,
      set: (items) => (full ? Promise.reject(new Error('quota')) : area.set(items)),
    });
    await expect(store.patchStatus({ lastRulesAt: NOW })).rejects.toThrow('quota');
    full = false;
    await expect(store.patchStatus({ lastRulesAt: NOW })).resolves.toMatchObject({
      lastRulesAt: NOW,
    });
  });
});

describe('unreadable rules records', () => {
  /** What an older extension stored, refused by today's validation. */
  function unreadable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const good = rulesRecord();
    return { ...good, rules: { ...good.rules, blockDomains: ['not a host'] }, ...overrides };
  }

  it('reports a record that no longer parses, with its latest readable end', async () => {
    const carried = rulesFixture({ punishment: { endsAt: iso(NOW + 90 * MIN), level: 'nuclear' } });
    const store = createBackgroundStore(
      memoryArea({
        [STORAGE_KEYS.rules]: unreadable({ carried: { rules: carried, rulesPublicKey: KEY } }),
      }),
    );
    expect(await store.getRules()).toBeNull();
    expect(await store.getUnreadableRules()).toEqual({ holdUntil: NOW + 90 * MIN });

    // A verified body replaces it.
    await store.setRules(rulesRecord());
    expect(await store.getUnreadableRules()).toBeNull();
    expect((await store.getRules())?.rules.extRulesVersion).toBe(100);
  });

  it('reads nothing as unreadable when nothing is stored or the record is fine', async () => {
    expect(await createBackgroundStore(memoryArea()).getUnreadableRules()).toBeNull();
    const fine = createBackgroundStore(memoryArea({ [STORAGE_KEYS.rules]: rulesRecord() }));
    expect(await fine.getUnreadableRules()).toBeNull();
  });

  it('holds with no end when an end cannot be read', () => {
    expect(readHoldUntil(unreadable())).toBe(NOW + 30 * MIN);
    expect(readHoldUntil('garbage')).toBeNull();
    expect(readHoldUntil({ v: 2 })).toBeNull();
    expect(readHoldUntil({ rules: { blocks: 'x' } })).toBeNull();
    expect(readHoldUntil({ rules: { blocks: [{ endsAt: 'soon' }] } })).toBeNull();
    expect(readHoldUntil({ rules: { blocks: [{}] } })).toBeNull();
    expect(readHoldUntil({ rules: { blocks: [], punishment: { endsAt: 7 } } })).toBeNull();
    expect(readHoldUntil({ rules: { blocks: [] } })).toBe(0);
    expect(readHoldUntil({ rules: { blocks: [] }, carried: { rules: { blocks: 3 } } })).toBeNull();
  });
});

describe('cache invalidation (another instance writes)', () => {
  it('keeps serving the cache until invalidated', async () => {
    const area = memoryArea();
    const store = createBackgroundStore(area);
    const other = createBackgroundStore(area);
    expect(await store.getPairing()).toBeNull();
    await other.setPairing(pairingFixture(KEY));
    await other.patchStatus({ lastRulesAt: NOW });
    expect(await store.getPairing()).toBeNull();
    store.invalidate([STORAGE_KEYS.pairing, STORAGE_KEYS.status, 'unrelated']);
    expect((await store.getPairing())?.extensionId).toBe(EXT_1);
    expect((await store.getStatus()).lastRulesAt).toBe(NOW);
  });

  it('never caches a read that a write or an invalidation overtook', async () => {
    const area = memoryArea({ [STORAGE_KEYS.rules]: rulesRecord() });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slow = true;
    const store = createBackgroundStore({
      ...area,
      async get(keys) {
        const items = await area.get(keys);
        if (slow) {
          slow = false;
          await gate;
        }
        return items;
      },
    });
    const stale = store.getRules();
    await store.setRules(rulesRecord({ rules: rulesFixture({ extRulesVersion: 101 }) }));
    release();
    expect((await stale)?.rules.extRulesVersion).toBe(100);
    expect((await store.getRules())?.rules.extRulesVersion).toBe(101);
  });

  it('writes sync requests for the main instance', async () => {
    const area = memoryArea();
    await createBackgroundStore(area).requestSync(NOW);
    expect(area.data.get(STORAGE_KEYS.syncRequest)).toBe(NOW);
  });
});

describe('stored value validation', () => {
  it('reads tampered or foreign pairing records as absent', () => {
    const good = pairingFixture(KEY);
    expect(parsePairingRecord(good)).toEqual(good);
    expect(parsePairingRecord({ ...good, port: undefined })?.port).toBe(47600);
    for (const bad of [
      null,
      'x',
      { ...good, v: 2 },
      { ...good, token: 'cta_app_token_is_not_ours' },
      { ...good, extensionId: 'blk_0123456789abcdef0001' },
      { ...good, rulesPublicKey: 'not base64url!' },
      { ...good, browser: 'netscape' },
      { ...good, port: 70000 },
      { ...good, pairedAt: -1 },
      { ...good, unauthorizedAt: 'yesterday' },
    ]) {
      expect(parsePairingRecord(bad)).toBeNull();
    }
  });

  it('reads rules records only when the body is a valid rules response', () => {
    const good = rulesRecord();
    expect(parseRulesRecord(good)).toEqual(good);
    expect(
      parseRulesRecord({ ...good, rules: { ...good.rules, blockDomains: ['not a host'] } }),
    ).toBeNull();
    expect(parseRulesRecord({ ...good, extensionId: undefined })).toBeNull();
    expect(parseRulesRecord({ ...good, carried: { rules: {}, rulesPublicKey: KEY } })).toBeNull();
    expect(parseRulesRecord({ ...good, receivedAt: 'now' })).toBeNull();
  });

  it('falls back to an empty status and drops malformed fields', () => {
    expect(parseStatusRecord(undefined)).toEqual(EMPTY_STATUS);
    expect(
      parseStatusRecord({
        v: 1,
        lastRulesAt: 'x',
        lastHeartbeatAt: NOW,
        lastError: { code: '', status: 0, at: NOW },
        heartbeatError: { code: 'browser_mismatch', status: 403, at: NOW },
      }),
    ).toEqual({
      ...EMPTY_STATUS,
      lastHeartbeatAt: NOW,
      heartbeatError: { code: 'browser_mismatch', status: 403, at: NOW },
    });
  });
});
