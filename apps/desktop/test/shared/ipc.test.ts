import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  FEATURE_NAMES,
  PHASE1_FEATURES,
  featureEnabled,
  resolveFeatures,
} from '../../src/shared/features';
import {
  INVOKE_CHANNELS,
  PHASE5_INVOKE_CHANNELS,
  PHASE5_SEND_CHANNELS,
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
    for (const channel of all) expect(channel).toMatch(/^[a-z]+(?:-[a-z]+)*:[a-z-]+$/);
  });

  it('list the Phase 5 channels among the invoke and send channels', () => {
    for (const c of PHASE5_INVOKE_CHANNELS) expect(INVOKE_CHANNELS).toContain(c);
    for (const c of PHASE5_SEND_CHANNELS) expect(SEND_CHANNELS).toContain(c);
    expect(new Set(PHASE5_INVOKE_CHANNELS).size).toBe(PHASE5_INVOKE_CHANNELS.length);
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
  it('ship every Phase 5 feature on and Study Mode off', () => {
    for (const name of FEATURE_NAMES) expect(FEATURES[name], name).toBe(name !== 'study');
    for (const name of FEATURE_NAMES) expect(PHASE1_FEATURES[name], name).toBe(false);
    expect(Object.isFrozen(FEATURES)).toBe(true);
    expect(Object.isFrozen(PHASE1_FEATURES)).toBe(true);
  });

  it('resolve overrides and capabilities', () => {
    const flags = resolveFeatures({ study: true, bogus: true, stats: 'yes', osd: false });
    expect(flags.study).toBe(true);
    expect(flags.stats).toBe(true);
    expect(flags.osd).toBe(false);
    expect('bogus' in flags).toBe(false);
    expect(featureEnabled(flags, 'study', null)).toBe(true);
    expect(featureEnabled(flags, 'study', ['blocks'])).toBe(false);
    expect(featureEnabled(flags, 'study', ['study'])).toBe(true);
    expect(featureEnabled(FEATURES, 'study', ['study'])).toBe(false);
  });
});
