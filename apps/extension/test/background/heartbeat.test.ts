import { describe, expect, it } from 'vitest';
import type { BrowserEnv, HeartbeatDeps } from '../../src/background/heartbeat';
import {
  buildHeartbeat,
  classifyBrowser,
  cleanVersion,
  sendHeartbeat,
} from '../../src/background/heartbeat';
import { syncRulesOnce } from '../../src/background/client';
import { NOW, fakeGuardian, pairingFixture, testContext } from './fakes';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function env(overrides: Partial<BrowserEnv> = {}): BrowserEnv {
  return {
    runtimeUrl: 'chrome-extension://dlabilkpafinafimngfclcfmeghilcah/',
    userAgent: CHROME_UA,
    brands: [],
    fullVersionList: [],
    isBrave: false,
    isVivaldi: false,
    firefoxVersion: null,
    ...overrides,
  };
}

const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '131' }));

describe('classifyBrowser', () => {
  it('detects each family the guardian knows', () => {
    expect(classifyBrowser(env({ brands: brands('Chromium', 'Google Chrome') }))).toEqual({
      family: 'chrome',
      engine: 'chromium',
      version: '131',
    });
    expect(
      classifyBrowser(
        env({
          brands: brands('Chromium', 'Google Chrome'),
          fullVersionList: [{ brand: 'Google Chrome', version: '131.0.6778.86' }],
        }),
      ).version,
    ).toBe('131.0.6778.86');
    expect(classifyBrowser(env({ brands: brands('Chromium', 'Microsoft Edge') })).family).toBe(
      'edge',
    );
    expect(classifyBrowser(env({ userAgent: `${CHROME_UA} Edg/131.0.2903.70` }))).toEqual({
      family: 'edge',
      engine: 'chromium',
      version: '131.0.2903.70',
    });
    expect(classifyBrowser(env({ userAgent: `${CHROME_UA} OPR/115.0.0.0` })).family).toBe('opera');
    expect(classifyBrowser(env({ brands: brands('Chromium', 'Opera GX') })).family).toBe('opera');
    expect(classifyBrowser(env({ brands: brands('Chromium', 'Brave') })).family).toBe('brave');
    expect(classifyBrowser(env({ brands: brands('Chromium'), isBrave: true })).family).toBe(
      'brave',
    );
    expect(
      classifyBrowser(env({ brands: brands('Chromium', 'Google Chrome'), isVivaldi: true })).family,
    ).toBe('vivaldi');
    expect(classifyBrowser(env({ brands: brands('Chromium', 'YaBrowser') })).family).toBe(
      'chromium',
    );
    // Without client hints, a plain Chrome user agent is Google Chrome.
    expect(classifyBrowser(env()).family).toBe('chrome');
  });

  it('detects Firefox from the extension URL or getBrowserInfo', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
    expect(classifyBrowser(env({ runtimeUrl: 'moz-extension://2b1c…/', userAgent: ua }))).toEqual({
      family: 'firefox',
      engine: 'firefox',
      version: '128.0',
    });
    expect(classifyBrowser(env({ firefoxVersion: '131.0.3', userAgent: ua })).version).toBe(
      '131.0.3',
    );
  });

  it('only sends versions the API accepts', () => {
    expect(cleanVersion('131.0.6778.86')).toBe('131.0.6778.86');
    expect(cleanVersion('131 beta')).toBe('0');
    expect(cleanVersion(null)).toBe('0');
    expect(classifyBrowser(env({ userAgent: 'Mozilla/5.0' })).version).toBe('0');
  });
});

describe('buildHeartbeat', () => {
  it('reports capabilities and the applied version', () => {
    expect(
      buildHeartbeat(
        { family: 'firefox', engine: 'firefox', version: '128.0' },
        { hostPermission: false, incognitoAllowed: true },
        '0.1.0',
        101,
      ),
    ).toEqual({
      extVersion: '0.1.0',
      browser: 'firefox',
      browserVersion: '128.0',
      incognitoAllowed: true,
      hostPermission: false,
      appliedExtRulesVersion: 101,
    });
  });
});

describe('sendHeartbeat', () => {
  async function setup() {
    const guardian = await fakeGuardian();
    const ctx = testContext(guardian.fetch);
    await ctx.store.setPairing(pairingFixture(guardian.publicKey));
    let outdated = 0;
    let applied = 0;
    const deps: HeartbeatDeps = {
      browser: async () => ({ family: 'chrome', engine: 'chromium', version: '131.0.0.0' }),
      capabilities: async () => ({ hostPermission: true, incognitoAllowed: false }),
      extVersion: '0.1.0',
      appliedExtRulesVersion: () => applied,
      rulesOutdated: () => {
        outdated += 1;
      },
    };
    return {
      guardian,
      ctx,
      deps,
      outdated: () => outdated,
      setApplied: (v: number) => {
        applied = v;
      },
    };
  }

  it('sends the capabilities and asks for a sync when versions differ', async () => {
    const { guardian, ctx, deps, outdated, setApplied } = await setup();
    await syncRulesOnce(ctx);
    setApplied(100);
    expect(await sendHeartbeat(ctx, deps)).toBe('sent');
    const beat = guardian.calls.find((c) => c.url.pathname === '/v1/ext/heartbeat')!;
    expect(beat.method).toBe('POST');
    expect(beat.body).toEqual({
      extVersion: '0.1.0',
      browser: 'chrome',
      browserVersion: '131.0.0.0',
      incognitoAllowed: false,
      hostPermission: true,
      appliedExtRulesVersion: 100,
    });
    expect(outdated()).toBe(0);
    const status = await ctx.store.getStatus();
    expect(status.lastHeartbeatAt).toBe(NOW);
    expect(status.guardianExtRulesVersion).toBe(100);

    guardian.heartbeatVersion = 101;
    await sendHeartbeat(ctx, deps);
    expect(outdated()).toBe(1);
  });

  it('reports version 0 for rules verified under another pairing', async () => {
    const { guardian, ctx, deps, setApplied } = await setup();
    setApplied(100);
    await sendHeartbeat(ctx, deps);
    const beat = guardian.calls.find((c) => c.url.pathname === '/v1/ext/heartbeat')!;
    expect((beat.body as { appliedExtRulesVersion: number }).appliedExtRulesVersion).toBe(0);
  });

  it('keeps the 403 reason for the popup', async () => {
    const { guardian, ctx, deps } = await setup();
    guardian.heartbeatError = [403, 'insufficient_scope', { reason: 'browser_mismatch' }];
    expect(await sendHeartbeat(ctx, deps)).toBe('rejected');
    expect((await ctx.store.getStatus()).heartbeatError).toEqual({
      code: 'browser_mismatch',
      status: 403,
      at: NOW,
    });
    guardian.heartbeatError = null;
    await sendHeartbeat(ctx, deps);
    expect((await ctx.store.getStatus()).heartbeatError).toBeNull();
  });

  it('marks the pairing on 401 and then stays quiet', async () => {
    const { guardian, ctx, deps } = await setup();
    guardian.tokens.clear();
    expect(await sendHeartbeat(ctx, deps)).toBe('unauthorized');
    expect((await ctx.store.getPairing())?.unauthorizedAt).toBe(NOW);
    const count = guardian.calls.length;
    expect(await sendHeartbeat(ctx, deps)).toBe('unauthorized');
    expect(guardian.calls).toHaveLength(count);
  });

  it('is skipped while unpaired and reports a missing guardian', async () => {
    const { guardian, ctx, deps } = await setup();
    guardian.mode = 'down';
    expect(await sendHeartbeat(ctx, deps)).toBe('unreachable');
    await ctx.store.clearPairing();
    expect(await sendHeartbeat(ctx, deps)).toBe('unpaired');
  });
});
