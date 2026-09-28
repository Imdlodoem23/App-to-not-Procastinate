import { describe, expect, it } from 'vitest';
import {
  HARNESS_STATE_IDS,
  harnessFixture,
  makeExtensionStatus,
  makeGuardianState,
  makeBlock,
  HARNESS_NOW,
} from '../../../src/shared/fixtures';
import { resolveFeatures } from '../../../src/shared/features';
import { uiError, type UiError, type UiSnapshot } from '../../../src/shared/ui-state';
import { errorActionLabel, errorCopy } from '../../../src/renderer/src/i18n/errors';
import {
  browsersLabel,
  deriveProtectionView,
  guideFor,
} from '../../../src/renderer/src/sections/protection/view';
import { deriveProgresoView, mascotPhase } from '../../../src/renderer/src/sections/progreso/view';
import { deriveFooterView } from '../../../src/renderer/src/sections/footer/view';

const now = HARNESS_NOW;

function snapshotOf(id: (typeof HARNESS_STATE_IDS)[number]): UiSnapshot {
  return harnessFixture(id).snapshot;
}

function withState(
  base: UiSnapshot,
  patch: (s: NonNullable<UiSnapshot['state']>) => NonNullable<UiSnapshot['state']>,
): UiSnapshot {
  if (!base.state) throw new Error('fixture without state');
  return { ...base, state: patch(base.state) };
}

describe('section 1 «Aviso de protección»', () => {
  it.each(HARNESS_STATE_IDS)('matches the fixture expectation (%s)', (id) => {
    const fixture = harnessFixture(id);
    expect(deriveProtectionView(fixture.snapshot)?.kind ?? null).toBe(fixture.expect.warning);
  });

  it('reads «Guardián detenido» with Reparar | Detalles… when the guardian stops', () => {
    const view = deriveProtectionView(snapshotOf('protection-broken'));
    expect(view).toMatchObject({
      tone: 'red',
      title: 'Guardián detenido: ahora mismo no se bloquea nada',
    });
    expect(view?.actions.map((a) => [a.id, a.label, a.door])).toEqual([
      ['repair', 'Reparar', false],
      ['details', 'Detalles…', true],
    ]);
  });

  it('offers «Instalar…» when the guardian is not installed', () => {
    const view = deriveProtectionView(snapshotOf('not-installed'));
    expect(view?.title).toBe('Guardián no instalado: ahora mismo no se bloquea nada');
    expect(view?.actions.map((a) => a.id)).toEqual(['install-guardian']);
  });

  it('asks to update an outdated guardian', () => {
    const base = snapshotOf('idle');
    for (const reason of ['unauthorized', 'incompatible'] as const) {
      const view = deriveProtectionView({
        ...base,
        link: { ...base.link, status: 'down', reason },
      });
      expect(view?.title).toBe('Actualiza el guardián');
      expect(view?.actions.map((a) => a.id)).toEqual(['repair']);
    }
  });

  it('warns about safe mode and about layers that fail during a block', () => {
    const safe = withState(snapshotOf('idle'), (s) => ({
      ...s,
      guardian: { ...s.guardian, mode: 'safe' },
    }));
    expect(deriveProtectionView(safe)?.title).toBe(
      'Guardián en modo seguro: no se pueden crear bloqueos',
    );
    const hostsBroken = withState(snapshotOf('one-block'), (s) => ({
      ...s,
      protection: { ...s.protection, hosts: { ...s.protection.hosts, ok: false } },
    }));
    expect(deriveProtectionView(hostsBroken)?.title).toBe(
      'El bloqueo no se está aplicando del todo',
    );
    // Without a block, a hosts problem is not a warning.
    const idleHosts = withState(snapshotOf('idle'), (s) => ({
      ...s,
      protection: { ...s.protection, processWatcher: { ok: false } },
    }));
    expect(deriveProtectionView(idleHosts)).toBeNull();
  });

  it('names the browsers without the extension, orange, only during a block', () => {
    const view = deriveProtectionView(snapshotOf('extension-missing'));
    expect(view).toMatchObject({
      kind: 'extension',
      tone: 'orange',
      title: 'Chrome no tiene la extensión: ahí el bloqueo puede tardar',
    });
    expect(view?.actions[0]?.guide).toBe('extension-chromium');
    const two = withState(snapshotOf('extension-missing'), (s) => ({
      ...s,
      protection: { ...s.protection, browsersWithoutExtension: ['firefox', 'edge'] },
    }));
    expect(deriveProtectionView(two)?.title).toBe(
      'Firefox y Edge no tienen la extensión: ahí el bloqueo puede tardar',
    );
    expect(deriveProtectionView(two)?.actions[0]?.guide).toBe('extension-firefox');
    const idle = withState(snapshotOf('idle'), (s) => ({
      ...s,
      protection: { ...s.protection, browsersWithoutExtension: ['chrome'] },
    }));
    expect(deriveProtectionView(idle)).toBeNull();
  });

  it('shows red before orange', () => {
    const both = withState(snapshotOf('extension-missing'), (s) => ({
      ...s,
      protection: { ...s.protection, processWatcher: { ok: false } },
    }));
    expect(deriveProtectionView(both)?.tone).toBe('red');
  });

  it('lists browsers in Spanish', () => {
    expect(browsersLabel(['chrome'])).toBe('Chrome');
    expect(browsersLabel(['chrome', 'edge', 'brave', 'chrome'])).toBe('Chrome, Edge y Brave');
    expect(browsersLabel([])).toBe('Otro navegador');
    expect(guideFor(['brave'])).toBe('extension-chromium');
  });
});

describe('section 4 «Progreso»', () => {
  it('reads level, points, streak and the daily goal', () => {
    expect(deriveProgresoView(snapshotOf('idle'))).toEqual({
      phase: 'tree',
      title: 'Nivel 7 · 1.240 puntos',
      negative: false,
      pill: null,
      streak: 'Racha: 5 días',
      goal: {
        label: 'Hoy: 42 de 60 min',
        value: 0.7,
        met: false,
        aria: 'Objetivo de hoy: 42 de 60 minutos concentrado',
      },
      doors: [],
    });
  });

  it('shows each door only with its flag (and the guardian capability)', () => {
    const base = snapshotOf('idle');
    const all = resolveFeatures({ stats: true, rewards: true, achievements: true });
    expect(deriveProgresoView({ ...base, features: all })?.doors).toEqual([
      'stats',
      'rewards',
      'achievements',
    ]);
    const noRewardsCapability = {
      ...base,
      features: all,
      health: base.health ? { ...base.health, capabilities: [] } : null,
    };
    expect(deriveProgresoView(noRewardsCapability)?.doors).toEqual(['stats', 'achievements']);
  });

  it('shows «números rojos» as a fact: red title, pill, typographic minus', () => {
    const view = deriveProgresoView(snapshotOf('negative-points'));
    expect(view).toMatchObject({
      phase: 'wilted',
      title: 'Nivel 3 · −340 puntos',
      negative: true,
      pill: 'Números rojos',
      streak: 'Racha: 0 días',
    });
    expect(view?.goal.value).toBe(0);
  });

  it('hides without guardian data', () => {
    expect(deriveProgresoView(snapshotOf('not-installed'))).toBeNull();
  });

  it('caps the goal bar and uses the singular for one day', () => {
    const base = snapshotOf('idle');
    const met = withState(base, (s) => ({
      ...s,
      points: {
        ...s.points,
        streakDays: 1,
        today: { ...s.points.today, focusMinutes: 95, goalMet: true },
      },
    }));
    const view = deriveProgresoView(met);
    expect(view?.goal).toMatchObject({ label: 'Hoy: 95 de 60 min', value: 1, met: true });
    expect(view?.streak).toBe('Racha: 1 día');
  });

  it('grows the mascot with the level and wilts it in the red', () => {
    expect(mascotPhase({ balance: 10, level: 1 })).toBe('sprout');
    expect(mascotPhase({ balance: 10, level: 4 })).toBe('plant');
    expect(mascotPhase({ balance: 10, level: 12 })).toBe('tree');
    expect(mascotPhase({ balance: -1, level: 12 })).toBe('wilted');
  });
});

describe('section 5 «Pie»', () => {
  it('shows guardian and extension status with the version', () => {
    expect(deriveFooterView(snapshotOf('idle'))).toEqual({
      guardian: { tone: 'green', label: 'Guardián activo', action: null },
      extension: { tone: 'green', label: 'Extensión conectada' },
      version: { label: 'v0.1.0', update: false },
      buttons: ['settings', 'quit'],
    });
  });

  it('turns into «Guardián detenido · Reparar» and hides stale extension data', () => {
    const view = deriveFooterView(snapshotOf('protection-broken'));
    expect(view.guardian).toEqual({ tone: 'red', label: 'Guardián detenido', action: 'repair' });
    expect(view.extension).toBeNull();
    expect(deriveFooterView(snapshotOf('not-installed')).guardian).toEqual({
      tone: 'red',
      label: 'Guardián no instalado',
      action: 'install',
    });
  });

  it('says «Guardián sin respuesta · Reparar» next to a create that timed out', () => {
    const s = snapshotOf('guardian-timeout');
    expect(s.link.status).toBe('ok');
    expect(deriveFooterView(s).guardian).toEqual({
      tone: 'orange',
      label: 'Guardián sin respuesta',
      action: 'repair',
    });
    // Cleared create (a later one succeeded or the card was dropped): back to «activo».
    expect(deriveFooterView({ ...s, ops: { ...s.ops, create: null } }).guardian.tone).toBe('green');
  });

  it('distinguishes a missing and a disconnected extension', () => {
    expect(deriveFooterView(snapshotOf('extension-missing')).extension).toEqual({
      tone: 'orange',
      label: 'Sin extensión',
    });
    const base = snapshotOf('idle');
    const disconnected = withState(base, (s) => ({
      ...s,
      protection: {
        ...s.protection,
        extensions: [makeExtensionStatus('chrome', now, { connected: false })],
      },
    }));
    expect(deriveFooterView(disconnected).extension?.label).toBe('Extensión desconectada');
  });

  it('says «Conectando…» before the first answer and offers the update in blue', () => {
    const base = snapshotOf('idle');
    const connecting = deriveFooterView({
      ...base,
      link: { ...base.link, status: 'connecting' },
      app: { ...base.app, updateVersion: '1.3.0' },
    });
    expect(connecting.guardian.label).toBe('Conectando con el guardián…');
    expect(connecting.version).toEqual({ label: 'Actualizar a v1.3.0', update: true });
  });

  it('adds «Mini temporizador» only with its flag', () => {
    const base = snapshotOf('idle');
    expect(
      deriveFooterView({ ...base, features: resolveFeatures({ miniTimer: true }) }).buttons,
    ).toEqual(['miniTimer', 'settings', 'quit']);
  });

  it('never shows a guardian problem as OK for any fixture', () => {
    for (const id of HARNESS_STATE_IDS) {
      const s = snapshotOf(id);
      const view = deriveFooterView(s);
      if (s.link.status === 'down') expect(view.guardian.tone).toBe('red');
      else if (s.ops.create?.status === 'failed' && s.ops.create.error?.code === 'timeout')
        expect(view.guardian.tone).toBe('orange');
      else expect(view.guardian.tone).toBe('green');
    }
  });
});

describe('errorCopy', () => {
  const rejected = (code: string, details: Record<string, unknown> | null = null): UiError =>
    uiError('rejected', code, 409, details);

  it.each([
    [uiError('timeout'), 'El guardián no responde', 'retry', true],
    [uiError('unreachable'), 'El guardián no responde', 'retry', true],
    [uiError('not_installed'), 'El guardián no está instalado', 'repair', false],
    [uiError('unauthorized', 'unauthorized', 401), 'Actualiza el guardián', 'repair', false],
    [uiError('incompatible'), 'Actualiza el guardián', 'repair', false],
    [
      uiError('read_only', 'read_only', 503),
      'El guardián solo puede leer ahora mismo',
      'details',
      false,
    ],
    [rejected('extension_exceeds_max'), 'Como mucho 24 h en total', 'edit', false],
    [rejected('block_not_active'), 'El bloqueo ya terminó', null, false],
    [rejected('not_extendable'), 'Un castigo no se puede ampliar', null, false],
    [rejected('duration_out_of_range'), 'Entre 5 min y 24 h', 'edit', false],
    [rejected('too_many_targets'), 'Demasiados bloqueos activos a la vez', 'edit', false],
    [
      rejected('protected_target'),
      'Eso no se puede bloquear: el sistema lo necesita',
      'edit',
      false,
    ],
    [rejected('unknown_id'), 'Actualiza el guardián: no conoce ese servicio', 'repair', false],
    [rejected('phrase_mismatch'), 'La frase no coincide', 'edit', false],
    [rejected('confirm_word_mismatch'), 'Escribe BORRAR', 'edit', false],
    [rejected('emergency_not_ready'), 'Aún no: espera a que acabe la cuenta atrás', null, false],
    [rejected('emergency_expired'), 'Se pasó el plazo: pide la emergencia otra vez', null, false],
    [rejected('emergency_in_progress'), 'Ya hay una emergencia en marcha', null, false],
    [rejected('emergency_not_available'), 'Ese bloqueo no admite emergencia', null, false],
    [rejected('emergency_moot'), 'Los bloqueos ya terminaron: no se ha cobrado nada', null, false],
    [rejected('rate_limited'), 'Demasiados intentos: espera un momento', 'retry', false],
    [rejected('confirmation_required'), 'Algo ha fallado en el guardián', 'details', false],
    [uiError('internal', 'internal', 500), 'Algo ha fallado en el guardián', 'details', false],
    [
      uiError('invalid_response', 'invalid_signature'),
      'Algo ha fallado en el guardián',
      'details',
      false,
    ],
  ] as const)('%o', (error, text, action, repair) => {
    expect(errorCopy(error)).toEqual({ text, action, repair });
  });

  it('adds the reason when data deletion is blocked', () => {
    expect(errorCopy(rejected('data_delete_blocked', { reason: 'study_active' })).text).toBe(
      'Ahora no se puede borrar: hay un Study Mode en marcha',
    );
    expect(errorCopy(rejected('data_delete_blocked', { reason: 'weird' })).text).toBe(
      'Ahora no se puede borrar',
    );
    expect(errorCopy(rejected('data_delete_blocked')).action).toBeNull();
  });

  it('labels its actions', () => {
    expect(errorActionLabel('retry')).toBe('Reintentar');
    expect(errorActionLabel('details')).toBe('Detalles…');
  });
});

describe('fixture builders used above', () => {
  it('keep blocks sorted so the primary block is first', () => {
    const state = makeGuardianState(now, {
      blocks: [
        makeBlock({ n: 1, mode: 'normal', leftMs: 60_000, elapsedMs: 0 }, now),
        makeBlock({ n: 2, mode: 'normal', leftMs: 120_000, elapsedMs: 0 }, now),
      ],
    });
    expect(state.blocks[0]?.id).toBe('blk_fixture0000000002');
  });
});
