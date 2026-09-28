/**
 * English strings of the Nuclear overlay (same shape as `es.ts`, `NuclearMessages`).
 */
import type { PunishmentCause } from '@centrate/shared/domain';
import type { NuclearMessages } from './es';

export const NUCLEAR_EN: NuclearMessages = {
  appTitle: 'Céntrate: Nuclear penalty',
  title: (time: string): string => `Penalty · back at ${time}`,
  titleNoEnd: 'Penalty',
  cause: (cause: PunishmentCause, task: string): string => {
    if (cause === 'three_strikes') return task ? `3 strikes in "${task}"` : '3 strikes';
    return task ? `Study Mode abandoned: "${task}"` : 'Study Mode abandoned';
  },
  ended: 'Penalty finished',
  exit: {
    rowLabel: 'Way out',
    label: 'Emergency exit',
    help: (minutes: number): string => `Opens the emergency unlock: ${minutes} min wait`,
    consequence: (points: string, streakDays: number, minutes: number): string =>
      streakDays > 0
        ? `You will lose ${points} and your ${streakDays}-day streak · ${minutes} min wait`
        : `You will lose ${points} · ${minutes} min wait`,
    counting: 'Emergency under way:',
    ready: 'Emergency ready: open it to confirm',
  },
};
