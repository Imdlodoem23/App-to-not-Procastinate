import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  FEATURE_NAMES,
  featureEnabled,
  resolveFeatures,
} from '../../src/shared/features';
import {
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  SEND_CHANNELS,
  isInvokeChannel,
  isPushChannel,
  isSendChannel,
} from '../../src/shared/ipc';

describe('IPC channel lists', () => {
  const all = [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...PUSH_CHANNELS];

  it('are unique across kinds and follow `area:action`', () => {
    expect(new Set(all).size).toBe(all.length);
    for (const channel of all) expect(channel).toMatch(/^[a-z]+:[a-z-]+$/);
  });

  it('guards accept only their own kind', () => {
    for (const c of INVOKE_CHANNELS) {
      expect(isInvokeChannel(c)).toBe(true);
      expect(isSendChannel(c) || isPushChannel(c)).toBe(false);
    }
    for (const c of SEND_CHANNELS) expect(isSendChannel(c) && !isInvokeChannel(c)).toBe(true);
    for (const c of PUSH_CHANNELS) expect(isPushChannel(c) && !isInvokeChannel(c)).toBe(true);
    expect(isInvokeChannel('toString')).toBe(false);
    expect(isInvokeChannel('__proto__')).toBe(false);
    expect(isSendChannel(42)).toBe(false);
  });

  it('push channels are all ui:*, and nothing carries a token', () => {
    for (const c of PUSH_CHANNELS) expect(c.startsWith('ui:')).toBe(true);
    for (const c of all) expect(c).not.toMatch(/token/);
  });
});

describe('feature flags', () => {
  it('ship all off in Phase 1', () => {
    for (const name of FEATURE_NAMES) expect(FEATURES[name]).toBe(false);
    expect(Object.isFrozen(FEATURES)).toBe(true);
  });

  it('resolve overrides and capabilities', () => {
    const flags = resolveFeatures({ study: true, bogus: true, stats: 'yes' });
    expect(flags.study).toBe(true);
    expect(flags.stats).toBe(false);
    expect('bogus' in flags).toBe(false);
    expect(featureEnabled(flags, 'study', null)).toBe(true);
    expect(featureEnabled(flags, 'study', ['blocks'])).toBe(false);
    expect(featureEnabled(flags, 'study', ['study'])).toBe(true);
    expect(featureEnabled(FEATURES, 'study', ['study'])).toBe(false);
  });
});
