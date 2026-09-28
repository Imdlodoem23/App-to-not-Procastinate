import { describe, expect, it } from 'vitest';
import {
  HARNESS_NOW,
  fixtureUiState,
  harnessFixture,
  type HarnessStateId,
} from '../../../src/shared/fixtures';
import type { UiState } from '../../../src/shared/ui-state';
import {
  deriveEmergenciaView,
  localPreview,
  phraseStatus,
} from '../../../src/renderer/src/windows/emergencia/view';

const NOW = HARNESS_NOW;
const MIN = 60_000;
const PHRASE = 'Acepto romper mi compromiso y perder mis puntos';

function detailState(id: HarnessStateId): UiState {
  return fixtureUiState(harnessFixture(id), 'detail');
}

function withPhrase(state: UiState, phrase: string): UiState {
  return {
    ...state,
    detail: { ...state.detail, emergencia: { ...state.detail.emergencia, phrase } },
  };
}

describe('Emergencia: request', () => {
  it('prices the unlock and waits for the phrase (emergencia)', () => {
    const fixture = harnessFixture('emergencia');
    const view = deriveEmergenciaView(
      detailState('emergencia'),
      NOW,
      fixture.fake.emergencyPreview,
    );
    expect(view.stage).toBe('request');
    expect(view.source).toBe('guardian');
    expect(view.title).toBe('Emergencia: YouTube');
    expect(view.datum).toBe('espera de 10 min');
    expect(view.loss).toBe('Perderás 620 puntos y tu racha de 5 días');
    expect(view.rows).toEqual([
      {
        id: 'blk_fixture0000000021',
        label: 'YouTube · Normal',
        until: 'hasta las 17:42',
        tone: 'blue',
        fate: 'cancels',
        fateText: 'se cancela',
      },
    ]);
    expect(view.phrase).toMatchObject({ target: PHRASE, status: 'typing', tone: 'muted' });
    expect(view.request).toEqual({
      label: 'Empezar la espera de 10 min',
      blockIds: ['blk_fixture0000000021'],
      disabledReason: 'Primero escribe la frase exacta',
    });
  });

  it('computes the same price locally until the guardian answers', () => {
    const fixture = harnessFixture('emergencia');
    const state = fixture.snapshot.state;
    if (!state) throw new Error('fixture without state');
    expect(localPreview(state, null)).toEqual(fixture.fake.emergencyPreview);
    const local = deriveEmergenciaView(detailState('emergencia'), NOW, null);
    expect(local.source).toBe('local');
    expect(local.loss).toBe('Perderás 620 puntos y tu racha de 5 días');
  });

  it('enables the request once the phrase matches', () => {
    const state = withPhrase(
      detailState('emergencia'),
      `  acepto romper  mi compromiso y perder mis puntos. `,
    );
    const view = deriveEmergenciaView(state, NOW, null);
    expect(view.phrase).toMatchObject({ status: 'ok', help: 'Coincide', tone: 'green' });
    expect(view.request?.disabledReason).toBeNull();
  });

  it('waits 30 min for a strict block', () => {
    const view = deriveEmergenciaView(detailState('bloqueos'), NOW, null);
    expect(view.title).toBe('Emergencia: YouTube, Instagram');
    expect(view.datum).toBe('espera de 30 min');
  });

  it('lists what stays when hardcore blocks run beside it', () => {
    const view = deriveEmergenciaView(detailState('emergencia'), NOW, null);
    expect(view.rows.every((r) => r.fate === 'cancels')).toBe(true);
    const three = fixtureUiState(harnessFixture('three-blocks'), 'main');
    const mixed = deriveEmergenciaView(three, NOW, null);
    expect(mixed.title).toBe('Emergencia: 2 bloqueos');
    expect(mixed.datum).toBe('espera de 30 min');
    expect(mixed.rows.map((r) => [r.label, r.fateText])).toEqual([
      ['Redes sociales · Estricto', 'se cancela'],
      ['YouTube, Instagram · Estricto', 'se cancela'],
      ['Juegos · Hardcore', 'sigue activo'],
    ]);
  });
});

describe('Emergencia: phrase', () => {
  it('compares with the shared normalization', () => {
    expect(phraseStatus('')).toBe('empty');
    expect(phraseStatus('   ')).toBe('empty');
    expect(phraseStatus('Acepto romper')).toBe('typing');
    expect(phraseStatus('Acepto romper ')).toBe('typing');
    expect(phraseStatus('Acepto borrar')).toBe('mismatch');
    expect(phraseStatus(PHRASE)).toBe('ok');
    expect(phraseStatus(`${PHRASE.toUpperCase()}.`)).toBe('ok');
    expect(phraseStatus('I accept breaking my commitment and losing my points')).toBe('ok');
  });
});

describe('Emergencia: waiting and ready', () => {
  it('counts down in orange (emergency-waiting)', () => {
    const view = deriveEmergenciaView(detailState('emergency-waiting'), NOW, null);
    expect(view.stage).toBe('counting');
    expect(view.title).toBe('Emergencia: esperando');
    expect(view.datum).toBe('lista a las 17:08');
    expect(view.loss).toBe('Perderás 620 puntos y tu racha de 5 días');
    expect(view.emergency?.readyAtMs).toBe(NOW + 8 * MIN + 12_000);
    expect(view.emergency?.progress).toBeCloseTo(108 / 600, 5);
    expect(view.rows[0]?.fate).toBe('cancels');
    expect(view.phrase).toBeNull();
  });

  it('offers «Desbloquear» until the confirm window closes (emergency-ready)', () => {
    const fixture = harnessFixture('emergency-ready');
    expect(fixture.detail.armed?.id).toBe('emergency-unlock');
    const view = deriveEmergenciaView(detailState('emergency-ready'), NOW, null);
    expect(view.stage).toBe('ready');
    expect(view.title).toBe('Emergencia: lista');
    expect(view.datum).toBe('hasta las 17:04');
    expect(view.datumTone).toBe('orange');
    expect(view.emergency?.confirmByMs).toBe(NOW - 30_000 + 5 * MIN);
    expect(view.emergency?.progress).toBe(1);
  });
});

describe('Emergencia: unavailable and done', () => {
  it('says Hardcore cannot be cancelled, and until when', () => {
    const view = deriveEmergenciaView(
      fixtureUiState(harnessFixture('hardcore-block'), 'main'),
      NOW,
      null,
    );
    expect(view.stage).toBe('unavailable');
    expect(view.title).toBe('Emergencia: no disponible');
    expect(view.unavailable).toBe(
      'Hardcore: no se puede cancelar de ninguna forma hasta las 18:35',
    );
    expect(view.request).toBeNull();
  });

  it('says Examen cannot be cancelled either', () => {
    const base = fixtureUiState(harnessFixture('hardcore-block'), 'main');
    const state = base.snapshot.state;
    if (!state) throw new Error('fixture without state');
    const exam = state.blocks.map((b) => ({ ...b, mode: 'exam' as const }));
    const view = deriveEmergenciaView(
      { ...base, snapshot: { ...base.snapshot, state: { ...state, blocks: exam } } },
      NOW,
      null,
    );
    expect(view.unavailable).toMatch(/^Examen: no se puede cancelar de ninguna forma hasta las /);
  });

  it('has nothing to cancel without blocks', () => {
    const view = deriveEmergenciaView(fixtureUiState(harnessFixture('idle'), 'main'), NOW, null);
    expect(view.stage).toBe('unavailable');
    expect(view.unavailable).toBe('No hay ningún bloqueo que se pueda cancelar');
    const noGuardian = deriveEmergenciaView(
      fixtureUiState(harnessFixture('not-installed'), 'main'),
      NOW,
      null,
    );
    expect(noGuardian.stage).toBe('unavailable');
  });

  it('prefers the local estimate over a stale «in progress» preview', () => {
    const fixture = harnessFixture('emergencia');
    const stale = {
      ...fixture.fake.emergencyPreview,
      eligible: false,
      reason: 'emergency_in_progress' as const,
    };
    const view = deriveEmergenciaView(detailState('emergencia'), NOW, stale);
    expect(view.stage).toBe('request');
    expect(view.source).toBe('local');
  });

  it('shows what was charged once confirmed', () => {
    const base = detailState('emergencia');
    const state: UiState = {
      ...base,
      detail: {
        ...base.detail,
        emergencia: {
          ...base.detail.emergencia,
          result: {
            emergency: {
              id: 'emg_fixture0000000001',
              blockIds: ['blk_fixture0000000021'],
              status: 'confirmed',
              countdownMinutes: 10,
              requestedAt: new Date(NOW - 12 * MIN).toISOString(),
              readyAt: new Date(NOW - 2 * MIN).toISOString(),
              confirmBy: new Date(NOW + 3 * MIN).toISOString(),
              penaltyPreview: 620,
              streakDaysAtRisk: 5,
              resolvedAt: new Date(NOW).toISOString(),
              cancelReason: null,
            },
            penaltyApplied: 620,
            balanceAfter: 620,
            cancelledBlockIds: ['blk_fixture0000000021'],
            streakDaysLost: 5,
          },
        },
      },
    };
    const view = deriveEmergenciaView(state, NOW, null);
    expect(view.stage).toBe('done');
    expect(view.title).toBe('Emergencia: desbloqueado');
    expect(view.datum).toBe('−620 puntos');
    expect(view.done).toEqual({
      cancelled: 'Se ha cancelado 1 bloqueo',
      lost: 'Has perdido 620 puntos y tu racha de 5 días',
      balance: 'Saldo: 620 puntos',
    });
  });
});
