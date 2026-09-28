import {
  emergencyPreviewResponseSchema,
  healthResponseSchema,
  isCreateBlockRequest,
  listSchedulesResponseSchema,
  pairedExtensionsResponseSchema,
  pairingCodeResponseSchema,
  settingsResponseSchema,
  stateResponseSchema,
  validateResponse,
  type Schema,
} from '@centrate/shared/guardian-api';
import { parseIntent } from '@centrate/shared/parser';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_PRESETS,
  EXTRA_STATES,
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  PHASE1_REQUIRED_STATES,
  fixtureUiState,
  harnessFixture,
  harnessLoad,
  isHarnessStateId,
  layoutForDisplay,
  listHarnessFixtures,
  type HarnessStateId,
} from '../../src/shared/fixtures';
import { formatClock, formatRemaining, splitCountdown } from '../../src/shared/format';
import {
  bloqueoVariant,
  draftMinutes,
  draftNeedsConsequence,
  finishedNotice,
  isBootHold,
  primaryBlock,
  type BloqueoVariant,
} from '../../src/shared/ui-state';

function valid<T>(schema: Schema<T>, value: unknown): void {
  const result = validateResponse(schema, value);
  expect(result.ok ? null : result.issue).toBeNull();
}

const EXPECTED_VARIANT: Record<HarnessStateId, BloqueoVariant> = {
  idle: 'idle',
  typing: 'idle',
  'not-understood': 'idle',
  'confirm-normal': 'confirm',
  'confirm-over-4h': 'confirm',
  'confirm-hardcore': 'confirm',
  'confirm-exam': 'confirm',
  pending: 'pending',
  'guardian-timeout': 'failed',
  'one-block': 'active',
  'three-blocks': 'active',
  'extend-undo': 'active',
  finished: 'finished',
  'emergency-waiting': 'active',
  'emergency-ready': 'active',
  punishment: 'punishment',
  'negative-points': 'idle',
  'protection-broken': 'idle',
  'extension-missing': 'active',
  'compact-density': 'active',
  bloqueos: 'active',
  emergencia: 'active',
  ajustes: 'idle',
  'hardcore-block': 'active',
  'many-blocks': 'active',
  'boot-hold': 'boot-hold',
  'not-installed': 'idle',
  'bloqueos-prefilled': 'idle',
  'ajustes-pairing': 'idle',
  'ajustes-delete': 'idle',
};

describe('harness registry', () => {
  it('covers every Phase 1 state once', () => {
    expect(new Set(HARNESS_STATE_IDS).size).toBe(HARNESS_STATE_IDS.length);
    for (const id of PHASE1_REQUIRED_STATES) expect(HARNESS_STATE_IDS).toContain(id);
    for (const id of EXTRA_STATES) expect(PHASE1_REQUIRED_STATES).not.toContain(id);
    expect(isHarnessStateId('idle')).toBe(true);
    expect(isHarnessStateId('nope')).toBe(false);
  });

  it('builds deterministic, serialisable fixtures', () => {
    const a = listHarnessFixtures();
    const b = listHarnessFixtures();
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a.map((f) => f.id)).toEqual([...HARNESS_STATE_IDS]);
  });
});

describe.each(HARNESS_STATE_IDS.map((id) => [id]))('fixture %s', (id) => {
  const f = harnessFixture(id);

  it('matches the guardian contract', () => {
    if (f.snapshot.state) valid(stateResponseSchema, f.snapshot.state);
    if (f.snapshot.health) valid(healthResponseSchema, f.snapshot.health);
    valid(healthResponseSchema, f.fake.health);
    valid(settingsResponseSchema, f.fake.settings);
    valid(listSchedulesResponseSchema, { schedules: f.fake.schedules });
    valid(emergencyPreviewResponseSchema, f.fake.emergencyPreview);
    valid(pairingCodeResponseSchema, f.fake.pairingCode);
    valid(pairedExtensionsResponseSchema, { extensions: f.fake.extensions });
    if (f.detail.ajustes.pairing) valid(pairingCodeResponseSchema, f.detail.ajustes.pairing);
    const create = f.snapshot.ops.create;
    if (create) expect(isCreateBlockRequest(create.request)).toBe(true);
  });

  it('shows the expected Bloqueo variant', () => {
    expect(f.expect.variant).toBe(EXPECTED_VARIANT[id]);
    expect(bloqueoVariant(f.snapshot, f.main, f.nowMs)).toBe(EXPECTED_VARIANT[id]);
  });

  it('is consistent with its window and harness clock', () => {
    expect(f.id).toBe(id);
    expect(f.nowMs).toBe(HARNESS_NOW);
    expect(f.snapshot.harness).toEqual({ stateId: id, frozenNowMs: HARNESS_NOW });
    if (f.window === 'main') {
      expect(f.detailRequest).toBeNull();
    } else {
      expect(f.detailRequest?.name).toBe(f.window);
      expect(fixtureUiState(f).env.window).toBe('detail');
      expect(fixtureUiState(f, 'main').env.detail).toBeNull();
    }
    expect(harnessLoad(f)).toEqual({ stateId: id, main: f.main, detail: f.detail });
  });
});

describe('fixture content', () => {
  it('one-block reads like the brief (hasta 17:42, 42:10, quedan 43 min)', () => {
    const f = harnessFixture('one-block');
    const block = primaryBlock(f.snapshot.state);
    expect(block).not.toBeNull();
    const endsAt = Date.parse(block?.endsAt ?? '');
    expect(formatClock(endsAt)).toBe('17:42');
    expect(splitCountdown(endsAt - f.nowMs).text).toBe('42:10');
    expect(formatRemaining(endsAt - f.nowMs)).toBe('quedan 43 min');
    expect(block?.mode).toBe('strict');
  });

  it('typing and not-understood use phrases the parser reads as described', () => {
    const now = new Date(HARNESS_NOW);
    const typing = parseIntent(harnessFixture('typing').main.composer.text, { now });
    expect(typing.complete).toBe(true);
    expect(typing.serviceIds).toEqual(['youtube']);
    const unknown = parseIntent(harnessFixture('not-understood').main.composer.text, { now });
    expect(unknown.complete).toBe(false);
    expect(unknown.unparsed).toEqual(['mañana tarde']);
  });

  it('confirmation fixtures need the consequence step exactly when the brief says', () => {
    const normal = harnessFixture('confirm-normal').main.card;
    expect(normal && draftNeedsConsequence(normal.draft, HARNESS_NOW)).toBe(false);
    for (const id of ['confirm-over-4h', 'confirm-hardcore', 'confirm-exam'] as const) {
      const card = harnessFixture(id).main.card;
      expect(card?.step).toBe('consequence');
      expect(card && draftNeedsConsequence(card.draft, HARNESS_NOW)).toBe(true);
    }
    const long = harnessFixture('confirm-over-4h').main.card;
    expect(long && draftMinutes(long.draft, HARNESS_NOW)).toBe(360);
    const exam = harnessFixture('confirm-exam').main.card;
    expect(exam?.draft.whitelistOnly).toBe(true);
    expect(exam?.draft.mode).toBe('exam');
  });

  it('extend-undo waits 5 s before sending', () => {
    const f = harnessFixture('extend-undo');
    const [entry] = f.snapshot.ops.extendQueue;
    expect(entry?.status).toBe('waiting');
    expect((entry?.commitAt ?? 0) - (entry?.createdAt ?? 0)).toBe(5_000);
    expect(formatClock(Date.parse(entry?.projectedEndsAt ?? ''))).toBe('18:12');
  });

  it('finished shows «Hecho. +80 puntos»', () => {
    const f = harnessFixture('finished');
    expect(finishedNotice(f.snapshot.state, f.nowMs)?.pointsDelta).toBe(80);
    expect(finishedNotice(f.snapshot.state, f.nowMs + 60_000)).toBeNull();
  });

  it('emergency fixtures price the unlock like the brief (620 puntos, 5 días, 8:12)', () => {
    const waiting = harnessFixture('emergency-waiting');
    const emergency = waiting.snapshot.state?.emergency;
    expect(emergency?.status).toBe('counting');
    expect(emergency?.penaltyPreview).toBe(620);
    expect(emergency?.streakDaysAtRisk).toBe(5);
    expect(splitCountdown(Date.parse(emergency?.readyAt ?? '') - waiting.nowMs).text).toBe('8:12');
    expect(harnessFixture('emergency-ready').snapshot.state?.emergency?.status).toBe('ready');
    expect(harnessFixture('emergencia').fake.emergencyPreview.penaltyPoints).toBe(620);
  });

  it('punishment, negative points, protection and boot hold', () => {
    const punishment = harnessFixture('punishment').snapshot.state;
    expect(punishment?.punishments[0]?.task).toBe('mates');
    expect(punishment?.blocks[0]?.kind).toBe('punishment');
    expect(harnessFixture('negative-points').snapshot.state?.points.balance).toBeLessThan(0);
    expect(harnessFixture('protection-broken').snapshot.link.status).toBe('down');
    expect(harnessFixture('protection-broken').expect.warning).toBe('guardian');
    expect(harnessFixture('extension-missing').expect.warning).toBe('extension');
    const boot = harnessFixture('boot-hold');
    expect(isBootHold(boot.snapshot.state, boot.nowMs)).toBe(true);
    expect(harnessFixture('many-blocks').snapshot.state?.blocks).toHaveLength(6);
  });

  it('compact-density runs on the small display', () => {
    const f = harnessFixture('compact-density');
    expect(f.display).toBe('1366x768@125');
    expect(f.expect.density).toBe('compact');
    expect(fixtureUiState(f).env.layout.maxContentHeight).toBeLessThan(540);
  });
});

describe('display presets', () => {
  it('have a 48 DIP taskbar and a budget that respects the 10 px inset', () => {
    for (const preset of Object.values(DISPLAY_PRESETS)) {
      expect(preset.bounds.height - preset.workArea.height).toBe(48);
      const layout = layoutForDisplay(preset);
      expect(layout.anchor).toBe('bottom');
      expect(layout.maxContentHeight).toBe(
        preset.workArea.height - 20 - preset.frame.top - preset.frame.bottom,
      );
    }
    expect(DISPLAY_PRESETS['1366x768@125'].workArea).toEqual({
      x: 0,
      y: 0,
      width: 1093,
      height: 566,
    });
  });
});
