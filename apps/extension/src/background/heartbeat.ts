/**
 * Browser detection, capabilities and `POST /v1/ext/heartbeat` (docs/ARCHITECTURE.md §8.8).
 *
 * The heartbeat goes out on the 30 s tick and after every rules change. It reports the
 * browser family (the guardian checks it against the family bound at pairing and against
 * the loopback peer's process), whether `<all_urls>` is granted (without it the DNR
 * redirects silently do nothing; Firefox asks for it at runtime), whether the extension may
 * run in incognito, and the `extRulesVersion` applied. If the guardian's version differs,
 * the rules loop is woken.
 */

import type { BrowserFamily } from '@centrate/shared/domain';
import type { ExtHeartbeatRequest } from '@centrate/shared/guardian-api';
import type { BackgroundContext } from './client';
import { createExtensionClient, describeError, markUnauthorized, sameBaseline } from './client';
import type { BrowserInfo, Capabilities } from './state';

// ---------------------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------------------

export interface BrandVersion {
  brand: string;
  version: string;
}

/** What detection looks at, gathered by `readBrowserEnv` (a plain object in tests). */
export interface BrowserEnv {
  /** `chrome.runtime.getURL('')`: `moz-extension://…` in Firefox. */
  runtimeUrl: string;
  userAgent: string;
  /** `navigator.userAgentData.brands` (Chromium only). */
  brands: readonly BrandVersion[];
  /** `getHighEntropyValues(['fullVersionList'])`, when available. */
  fullVersionList: readonly BrandVersion[];
  /** `navigator.brave.isBrave()`. */
  isBrave: boolean;
  /** Vivaldi adds `vivExtData` to windows and tabs (its user agent looks like Chrome's). */
  isVivaldi: boolean;
  /** `browser.runtime.getBrowserInfo().version` (Firefox only). */
  firefoxVersion: string | null;
}

const VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;

/** A version the API accepts (`[0-9A-Za-z.+_-]{1,64}`), `0` otherwise. */
export function cleanVersion(version: string | null | undefined): string {
  return typeof version === 'string' && VERSION_RE.test(version) ? version : '0';
}

function uaVersion(userAgent: string, token: string): string | null {
  const match = new RegExp(`\\b${token}/([0-9][0-9A-Za-z.]*)`).exec(userAgent);
  return match?.[1] ?? null;
}

/**
 * The `BrowserFamily` the guardian expects for this browser (catalog `BROWSERS`
 * `extensionFamily`): Edge, Opera (also Opera GX), Vivaldi, Brave, Google Chrome (also
 * Arc, which presents itself as Chrome), other Chromium builds, and Firefox.
 */
export function classifyBrowser(env: BrowserEnv): BrowserInfo {
  const ua = env.userAgent;
  if (env.runtimeUrl.startsWith('moz-extension:') || env.firefoxVersion !== null) {
    return {
      family: 'firefox',
      engine: 'firefox',
      version: cleanVersion(env.firefoxVersion ?? uaVersion(ua, 'Firefox')),
    };
  }
  const brands = new Set(env.brands.map((b) => b.brand));
  const brandVersion = (brand: string): string | null =>
    env.fullVersionList.find((b) => b.brand === brand)?.version ??
    env.brands.find((b) => b.brand === brand)?.version ??
    null;
  const chromium =
    brandVersion('Chromium') ?? brandVersion('Google Chrome') ?? uaVersion(ua, 'Chrome');
  const make = (family: BrowserFamily, version: string | null): BrowserInfo => ({
    family,
    engine: 'chromium',
    version: cleanVersion(version ?? chromium),
  });

  if (brands.has('Microsoft Edge') || /\bEdg\//.test(ua)) {
    return make('edge', brandVersion('Microsoft Edge') ?? uaVersion(ua, 'Edg'));
  }
  if (brands.has('Opera') || brands.has('Opera GX') || /\bOPR\//.test(ua)) {
    return make('opera', brandVersion('Opera') ?? brandVersion('Opera GX') ?? uaVersion(ua, 'OPR'));
  }
  if (env.isVivaldi || /\bVivaldi\//.test(ua)) return make('vivaldi', uaVersion(ua, 'Vivaldi'));
  if (env.isBrave || brands.has('Brave')) return make('brave', brandVersion('Brave'));
  if (brands.has('Google Chrome')) return make('chrome', brandVersion('Google Chrome'));
  if (brands.size === 0 && /\bChrome\//.test(ua) && !/\bChromium\//.test(ua)) {
    // No UA client hints (older builds): assume Google Chrome, the common case.
    return make('chrome', uaVersion(ua, 'Chrome'));
  }
  return make('chromium', chromium);
}

interface UaDataLike {
  brands?: readonly BrandVersion[];
  getHighEntropyValues?(hints: string[]): Promise<{ fullVersionList?: BrandVersion[] }>;
}

interface NavigatorLike {
  userAgent?: string;
  userAgentData?: UaDataLike;
  brave?: { isBrave?(): Promise<boolean> };
}

interface FirefoxNamespace {
  runtime?: { getBrowserInfo?(): Promise<{ name: string; version: string }> };
}

async function settle<T>(promise: Promise<T> | undefined, fallback: T): Promise<T> {
  try {
    return (await promise) ?? fallback;
  } catch {
    return fallback;
  }
}

function hasVivaldiData(items: readonly object[]): boolean {
  return items.some((item) => 'vivExtData' in item);
}

/** Reads the detection inputs from the running browser. */
export async function readBrowserEnv(): Promise<BrowserEnv> {
  const nav = (globalThis.navigator ?? {}) as NavigatorLike;
  const firefox = (globalThis as { browser?: FirefoxNamespace }).browser;
  const [info, highEntropy, isBrave, windows, tabs] = await Promise.all([
    settle(firefox?.runtime?.getBrowserInfo?.(), null),
    settle(nav.userAgentData?.getHighEntropyValues?.(['fullVersionList']), {}),
    settle(nav.brave?.isBrave?.(), false),
    settle<object[]>(chrome.windows?.getAll?.(), []),
    settle<object[]>(chrome.tabs?.query?.({ active: true }), []),
  ]);
  return {
    runtimeUrl: chrome.runtime.getURL(''),
    userAgent: nav.userAgent ?? '',
    brands: nav.userAgentData?.brands ?? [],
    fullVersionList: highEntropy.fullVersionList ?? [],
    isBrave: isBrave === true,
    isVivaldi: hasVivaldiData(windows) || hasVivaldiData(tabs),
    firefoxVersion: info !== null && /firefox/i.test(info.name) ? info.version : null,
  };
}

let detected: Promise<BrowserInfo> | null = null;

/** The running browser (detected once per worker lifetime). */
export function detectBrowser(): Promise<BrowserInfo> {
  detected ??= readBrowserEnv().then(classifyBrowser, () =>
    classifyBrowser({
      runtimeUrl: '',
      userAgent: '',
      brands: [],
      fullVersionList: [],
      isBrave: false,
      isVivaldi: false,
      firefoxVersion: null,
    }),
  );
  return detected;
}

/** The extension's own version (`manifest.version`). */
export function extensionVersion(): string {
  return cleanVersion(chrome.runtime.getManifest().version);
}

// ---------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------

/** The host permission every redirect rule needs. */
export const ALL_URLS_PERMISSION: chrome.permissions.Permissions = Object.freeze({
  origins: ['<all_urls>'],
});

/**
 * `hostPermission`: `permissions.contains({ origins: ['<all_urls>'] })` (Chrome grants it
 * at install unless the user limits site access; Firefox MV3 asks the user, and the guide
 * requests it with `permissions.request` from a click). `incognitoAllowed`:
 * `extension.isAllowedIncognitoAccess()`.
 */
export async function readCapabilities(): Promise<Capabilities> {
  const [hostPermission, incognitoAllowed] = await Promise.all([
    settle(chrome.permissions.contains(ALL_URLS_PERMISSION), false),
    settle(chrome.extension.isAllowedIncognitoAccess(), false),
  ]);
  return { hostPermission, incognitoAllowed };
}

// ---------------------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------------------

export interface HeartbeatDeps {
  browser(): Promise<BrowserInfo>;
  capabilities(): Promise<Capabilities>;
  extVersion: string;
  /** `extRulesVersion` of the rules last handed to the appliers (0 when none). */
  appliedExtRulesVersion(): number;
  /** The guardian has another `extRulesVersion`: sync now. */
  rulesOutdated(): void;
}

export type HeartbeatOutcome =
  'sent' | 'unpaired' | 'unauthorized' | 'unreachable' | 'rejected' | 'error';

/** Builds the heartbeat body (pure). */
export function buildHeartbeat(
  browser: BrowserInfo,
  capabilities: Capabilities,
  extVersion: string,
  appliedExtRulesVersion: number,
): ExtHeartbeatRequest {
  return {
    extVersion: cleanVersion(extVersion),
    browser: browser.family,
    browserVersion: cleanVersion(browser.version),
    incognitoAllowed: capabilities.incognitoAllowed,
    hostPermission: capabilities.hostPermission,
    appliedExtRulesVersion: Math.max(0, Math.trunc(appliedExtRulesVersion)),
  };
}

/**
 * Sends one heartbeat. Skipped while unpaired or unauthorized. A 403 is kept in
 * `status.heartbeatError` with its `details.reason` (`browser_mismatch`: the token was
 * paired in another browser; `peer_not_browser`) for the popup.
 */
export async function sendHeartbeat(
  ctx: BackgroundContext,
  deps: HeartbeatDeps,
): Promise<HeartbeatOutcome> {
  const pairing = await ctx.store.getPairing();
  if (pairing === null) return 'unpaired';
  if (pairing.unauthorizedAt !== null) return 'unauthorized';
  const record = await ctx.store.getRules();
  const applied = sameBaseline(record, pairing) ? deps.appliedExtRulesVersion() : 0;
  const [browser, capabilities] = await Promise.all([deps.browser(), deps.capabilities()]);
  const body = buildHeartbeat(browser, capabilities, deps.extVersion, applied);

  try {
    const response = await createExtensionClient(pairing, ctx.fetch).extHeartbeat(body);
    const now = ctx.now();
    await ctx.store.patchStatus({
      lastHeartbeatAt: now,
      guardianExtRulesVersion: response.extRulesVersion,
      heartbeatError: null,
    });
    await ctx.changed('status');
    if (response.extRulesVersion !== applied) deps.rulesOutdated();
    return 'sent';
  } catch (error) {
    const failure = describeError(error, ctx.now());
    await ctx.store.patchStatus({ heartbeatError: failure });
    if (failure.status === 401) await markUnauthorized(ctx, pairing, failure.at);
    await ctx.changed('status');
    if (failure.status === 401) return 'unauthorized';
    if (failure.code === 'unreachable' || failure.code === 'timeout') return 'unreachable';
    return failure.status === 403 ? 'rejected' : 'error';
  }
}
