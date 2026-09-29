/**
 * Spanish strings of the Nuclear overlay (PROMPT §10 «Nuclear», §8 castigo nivel 3): the theme
 * background on every screen, a 72 px countdown, «Castigo · vuelves a las 18:40» and one
 * secondary «Salida de emergencia», which opens the emergency unlock after an in-place
 * «¿Seguro?». Penalties are data, never a telling-off. Times and points arrive formatted.
 * `en.ts` has the same shape (`NuclearMessages`).
 */
import type { PunishmentCause } from '@centrate/shared/domain';
import type { Widen } from '../../../../../shared/i18n/locale';

export const NUCLEAR_ES = {
  /** The window's hidden `<h1>`. */
  appTitle: 'Céntrate: castigo Nuclear',
  /** Section header: «Castigo · vuelves a las 18:40». */
  title: (time: string): string => `Castigo · vuelves a las ${time}`,
  /** Without a known end (the guardian is catching up). */
  titleNoEnd: 'Castigo',
  /** «3 strikes en "mates"». */
  cause: (cause: PunishmentCause, task: string): string => {
    if (cause === 'three_strikes') return task ? `3 strikes en "${task}"` : '3 strikes';
    return task ? `Study Mode abandonado: "${task}"` : 'Study Mode abandonado';
  },
  /** Spoken when the countdown reaches zero. */
  ended: 'Castigo terminado',
  exit: {
    rowLabel: 'Salida',
    label: 'Salida de emergencia',
    /** The help line at rest and on hover. */
    help: (minutes: number): string => `Abre el desbloqueo de emergencia: espera de ${minutes} min`,
    /** «¿Seguro?»: «Perderás 548 puntos y tu racha de 5 días · espera de 30 min». */
    consequence: (points: string, streakDays: number, minutes: number): string =>
      streakDays > 0
        ? `Perderás ${points} y tu racha de ${streakDays} ${streakDays === 1 ? 'día' : 'días'} · espera de ${minutes} min`
        : `Perderás ${points} · espera de ${minutes} min`,
    /** An emergency already requested: the button just opens it. */
    counting: 'Emergencia en marcha:',
    ready: 'Emergencia lista: ábrela para confirmarla',
  },
  /** Alt + letter of the exit (PROMPT §10: «Alt + letra en cada tile»); present in both labels. */
  keys: {
    exit: 'e',
  },
};

export type NuclearMessages = Widen<typeof NUCLEAR_ES>;
