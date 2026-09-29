/** English strings of the Pomodoro (same shape as `es.ts`, `PomodoroMessages`). */
import type { PomodoroMessages } from './es';

export const POMODORO_EN: PomodoroMessages = {
  preset: (work: number, rest: number): string => `${work}/${rest}`,
  custom: 'Custom',
  presetHelp: (cycles: number, work: string, rest: string, total: string): string =>
    `${cycles} × ${work} with ${rest} breaks · ${total}`,
  customHelp: (cycles: number, work: string, rest: string, total: string): string =>
    `Custom: ${cycles} × ${work} with ${rest} breaks · ${total}`,
  phase: {
    work: (cycle: number, cycles: number, left: string): string =>
      `Focus ${cycle} of ${cycles} · ${left}`,
    break: (left: string): string => `Break ${left} · the camera is not watching`,
    paused: 'Paused · the camera is not watching',
    done: 'Pomodoro finished',
  },
  fields: {
    workMinutes: 'Focus (min)',
    breakMinutes: 'Break (min)',
    cycles: 'Rounds',
  },
  errors: {
    notANumber: 'Type a number',
    range: (min: number, max: number): string => `Between ${min} and ${max}`,
  },
  capped: (cycles: number): string => `Up to ${cycles} rounds: a session lasts at most 8 h`,
};
