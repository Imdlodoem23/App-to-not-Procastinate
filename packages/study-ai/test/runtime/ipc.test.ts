import { describe, expect, it } from 'vitest';
import { serializeProfile } from '../../src/calibration/profile';
import { isAnalysisInbound, isAnalysisOutbound } from '../../src/runtime/ipc';
import type {
  AnalysisInbound,
  AnalysisOutbound,
  AttentionSnapshot,
  AttentionTotals,
  LoopStats,
  SessionReport,
} from '../../src/types';
import { mulberry32 } from '../../src/util/rng';
import { profileFor } from '../calibration/fixtures';

/** A genuine profile, as the analysis window serialises it. */
const PROFILE_JSON = serializeProfile(profileFor('baseline'));

const CONTEXT = { phase: 'work', foreground: 'study', idleMs: 1_200 } as const;

const INBOUND: AnalysisInbound[] = [
  {
    type: 'session_start',
    mode: 'camera',
    settings: { doubtAfterMs: 20_000, focusScoreThreshold: 60 },
    profileJson: '{"format":"centrate-study-ai-profile"}',
    cameraDeviceId: 'abc123',
    context: CONTEXT,
  },
  {
    type: 'session_start',
    mode: 'no-camera',
    settings: {},
    profileJson: null,
    cameraDeviceId: null,
    context: { phase: 'break', foreground: 'unknown', idleMs: null },
  },
  { type: 'context', context: CONTEXT },
  { type: 'settings', settings: { noCameraIdleMs: 300_000 } },
  { type: 'strike_result', ack: { seq: 1, counted: true, reason: null, cooldownLeftMs: 60_000 } },
  {
    type: 'strike_result',
    ack: { seq: 2, counted: false, reason: 'cooldown', cooldownLeftMs: null },
  },
  { type: 'studying_feedback' },
  { type: 'continue_without_camera' },
  { type: 'resume' },
  { type: 'session_stop' },
  { type: 'calibration_start', profileJson: null, cameraDeviceId: null },
  { type: 'calibration_record', cls: 'paper' },
  { type: 'calibration_cancel' },
  { type: 'calibration_build' },
  { type: 'calibration_close' },
];

const SNAPSHOT: AttentionSnapshot = {
  at: 1_234.5,
  mode: 'camera',
  state: 'doubt',
  score: 41,
  low: true,
  presence: 'visible',
  cause: 'phone',
  drowsy: false,
  classifier: 'personal',
  graceLeftMs: 0,
  doubtInMs: null,
  strikeInMs: 12_000,
  hints: ['low_light', 'throttled'],
};

const TOTALS: AttentionTotals = {
  focusedMs: 60_000,
  warnings: 2,
  strikesRequested: 1,
  ticks: 300,
  workMs: 90_000,
};

const LOOP: LoopStats = {
  ticks: 300,
  errors: 0,
  fps: 3,
  duty: 0.07,
  processCpuPct: null,
  level: 1,
  overBudget: false,
  throttled: false,
  lastTickAt: 1_234,
  maxGapMs: 340,
};

const REPORT: SessionReport = {
  runId: '0123456789abcdef01234567',
  at: 1_500,
  mode: 'camera',
  camera: 'ok',
  cameraOn: true,
  snapshot: SNAPSHOT,
  totals: TOTALS,
  loop: LOOP,
};

const CONFUSION = [
  [10, 0, 0, 0, 0],
  [0, 10, 0, 0, 0],
  [0, 0, 9, 1, 0],
  [0, 0, 1, 9, 0],
  [0, 0, 0, 0, 10],
];

const OUTBOUND: AnalysisOutbound[] = [
  { type: 'event', event: { type: 'state', at: 1, from: 'focused', to: 'doubt' } },
  { type: 'event', event: { type: 'warning', at: 1, kind: 'absent' } },
  { type: 'event', event: { type: 'doubt_cleared', at: 1, by: 'feedback' } },
  { type: 'event', event: { type: 'strike', at: 1, cause: 'no_face', seq: 3 } },
  { type: 'event', event: { type: 'suggest_break', at: 1, reason: 'eyes_closed' } },
  { type: 'event', event: { type: 'hint', at: 1, code: 'camera_covered', active: true } },
  {
    type: 'event',
    event: { type: 'profile_updated', at: 1, profileJson: PROFILE_JSON, reason: 'feedback' },
  },
  { type: 'event', event: { type: 'camera', at: 1, status: 'error', error: 'in_use' } },
  { type: 'event', event: { type: 'camera', at: 1, status: 'ok', error: null } },
  { type: 'event', event: { type: 'mode', at: 1, mode: 'no-camera', reason: 'vision_failed' } },
  { type: 'report', report: REPORT },
  { type: 'report', report: { ...REPORT, mode: 'no-camera', loop: null } },
  { type: 'feedback_result', outcome: { ok: true, added: 12, doubtCleared: true } },
  { type: 'feedback_result', outcome: { ok: false, reason: 'limit_reached' } },
  {
    type: 'session_stopped',
    summary: {
      totals: TOTALS,
      timeline: {
        durationMs: 90_000,
        segments: [{ startMs: 0, endMs: 90_000, kind: 'focused' }],
        marks: [
          { atMs: 5_000, kind: 'strike', cause: 'phone' },
          { atMs: 6_000, kind: 'warning', cause: null },
        ],
      },
    },
  },
  {
    type: 'calibration_progress',
    progress: {
      cls: 'screen',
      phase: 'recording',
      elapsedMs: 5_000,
      remainingMs: 15_000,
      frames: 12,
      faceRatio: 1,
      liveIssues: ['no_face'],
    },
  },
  {
    type: 'calibration_recorded',
    summary: {
      cls: 'phone',
      rows: 70,
      faceRatio: 0.9,
      issues: [{ code: 'phone_not_seen', cls: 'phone', severity: 'warning' }],
    },
  },
  {
    type: 'calibration_built',
    outcome: {
      ok: true,
      profileJson: PROFILE_JSON,
      report: {
        cvBinaryBalancedAccuracy: 0.97,
        recall: { screen: 1, paper: 0.95, phone: 0.9, away: null, absent: 1 },
        confusion: CONFUSION,
        weak: false,
      },
      issues: [
        { code: 'weak_separation', cls: null, severity: 'warning', pair: ['phone', 'away'] },
      ],
    },
  },
  {
    type: 'calibration_built',
    outcome: { ok: false, issues: [{ code: 'missing', cls: 'away', severity: 'error' }] },
  },
  { type: 'error', code: 'camera_failed', camera: 'permission_denied' },
  { type: 'error', code: 'busy', camera: null },
];

/** Every way to damage one leaf or key of a message. */
function mutations(value: unknown): unknown[] {
  const out: unknown[] = [];
  const bad: unknown[] = [
    undefined,
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    'x',
    '',
    true,
    {},
    [],
    1e9,
  ];
  const visit = (node: unknown, rebuild: (replacement: unknown) => unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) =>
        visit(child, (r) => rebuild(node.map((c, j) => (j === i ? r : c)))),
      );
      out.push(rebuild([...node, node[0] ?? 0]));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        visit(record[key], (r) => rebuild({ ...record, [key]: r }));
        const { [key]: _removed, ...rest } = record;
        out.push(rebuild(rest));
      }
      out.push(rebuild({ ...record, extra: 1 }));
      return;
    }
    for (const b of bad) if (!Object.is(b, node)) out.push(rebuild(b));
  };
  visit(value, (r) => r);
  return out;
}

/** Mutations that are still valid by construction (e.g. another enum member) are fine. */
function acceptableAnyway(candidate: unknown, check: (v: unknown) => boolean): boolean {
  return check(candidate);
}

describe('isAnalysisInbound', () => {
  it('accepts every inbound message type', () => {
    const types = new Set(INBOUND.map((m) => m.type));
    expect(types.size).toBe(13);
    for (const message of INBOUND) expect(isAnalysisInbound(message), message.type).toBe(true);
  });

  it('rejects non-objects, unknown types and prototypes other than Object', () => {
    for (const value of [null, undefined, 1, 'context', [], [INBOUND[2]], { type: 'nope' }]) {
      expect(isAnalysisInbound(value)).toBe(false);
    }
    class Message {
      type = 'resume';
    }
    expect(isAnalysisInbound(new Message())).toBe(false);
  });

  it('rejects every damaged leaf, missing key and extra key', () => {
    let rejected = 0;
    let accepted = 0;
    for (const message of INBOUND) {
      for (const candidate of mutations(message)) {
        if (acceptableAnyway(candidate, isAnalysisInbound)) {
          // Only still-valid values pass: a nullable leaf set to null, a large finite
          // number, or an optional settings key removed.
          accepted += 1;
          expect(JSON.stringify(candidate)).not.toMatch(/"extra"|NaN|Infinity/);
        } else {
          rejected += 1;
        }
      }
    }
    expect(rejected).toBeGreaterThan(150);
    expect(accepted / (accepted + rejected)).toBeLessThan(0.15);
  });

  it('caps the profile JSON at 512 KB and device ids at 512 characters', () => {
    const big = 'x'.repeat(512 * 1024 + 1);
    expect(
      isAnalysisInbound({ type: 'calibration_start', profileJson: big, cameraDeviceId: null }),
    ).toBe(false);
    expect(
      isAnalysisInbound({
        type: 'calibration_start',
        profileJson: null,
        cameraDeviceId: 'd'.repeat(513),
      }),
    ).toBe(false);
  });

  it('rejects unknown settings keys and non-finite settings', () => {
    expect(isAnalysisInbound({ type: 'settings', settings: { foo: 1 } })).toBe(false);
    expect(isAnalysisInbound({ type: 'settings', settings: { doubtAfterMs: Number.NaN } })).toBe(
      false,
    );
    expect(isAnalysisInbound({ type: 'settings', settings: { doubtAfterMs: '15000' } })).toBe(
      false,
    );
  });

  it('survives a seeded fuzz of random junk', () => {
    const rng = mulberry32(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
    const leaves = [0, -1, 1.5, Number.NaN, 'work', 'resume', null, true, [], {}];
    const junk = (depth: number): unknown => {
      if (depth <= 0 || rng() < 0.3) return pick(leaves);
      if (rng() < 0.3) return Array.from({ length: Math.floor(rng() * 3) }, () => junk(depth - 1));
      const keys = ['type', 'context', 'settings', 'ack', 'cls', 'phase', 'mode'];
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < 3; i += 1) obj[pick(keys)] = junk(depth - 1);
      if (rng() < 0.5) obj.type = pick(INBOUND).type;
      return obj;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const value = junk(4);
      expect(() => isAnalysisInbound(value)).not.toThrow();
    }
  });
});

describe('isAnalysisOutbound', () => {
  it('accepts every outbound message type and event type', () => {
    const types = new Set(OUTBOUND.map((m) => m.type));
    expect(types.size).toBe(8);
    for (const message of OUTBOUND) {
      expect(isAnalysisOutbound(message), JSON.stringify(message).slice(0, 80)).toBe(true);
    }
  });

  it('rejects every damaged leaf, missing key and extra key', () => {
    let rejected = 0;
    let accepted = 0;
    for (const message of OUTBOUND) {
      for (const candidate of mutations(message)) {
        if (acceptableAnyway(candidate, isAnalysisOutbound)) accepted += 1;
        else rejected += 1;
      }
    }
    // Accepted mutations are only the ones that stay valid (e.g. score 1 → another number,
    // an optional `pair` removed, a nullable leaf set to null).
    expect(rejected).toBeGreaterThan(600);
    expect(accepted / (accepted + rejected)).toBeLessThan(0.25);
  });

  it('never accepts pixels: unknown keys such as an image are rejected', () => {
    const withImage = {
      type: 'report',
      report: { ...REPORT, snapshot: { ...SNAPSHOT, image: [1, 2, 3] } },
    };
    expect(isAnalysisOutbound(withImage)).toBe(false);
    expect(
      isAnalysisOutbound({
        type: 'event',
        event: { type: 'hint', at: 1, code: 'low_light', active: true, frame: {} },
      }),
    ).toBe(false);
  });

  it('checks score bounds, non-negative times and the run id alphabet', () => {
    const bad = [
      { ...REPORT, snapshot: { ...SNAPSHOT, score: 101 } },
      { ...REPORT, snapshot: { ...SNAPSHOT, score: 50.5 } },
      { ...REPORT, at: -1 },
      { ...REPORT, runId: 'a b' },
      { ...REPORT, totals: { ...TOTALS, warnings: 1.5 } },
      { ...REPORT, snapshot: { ...SNAPSHOT, hints: ['nope'] } },
    ];
    for (const report of bad) expect(isAnalysisOutbound({ type: 'report', report })).toBe(false);
  });
});
