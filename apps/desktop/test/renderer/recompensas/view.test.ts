import { describe, expect, it } from 'vitest';
import type { RewardAllowance, RewardsLockReason } from '@centrate/shared/domain';
import type { RedeemRewardResponse, RewardsResponse } from '@centrate/shared/guardian-api';
import {
  HARNESS_NOW,
  harnessFixture,
  makeRewards,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import { uiError } from '../../../src/shared/ui-state';
import {
  MASCOT_SIZE,
  RWD_IDS,
  activeAllowances,
  coveredServices,
  deriveRecompensasView,
  loadErrorText,
  offerLabelId,
  redeemArmId,
  redeemErrorText,
  type RecompensasInput,
  type RecompensasView,
} from '../../../src/renderer/src/windows/recompensas/view';
import { RECOMPENSAS_ES } from '../../../src/renderer/src/windows/recompensas/i18n/es';

const now = HARNESS_NOW;
const MIN = 60_000;

function input(id: HarnessStateId, patch: Partial<RecompensasInput> = {}): RecompensasInput {
  const fixture = harnessFixture(id);
  return {
    snapshot: fixture.snapshot,
    rewards: fixture.fake.rewards,
    redeemed: null,
    notice: null,
    nowMs: now,
    ...patch,
  };
}

function view(id: HarnessStateId, patch: Partial<RecompensasInput> = {}): RecompensasView {
  return deriveRecompensasView(input(id, patch));
}

function allowance(
  serviceId: string,
  endsAt: number,
  id = 'alw_test000000000001',
): RewardAllowance {
  return {
    id: id as RewardAllowance['id'],
    offerId: `${serviceId}-15`,
    serviceId,
    minutes: 15,
    cost: 150,
    startedAt: new Date(endsAt - 15 * MIN).toISOString() as RewardAllowance['startedAt'],
    endsAt: new Date(endsAt).toISOString() as RewardAllowance['endsAt'],
    status: 'active',
    endedAt: null,
    refund: 0,
  };
}

describe('Recompensas: the shop', () => {
  it('lists «15 min de YouTube · 150 pts · Canjear» for what the blocks cover', () => {
    const v = view('rewards');
    expect(v.title).toBe('Recompensas: 1.240 puntos');
    expect(v.titleTone).toBe('default');
    expect(v.pill).toBeNull();
    expect(v.locked).toBeNull();
    expect(v.rows.map((r) => [r.id, r.label, r.price, r.disabledReason])).toEqual([
      ['youtube-15', '15 min de YouTube', '150 pts', null],
      ['youtube-30', '30 min de YouTube', '280 pts', null],
      ['instagram-15', '15 min de Instagram', '150 pts', null],
    ]);
    expect(v.rows[0]).toMatchObject({
      help: 'YouTube 15 min sin penalización · te quedarán 1.090 puntos',
      consequence: '−150 puntos: YouTube abierto hasta las 17:15',
      mnemonic: '1',
      monogram: 'YT',
    });
    expect(v.hidden).toBe(
      'TikTok, Twitch, Netflix, Discord y Roblox no están bloqueados ahora: no hace falta canjearlos',
    );
    expect(v.help).toEqual({ tone: 'muted', text: RECOMPENSAS_ES.shop.rowHelp });
    expect(v.empty).toBe(false);
  });

  it('disables «Canjear» with the reason: «Te faltan 40 puntos»', () => {
    const v = view('rewards-short-points');
    expect(v.title).toBe('Recompensas: 110 puntos');
    expect(v.rows.map((r) => [r.id, r.disabledReason, r.short])).toEqual([
      ['youtube-15', 'Te faltan 40 puntos', true],
      ['youtube-30', 'Te faltan 170 puntos', true],
      ['instagram-15', 'Te faltan 40 puntos', true],
    ]);
    expect(v.help).toEqual({
      tone: 'muted',
      text: 'Aún no te llega: cada minuto de bloqueo cumplido suma 1 punto',
    });
  });

  it('keeps the in-place «¿Seguro?» id per offer and gives every row its Alt + number', () => {
    expect(redeemArmId('youtube-15')).toBe('redeem:youtube-15');
    // Each row's group is named by its offer (a unique, valid DOM id per offer).
    expect(offerLabelId('youtube-15')).toBe('rwd-offer-youtube-15');
    expect(offerLabelId('a b:c')).toBe('rwd-offer-a_b_c');
    const rows = view('punishment').rows;
    expect(rows.map((r) => r.mnemonic)).toEqual(rows.map((_, i) => String(i + 1)));
    expect(RWD_IDS.row).toBe(harnessFixture('rewards-short-points').detail.help?.row);
    expect(MASCOT_SIZE).toBeGreaterThanOrEqual(96);
    expect(MASCOT_SIZE).toBeLessThanOrEqual(160);
  });

  it('is closed during Hardcore, Examen, a punishment, Study Mode or an emergency, and says why', () => {
    const v = view('punishment');
    expect(v.title).toBe('Recompensas: cerradas');
    expect(v.datum).toBe('1.095 puntos');
    expect(v.locked).toBe('Durante un castigo no se canjea nada');
    expect(v.help).toEqual({ tone: 'orange', text: 'Durante un castigo no se canjea nada' });
    expect(v.rows.length).toBeGreaterThan(0);
    expect(v.rows.every((r) => r.disabledReason === v.locked)).toBe(true);

    const base = input('rewards');
    const reasons: RewardsLockReason[] = ['hardcore', 'exam', 'punishment', 'study', 'emergency'];
    for (const reason of reasons) {
      const rewards = makeRewards(1240, ['youtube', 'instagram'], reason);
      const locked = deriveRecompensasView({ ...base, rewards });
      expect(locked.locked).toBe(RECOMPENSAS_ES.locked[reason]);
      // While closed, the offers of what the blocks cover stay listed, disabled.
      expect(locked.rows.map((r) => [r.id, r.disabledReason])).toEqual([
        ['youtube-15', RECOMPENSAS_ES.locked[reason]],
        ['youtube-30', RECOMPENSAS_ES.locked[reason]],
        ['instagram-15', RECOMPENSAS_ES.locked[reason]],
      ]);
    }
  });

  it('reads the lock from the last poll until the shop answers', () => {
    const base = input('punishment', { rewards: null });
    const v = deriveRecompensasView(base);
    expect(v.title).toBe('Recompensas: cerradas');
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe(false);
  });

  it('shows «Números rojos» in the red', () => {
    const base = input('negative-points');
    const rewards = makeRewards(-340, ['youtube']);
    const v = deriveRecompensasView({ ...base, rewards });
    expect(v).toMatchObject({
      title: 'Recompensas: −340 puntos',
      titleTone: 'red',
      pill: 'Números rojos',
    });
    expect(v.rows[0]?.disabledReason).toBe('Te faltan 490 puntos');
  });

  it('points to Bloqueos when nothing is blocked', () => {
    const base = input('idle');
    const v = deriveRecompensasView({ ...base, rewards: makeRewards(1240, []) });
    expect(v.empty).toBe(true);
    expect(v.rows).toEqual([]);
  });

  it('says the redemption in green and counts the open break in the datum', () => {
    const endsAt = now + 15 * MIN;
    const redeemed: RedeemRewardResponse = {
      allowance: allowance('youtube', endsAt),
      pointsDelta: -150,
      balanceAfter: 1090,
    };
    const v = view('rewards', { redeemed });
    expect(v.title).toBe('Recompensas: 1.090 puntos');
    expect(v.result).toEqual({
      tone: 'green',
      text: 'Canjeado: YouTube abierto hasta las 17:15 · te quedan 1.090 puntos',
    });
    expect(v.help).toEqual({ tone: 'muted', text: RECOMPENSAS_ES.shop.rowHelp });
    expect(v.datum).toBe('YouTube hasta las 17:15');
    // Redeeming YouTube again adds to that break.
    expect(v.rows[0]?.help).toBe('Suma 15 min a YouTube · te quedarán 940 puntos');
    expect(v.rows[0]?.consequence).toBe('−150 puntos: YouTube abierto hasta las 17:30');

    const two = view('rewards', {
      redeemed,
      rewards: {
        ...(harnessFixture('rewards').fake.rewards as RewardsResponse),
        allowances: [allowance('instagram', now + 5 * MIN, 'alw_test000000000002')],
      },
    });
    expect(two.datum).toBe('2 descansos abiertos');
  });

  it('forgets breaks that already ended', () => {
    const ended = allowance('youtube', now - MIN);
    expect(
      activeAllowances({
        ...input('rewards'),
        redeemed: { allowance: ended, pointsDelta: -150, balanceAfter: 1090 },
      }),
    ).toEqual([]);
  });

  it('puts the refusal of the last redeem on the result line', () => {
    const notice = { tone: 'red' as const, text: 'Te faltan 40 puntos' };
    expect(view('rewards', { notice }).result).toBe(notice);
    expect(view('rewards').result).toBeNull();
  });

  it('shows the mascot in large with its phase and what makes it grow', () => {
    expect(view('rewards').mascot).toEqual({
      stage: 'plant',
      name: 'Tu planta',
      text: '18 min más hoy y será un árbol',
    });
    const wilted = view('negative-points', { rewards: makeRewards(-340, []) }).mascot;
    expect(wilted).toEqual({
      stage: 'wilted',
      name: 'Tu planta, marchita',
      text: 'Se marchitó al rendirte: vuelve a crecer con 25 min concentrado',
    });
    expect(view('not-installed', { rewards: null }).mascot).toBeNull();
  });
});

describe('Recompensas: covered services and errors', () => {
  it('knows what the blocks cover (services, categories, whitelist-only)', () => {
    const covered = coveredServices(harnessFixture('rewards').snapshot.state);
    expect(covered).not.toBe('all');
    if (covered !== 'all') expect([...covered].sort()).toEqual(['instagram', 'youtube']);
    expect(coveredServices(null)).toEqual(new Set());
    const exam = harnessFixture('confirm-exam').snapshot.state;
    expect(coveredServices(exam)).toBeInstanceOf(Set);
  });

  it('words the guardian refusals', () => {
    const offer = harnessFixture('rewards').fake.rewards.offers[0] ?? null;
    const err = (code: string, details?: Record<string, unknown>) =>
      redeemErrorText(uiError('rejected', code, 409, details), offer);
    expect(err('insufficient_points', { shortBy: 40 })).toBe('Te faltan 40 puntos');
    expect(err('rewards_locked', { reason: 'exam' })).toBe('Durante un examen no se canjea nada');
    expect(err('rewards_locked', { reason: 'later' })).toBe('Ahora mismo no se canjea nada');
    expect(err('service_not_blocked')).toBe(
      'YouTube ya no está bloqueado: no hace falta canjearlo',
    );
    expect(err('allowance_limit_reached')).toBe('Como mucho 1 h de YouTube a la vez');
    expect(err('unknown_offer')).toBe('Esa recompensa ya no existe: actualiza Céntrate');
    expect(redeemErrorText(uiError('timeout'), offer)).toBe('El guardián no responde');
    expect(loadErrorText(uiError('internal', 'not_implemented', 501))).toBe(
      'No he podido leer la tienda',
    );
    expect(loadErrorText(uiError('unreachable'))).toBe('El guardián no responde');
  });
});

describe('Recompensas in English', () => {
  it('reads the shop, the shortfall and the lock', () => {
    withLocale('en', () => {
      const v = view('rewards-short-points');
      expect(v.title).toBe('Rewards: 110 points');
      expect(v.rows[0]).toMatchObject({
        label: '15 min of YouTube',
        disabledReason: 'You are 40 points short',
      });
      expect(view('punishment').locked).toBe('Nothing can be redeemed during a punishment');
    });
  });
});
