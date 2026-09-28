import {
  GuardianApiError,
  emptyTargets,
  isCreateBlockRequest,
} from '@centrate/shared/guardian-api';
import { parseIntent } from '@centrate/shared/parser';
import { describe, expect, it } from 'vitest';
import { HARNESS_NOW, harnessFixture, makeBlock } from '../../src/shared/fixtures';
import {
  DEFAULT_PREFS,
  DEFAULT_TEMPLATES,
  bloqueoVariant,
  draftFromParse,
  draftFromSeed,
  draftFromTemplate,
  draftNeedsConsequence,
  draftProblem,
  draftSeedFromParse,
  draftToCreateRequest,
  initialMainLocal,
  isGuardianUnresponsive,
  isIntentId,
  maxExtendMinutes,
  reconcileMainLocal,
  toUiError,
  withMode,
  type BlockDraft,
} from '../../src/shared/ui-state';

const now = HARNESS_NOW;
const MIN = 60_000;

function draft(patch: Partial<BlockDraft> = {}): BlockDraft {
  return {
    targets: { ...emptyTargets(), serviceIds: ['youtube'] },
    whitelistOnly: false,
    savedTargets: null,
    mode: 'normal',
    end: { kind: 'duration', minutes: 60 },
    reason: 'Quiero aprobar mates',
    ...patch,
  };
}

describe('toUiError', () => {
  it('maps client and HTTP errors to kinds', () => {
    expect(toUiError(new GuardianApiError(0, 'timeout', 'x')).kind).toBe('timeout');
    expect(toUiError(new GuardianApiError(0, 'unreachable', 'x')).kind).toBe('unreachable');
    expect(
      toUiError(new GuardianApiError(0, 'unreachable', 'x'), { clientJsonMissing: true }).kind,
    ).toBe('not_installed');
    expect(toUiError(new GuardianApiError(0, 'invalid_response', 'x')).kind).toBe(
      'invalid_response',
    );
    expect(toUiError(new GuardianApiError(401, 'unauthorized', 'x')).kind).toBe('unauthorized');
    expect(toUiError(new GuardianApiError(503, 'read_only', 'x')).kind).toBe('read_only');
    const rejected = toUiError(
      new GuardianApiError(422, 'extension_exceeds_max', 'x', { maxAddMinutes: 60 }),
    );
    expect(rejected).toEqual({
      kind: 'rejected',
      code: 'extension_exceeds_max',
      status: 422,
      details: { maxAddMinutes: 60 },
    });
    expect(toUiError(new GuardianApiError(500, 'internal', 'x')).kind).toBe('internal');
    expect(toUiError(new Error('boom'))).toEqual({
      kind: 'internal',
      code: 'internal',
      status: 0,
      details: null,
    });
    // Duck-typed (lost its class crossing a boundary).
    expect(toUiError({ status: 409, code: 'block_not_active', details: null }).kind).toBe(
      'rejected',
    );
  });

  it('knows which errors mean «El guardián no responde»', () => {
    expect(isGuardianUnresponsive(toUiError(new GuardianApiError(0, 'timeout', 'x')))).toBe(true);
    expect(isGuardianUnresponsive(toUiError(new GuardianApiError(409, 'x', 'x')))).toBe(false);
  });

  it('accepts idempotency-safe intent ids only', () => {
    expect(isIntentId('0b9e6f7e-2c1a-4c55-9c1e-6f1d2b3c4d5e')).toBe(true);
    expect(isIntentId('bad id')).toBe(false);
    expect(isIntentId('x'.repeat(129))).toBe(false);
  });
});

describe('drafts', () => {
  it('builds requests the guardian validator accepts, with the right acknowledgements', () => {
    const cases: Array<[BlockDraft, boolean, boolean]> = [
      [draft(), false, false],
      [draft({ end: { kind: 'duration', minutes: 360 } }), true, false],
      [draft({ mode: 'hardcore' }), false, true],
      [withMode(draft(), 'exam'), false, true],
      [
        draft({ end: { kind: 'until', endsAt: new Date(now + 90 * MIN).toISOString() } }),
        false,
        false,
      ],
    ];
    for (const [d, long, noEmergency] of cases) {
      const request = draftToCreateRequest(d, now);
      expect(isCreateBlockRequest(request)).toBe(true);
      expect(request.acknowledgeLong).toBe(long);
      expect(request.acknowledgeNoEmergency).toBe(noEmergency);
      expect(draftNeedsConsequence(d, now)).toBe(long || noEmergency);
    }
  });

  it('keeps targets aside while in Examen and restores them', () => {
    const exam = withMode(draft(), 'exam');
    expect(exam.whitelistOnly).toBe(true);
    expect(exam.targets).toEqual(emptyTargets());
    const back = withMode(exam, 'strict');
    expect(back.whitelistOnly).toBe(false);
    expect(back.targets.serviceIds).toEqual(['youtube']);
    expect(back.savedTargets).toBeNull();
  });

  it('reads phrases without inventing anything', () => {
    const at = new Date(now);
    const full = draftFromParse(
      parseIntent('bloquea las redes sociales hasta las 20:30', { now: at }),
      DEFAULT_PREFS,
    );
    expect(full?.end.kind).toBe('until');
    expect(full?.targets.categoryIds).toEqual(['social']);
    expect(
      draftFromParse(parseIntent('no veo YouTube mañana tarde', { now: at }), DEFAULT_PREFS),
    ).toBeNull();
    const seed = draftSeedFromParse(
      'no veo YouTube mañana tarde',
      parseIntent('no veo YouTube mañana tarde', { now: at }),
    );
    expect(seed.targets?.serviceIds).toEqual(['youtube']);
    expect(seed.end).toBeNull();
    const form = draftFromSeed(seed, DEFAULT_PREFS);
    expect(form.end).toEqual({ kind: 'duration', minutes: 60 });
    expect(form.mode).toBe(DEFAULT_PREFS.defaultMode);
  });

  it('turns every built-in template into a valid request', () => {
    for (const template of DEFAULT_TEMPLATES) {
      const d = draftFromTemplate(template, { ...DEFAULT_PREFS, defaultMode: 'strict' });
      expect(draftProblem(d, now)).toBeNull();
      expect(isCreateBlockRequest(draftToCreateRequest(d, now))).toBe(true);
    }
    const deberes = draftFromTemplate(DEFAULT_TEMPLATES[0]!, {
      ...DEFAULT_PREFS,
      defaultMode: 'strict',
    });
    expect(deberes.mode).toBe('strict');
  });

  it('reports what blocks sending', () => {
    expect(draftProblem(draft({ targets: emptyTargets() }), now)).toBe('no_targets');
    expect(draftProblem(draft({ end: { kind: 'duration', minutes: 4 } }), now)).toBe('too_short');
    expect(draftProblem(draft({ end: { kind: 'duration', minutes: 1441 } }), now)).toBe('too_long');
    expect(draftProblem(withMode(draft({ targets: emptyTargets() }), 'exam'), now)).toBeNull();
  });
});

describe('selectors', () => {
  it('bloqueoVariant: a pending create wins, then the card, then blocks', () => {
    const pending = harnessFixture('pending');
    expect(bloqueoVariant(pending.snapshot, initialMainLocal(), now)).toBe('pending');
    const confirm = harnessFixture('confirm-normal');
    const withOtherCard = {
      ...confirm.main,
      card: confirm.main.card && { ...confirm.main.card, intentId: 'another-intent' },
    };
    expect(bloqueoVariant(pending.snapshot, withOtherCard, now)).toBe('confirm');
    const finished = harnessFixture('finished');
    const typing = { ...initialMainLocal(), composer: { text: 'no veo', openWhileActive: false } };
    expect(bloqueoVariant(finished.snapshot, typing, now)).toBe('idle');
  });

  it('reconcileMainLocal closes the confirmed card in the same render', () => {
    const f = harnessFixture('pending');
    const intentId = f.main.card?.intentId ?? '';
    const done = {
      ...f.snapshot,
      ops: {
        ...f.snapshot.ops,
        create: null,
        lastCreated: { intentId, blockId: 'blk_fixture0000000099' as const },
      },
    };
    const next = reconcileMainLocal(done, f.main);
    expect(next.card).toBeNull();
    expect(next.composer.text).toBe('');
    expect(reconcileMainLocal(f.snapshot, f.main)).toBe(f.main);
  });

  it('maxExtendMinutes keeps the 24 h rule and hides extending punishments', () => {
    const f = harnessFixture('extend-undo');
    const block = f.snapshot.state?.blocks[0];
    expect(block).toBeDefined();
    if (!block) return;
    // 43 min left (rounded up) + 30 queued.
    expect(maxExtendMinutes(block, f.snapshot.ops, now)).toBe(1440 - 43 - 30);
    const punishment = makeBlock(
      {
        n: 50,
        kind: 'punishment',
        categories: ['social'],
        mode: 'strict',
        leftMs: MIN * 10,
        elapsedMs: MIN,
      },
      now,
    );
    expect(maxExtendMinutes(punishment, f.snapshot.ops, now)).toBe(0);
  });
});
