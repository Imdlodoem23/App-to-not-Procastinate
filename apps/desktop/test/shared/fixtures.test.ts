import {
  emergencyPreviewResponseSchema,
  healthResponseSchema,
  isCreateBlockRequest,
  isScheduleInput,
  isSettingsRequest,
  listSchedulesResponseSchema,
  pairedExtensionsResponseSchema,
  pairingCodeResponseSchema,
  rewardsResponseSchema,
  settingsResponseSchema,
  stateResponseSchema,
  validateResponse,
  type Schema,
} from '@centrate/shared/guardian-api';
import { ACHIEVEMENTS, isLocalDay } from '@centrate/shared/points';
import { parseIntent } from '@centrate/shared/parser';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_PRESETS,
  EXTRA_STATES,
  HARNESS_NOW,
  HARNESS_STATE_IDS,
  PHASE1_REQUIRED_STATES,
  PHASE5_STATES,
  fixtureInLocale,
  fixtureSurface,
  fixtureUiState,
  fixtureWindowKind,
  harnessFixture,
  harnessLoad,
  isHarnessStateId,
  layoutForDisplay,
  listHarnessFixtures,
  type HarnessStateId,
} from '../../src/shared/fixtures';
import { formatClock, formatRemaining, splitCountdown } from '../../src/shared/format';
import { PHASE5_INVOKE_GUARDS } from '../../src/shared/ipc-payloads';
import { phase5InvokeStubs } from '../../src/shared/phase5-stubs';
import { statsPeriod } from '../../src/shared/stats';
import {
  bloqueoVariant,
  draftMinutes,
  draftNeedsConsequence,
  finishedNotice,
  isBootHold,
  isDetailName,
  isSurfaceKind,
  nuclearEndsAt,
  nuclearPunishment,
  onboardingActive,
  onboardingStepStatus,
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
  'stats-empty': 'idle',
  'stats-week': 'idle',
  rewards: 'active',
  'rewards-short-points': 'active',
  logros: 'idle',
  'onboarding-1': 'idle',
  'onboarding-2': 'idle',
  'onboarding-3': 'idle',
  'onboarding-4': 'idle',
  'onboarding-5': 'idle',
  'mini-timer': 'active',
  osd: 'active',
  nuclear: 'punishment',
  'ajustes-full': 'active',
  schedules: 'idle',
  'exam-whitelist': 'idle',
  'update-available': 'idle',
};

describe('harness registry', () => {
  it('covers every Phase 1 and Phase 5 state once', () => {
    expect(new Set(HARNESS_STATE_IDS).size).toBe(HARNESS_STATE_IDS.length);
    for (const id of PHASE1_REQUIRED_STATES) expect(HARNESS_STATE_IDS).toContain(id);
    for (const id of PHASE5_STATES) expect(HARNESS_STATE_IDS).toContain(id);
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
    valid(rewardsResponseSchema, f.fake.rewards);
    expect(isSettingsRequest(f.fake.settings.settings)).toBe(true);
    if (f.detail.ajustes.pairing) valid(pairingCodeResponseSchema, f.detail.ajustes.pairing);
    if (f.main.onboarding.pairing) valid(pairingCodeResponseSchema, f.main.onboarding.pairing);
    const schedule = f.detail.bloqueos.schedule;
    if (schedule) expect(isScheduleInput(schedule.input)).toBe(true);
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
    if (f.window === 'main' || isSurfaceKind(f.window)) {
      expect(f.detailRequest).toBeNull();
      expect(fixtureUiState(f).env.window).toBe(f.window);
      expect(fixtureWindowKind(f)).toBe(f.window);
      expect(fixtureSurface(f)).toBe(isSurfaceKind(f.window) ? f.window : null);
    } else {
      expect(isDetailName(f.window)).toBe(true);
      expect(f.detailRequest?.name).toBe(f.window);
      expect(fixtureUiState(f).env.window).toBe('detail');
      expect(fixtureUiState(f, 'main').env.detail).toBeNull();
    }
    // Only the onboarding fixtures show it (the rest are past the first run).
    expect(onboardingActive(f.snapshot)).toBe(id.startsWith('onboarding-'));
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

describe('Phase 5 fixtures', () => {
  it('answer every Phase 5 read from the fixture, with payloads their guards accept', () => {
    for (const id of PHASE5_STATES) {
      const f = harnessFixture(id);
      const stubs = phase5InvokeStubs(
        () => f,
        () => f.nowMs,
      );
      expect(stubs['rewards:list'](null)).toEqual({ ok: true, value: f.fake.rewards });
      expect(stubs['settings:get'](null)).toEqual({ ok: true, value: f.fake.settings });
      const put = { settings: f.fake.settings.settings };
      expect(PHASE5_INVOKE_GUARDS['settings:put'](put)).toBe(true);
      const week = stubs['stats:overview']({ range: 'week', anchor: null });
      expect(week.ok && week.value.buckets).toHaveLength(7);
    }
  });

  it('stats-week shows a full past week; stats-empty the empty state', () => {
    const week = harnessFixture('stats-week');
    const anchor = week.detail.estadisticas.anchor;
    expect(anchor !== null && isLocalDay(anchor)).toBe(true);
    const overview = week.local.stats.overview.week;
    expect({ from: overview.from, to: overview.to }).toEqual(statsPeriod('week', anchor ?? ''));
    expect(overview.empty).toBe(false);
    expect(overview.totals.blockMinutes).toBeGreaterThan(0);
    expect(overview.topTargets.length).toBeGreaterThan(0);
    expect(overview.hours).toHaveLength(24);
    expect(week.local.stats.overview.month.buckets).toHaveLength(30);
    expect(week.local.stats.overview.day.buckets).toHaveLength(24);
    const heat = week.local.stats.heatmap;
    expect(heat.cells.at(-1)?.day).toBe('2026-09-28');
    expect(heat.cells.every((c) => c.level >= 0 && c.level <= 4)).toBe(true);
    const empty = harnessFixture('stats-empty');
    for (const range of ['day', 'week', 'month'] as const) {
      expect(empty.local.stats.overview[range].empty).toBe(true);
      expect(empty.local.stats.overview[range].totals.attempts).toBe(0);
    }
    expect(empty.local.stats.events.entries).toEqual([]);
  });

  it('rewards: affordable offers of blocked services; «Te faltan 40 puntos» when short', () => {
    const rich = harnessFixture('rewards').fake.rewards;
    expect(rich.offers.find((o) => o.offerId === 'youtube-15')).toMatchObject({
      available: true,
      shortBy: 0,
    });
    expect(rich.offers.find((o) => o.offerId === 'netflix-45')?.unavailableReason).toBe(
      'not_blocked',
    );
    const short = harnessFixture('rewards-short-points');
    const offer = short.fake.rewards.offers.find((o) => o.offerId === 'youtube-15');
    expect(offer).toMatchObject({ available: false, shortBy: 40 });
    const stub = phase5InvokeStubs(
      () => short,
      () => short.nowMs,
    )['rewards:redeem'];
    const redeem = stub({ intentId: 'i-1', offerId: 'youtube-15' });
    expect(redeem.ok ? null : redeem.error.code).toBe('insufficient_points');
  });

  it('logros lists every achievement; onboarding walks the five steps', () => {
    const logros = harnessFixture('logros');
    expect(logros.local.achievements.map((a) => a.id)).toEqual(ACHIEVEMENTS.map((a) => a.id));
    expect(logros.snapshot.progress).toMatchObject({ achieved: 3, total: 8 });
    const steps = [1, 2, 3, 4, 5].map((n) => {
      const f = harnessFixture(`onboarding-${n}` as HarnessStateId);
      return f.snapshot.prefs.onboarding.step;
    });
    expect(steps).toEqual(['welcome', 'guardian', 'extension', 'camera', 'first-block']);
    const guardian = harnessFixture('onboarding-2');
    expect(onboardingStepStatus(guardian.snapshot, 'guardian')).toBe('todo');
    const extension = harnessFixture('onboarding-3');
    expect(onboardingStepStatus(extension.snapshot, 'extension')).toBe('todo');
    expect(extension.main.onboarding.pairing?.code).toBe('482913');
    expect(onboardingStepStatus(harnessFixture('onboarding-4').snapshot, 'camera')).toBe(
      'unavailable',
    );
    expect(harnessFixture('onboarding-5').main.composer.text).toBe('no veo YouTube en 25 minutos');
    expect(fixtureInLocale(harnessFixture('onboarding-5'), 'en').main.composer.text).toBe(
      'no YouTube for 25 minutes',
    );
  });

  it('surfaces: mini timer, OSD and Nuclear («vuelves a las 18:40»)', () => {
    expect(harnessFixture('mini-timer').snapshot.prefs.miniTimer.visible).toBe(true);
    const osd = harnessFixture('osd');
    expect(osd.snapshot.osd?.text).toBe('+15 min · hasta las 17:57');
    expect(fixtureInLocale(osd, 'en').snapshot.osd?.text).toBe('+15 min · until 5:57 PM');
    const nuclear = harnessFixture('nuclear');
    expect(nuclearPunishment(nuclear.snapshot.state)?.level).toBe('nuclear');
    expect(formatClock(Date.parse(nuclearEndsAt(nuclear.snapshot.state) ?? ''))).toBe('18:40');
    expect(nuclear.snapshot.nuclear.overlay).toBe('shown');
    expect(nuclearPunishment(harnessFixture('punishment').snapshot.state)).toBeNull();
  });

  it('Ajustes and Bloqueos show pending weakening changes and the editors', () => {
    const ajustes = harnessFixture('ajustes-full');
    expect(ajustes.fake.settings.pending.map((p) => p.field)).toEqual([
      'dailyGoalMinutes',
      'attemptPenalties',
    ]);
    expect(ajustes.snapshot.updater.status).toBe('available');
    expect(ajustes.snapshot.shortcuts.failed).toEqual(['extend-15']);
    const exam = harnessFixture('exam-whitelist');
    expect(exam.detailRequest).toEqual({ name: 'bloqueos', seed: null, focus: 'exam' });
    expect(exam.fake.settings.pending[0]?.field).toBe('studyWhitelist.extraDomains');
    expect(harnessFixture('schedules').detail.bloqueos.schedule?.id).toBeNull();
    const update = harnessFixture('update-available').snapshot;
    expect(update.app.updateVersion).toBe('0.2.0');
    expect(update.updater.status).toBe('ready');
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
