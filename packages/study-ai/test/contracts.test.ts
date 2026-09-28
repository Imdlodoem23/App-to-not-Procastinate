/** Compile-time contracts with @centrate/shared (lead-owned). */
import type { HeartbeatRequest } from '@centrate/shared/guardian-api';
import { HEARTBEAT_STATES, STRIKE_CAUSES, STUDY_PHASES } from '@centrate/shared/domain';
import { describe, expect, it } from 'vitest';
import type { HeartbeatBody } from '../src/types';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T | undefined => undefined;

describe('contracts with @centrate/shared', () => {
  it('HeartbeatBody is HeartbeatRequest without seq', () => {
    assertType<Equal<HeartbeatBody, Omit<HeartbeatRequest, 'seq'>>>();
    const body: HeartbeatBody = {
      state: 'focused',
      focusScore: 80,
      focusedMsSinceLast: 15_000,
      warningsSinceLast: 0,
      cameraOn: true,
    };
    const request: HeartbeatRequest = { seq: 1, ...body };
    expect(request.seq).toBe(1);
  });

  it('uses the guardian vocabularies', () => {
    expect(HEARTBEAT_STATES).toEqual(['focused', 'doubt', 'away', 'break', 'paused']);
    expect(STRIKE_CAUSES).toEqual(['doubt_timeout', 'no_face', 'phone', 'distraction_app']);
    expect(STUDY_PHASES).toEqual(['work', 'break', 'paused', 'ended']);
  });
});
