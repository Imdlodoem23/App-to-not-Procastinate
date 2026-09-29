/** Mappings to the guardian vocabulary (DESIGN.md §7.7–7.8). */
import { describe, expect, it } from 'vitest';
import { heartbeatState, strikeCauseFor } from '../../src/state/heartbeat-state';
import type { AttentionSnapshot, AttentionState } from '../../src/types';

function snap(state: AttentionState, low = false, drowsy = false): AttentionSnapshot {
  return {
    at: 0,
    mode: 'camera',
    state,
    score: null,
    low,
    presence: 'visible',
    cause: null,
    drowsy,
    classifier: null,
    graceLeftMs: 0,
    doubtInMs: null,
    strikeInMs: null,
    hints: [],
  };
}

describe('heartbeatState', () => {
  it.each([
    ['warmup', false, false, 'focused'],
    ['focused', false, false, 'focused'],
    ['focused', true, false, 'doubt'],
    ['focused', false, true, 'doubt'],
    ['warmup', false, true, 'doubt'],
    ['doubt', true, false, 'doubt'],
    ['away', false, false, 'away'],
    ['break', false, false, 'break'],
    ['paused', false, false, 'paused'],
    ['ended', false, false, 'paused'],
  ] as const)('%s low=%s drowsy=%s → %s', (state, low, drowsy, expected) => {
    expect(heartbeatState(snap(state, low, drowsy))).toBe(expected);
  });
});

describe('strikeCauseFor', () => {
  it('keeps phone and distraction app, times out the rest', () => {
    expect(strikeCauseFor('phone')).toBe('phone');
    expect(strikeCauseFor('distraction_app')).toBe('distraction_app');
    expect(strikeCauseFor('looking_away')).toBe('doubt_timeout');
    expect(strikeCauseFor('idle')).toBe('doubt_timeout');
    expect(strikeCauseFor('unknown')).toBe('doubt_timeout');
    expect(strikeCauseFor(null)).toBe('doubt_timeout');
  });
});
