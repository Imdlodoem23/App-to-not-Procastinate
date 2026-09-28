import { describe, expect, it } from 'vitest';
import { harnessFixture, makePoints } from '../../../src/shared/fixtures';
import { withLocale } from '../../../src/shared/i18n/locale';
import type { UiSnapshot } from '../../../src/shared/ui-state';
import {
  NUCLEAR_EXIT_ARM_ID,
  deriveNuclearView,
} from '../../../src/renderer/src/windows/nuclear/view';

function nuclear(): UiSnapshot {
  return harnessFixture('nuclear').snapshot;
}

function withState(
  base: UiSnapshot,
  patch: (s: NonNullable<UiSnapshot['state']>) => NonNullable<UiSnapshot['state']>,
): UiSnapshot {
  if (!base.state) throw new Error('fixture without state');
  return { ...base, state: patch(base.state) };
}

describe('Nuclear overlay', () => {
  it('reads «Castigo · vuelves a las 18:40» over the countdown, with cause and cost', () => {
    const s = nuclear();
    const view = deriveNuclearView(s);
    expect(view).toMatchObject({
      active: true,
      title: 'Castigo · vuelves a las 18:40',
      endsAt: s.state?.punishments[0]?.endsAt,
      cause: '3 strikes en "mates"',
      points: '−100 puntos',
    });
  });

  it('arms «Salida de emergencia» with the price and the wait on the help line', () => {
    // Balance 1.095 → max(200, 547) = 547 points; streak 5 days; a strict punishment waits 30 min.
    expect(deriveNuclearView(nuclear()).exit).toEqual({
      kind: 'arm',
      help: 'Abre el desbloqueo de emergencia: espera de 30 min',
      consequence: 'Perderás 547 puntos y tu racha de 5 días · espera de 30 min',
    });
    expect(NUCLEAR_EXIT_ARM_ID).toBe('nuclear-exit');
  });

  it('prices at least 200 points and leaves the streak out when there is none', () => {
    const s = withState(nuclear(), (st) => ({
      ...st,
      points: makePoints({ balance: -40, streakDays: 0 }),
    }));
    expect(deriveNuclearView(s).exit).toMatchObject({
      consequence: 'Perderás 200 puntos · espera de 30 min',
    });
  });

  it('opens an emergency already under way directly, saying where it stands', () => {
    const counting = harnessFixture('emergency-waiting').snapshot.state?.emergency ?? null;
    const ready = harnessFixture('emergency-ready').snapshot.state?.emergency ?? null;
    expect(counting?.status).toBe('counting');
    expect(ready?.status).toBe('ready');
    const withCounting = withState(nuclear(), (st) => ({ ...st, emergency: counting }));
    expect(deriveNuclearView(withCounting).exit).toEqual({
      kind: 'counting',
      help: 'Emergencia en marcha:',
      readyAt: counting?.readyAt,
    });
    const withReady = withState(nuclear(), (st) => ({ ...st, emergency: ready }));
    expect(deriveNuclearView(withReady).exit).toEqual({
      kind: 'ready',
      help: 'Emergencia lista: ábrela para confirmarla',
    });
  });

  it('says only «Castigo» until the guardian gives the end', () => {
    const s = withState(nuclear(), (st) => ({ ...st, punishments: [], blocks: [] }));
    const view = deriveNuclearView(s);
    expect(view).toMatchObject({ active: true, title: 'Castigo', endsAt: null, cause: null });
  });

  it('is inactive once the guardian no longer says Nuclear', () => {
    const s = withState(nuclear(), (st) => ({ ...st, nuclearActive: false }));
    expect(deriveNuclearView(s).active).toBe(false);
    expect(deriveNuclearView(harnessFixture('idle').snapshot).active).toBe(false);
  });

  it('reads in English', () => {
    const view = withLocale('en', () => deriveNuclearView(nuclear()));
    expect(view.title).toBe('Penalty · back at 6:40 PM');
    expect(view.cause).toBe('3 strikes in "mates"');
    expect(view.exit).toMatchObject({
      consequence: 'You will lose 547 points and your 5-day streak · 30 min wait',
    });
  });
});
