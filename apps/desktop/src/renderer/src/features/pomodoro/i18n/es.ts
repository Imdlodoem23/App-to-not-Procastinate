/**
 * Spanish strings of the Pomodoro (PROMPT §9 «Pomodoro integrado (25/5 y 50/10, personalizable);
 * en los descansos se pausa la vigilancia de la cámara»). Durations and countdowns are formatted
 * before they get here. `en.ts` has the same shape (`PomodoroMessages`).
 */
import type { Widen } from '../../../../../shared/i18n/locale';

export const POMODORO_ES = {
  /** «25/5», «50/10», and the user's own («40/8»). */
  preset: (work: number, rest: number): string => `${work}/${rest}`,
  custom: 'Personalizado',
  /** «4 × 25 min con 5 min de descanso · 1 h 55 min». */
  presetHelp: (cycles: number, work: string, rest: string, total: string): string =>
    `${cycles} × ${work} con ${rest} de descanso · ${total}`,
  customHelp: (cycles: number, work: string, rest: string, total: string): string =>
    `Personalizado: ${cycles} × ${work} con ${rest} de descanso · ${total}`,
  /** The Study Mode meter while a Pomodoro runs. */
  phase: {
    /** «Concentración 2 de 4 · 12:30». */
    work: (cycle: number, cycles: number, left: string): string =>
      `Concentración ${cycle} de ${cycles} · ${left}`,
    /** «Descanso 4:12 · la cámara no vigila». */
    break: (left: string): string => `Descanso ${left} · la cámara no vigila`,
    paused: 'En pausa · la cámara no vigila',
    done: 'Pomodoro terminado',
  },
  /** The custom preset's fields. */
  fields: {
    workMinutes: 'Concentración (min)',
    breakMinutes: 'Descanso (min)',
    cycles: 'Rondas',
  },
  errors: {
    notANumber: 'Escribe un número',
    range: (min: number, max: number): string => `Entre ${min} y ${max}`,
  },
  /** Fewer rounds than asked: a study session lasts at most 8 h. */
  capped: (cycles: number): string => `Como mucho ${cycles} rondas: una sesión dura hasta 8 h`,
} as const;

export type PomodoroMessages = Widen<typeof POMODORO_ES>;
