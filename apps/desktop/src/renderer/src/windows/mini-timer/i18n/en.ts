/**
 * English strings of the mini timer (same shape as `es.ts`, `MiniTimerMessages`).
 */
import type { MiniTimerMessages } from './es';

export const MINI_TIMER_EN: MiniTimerMessages = {
  title: 'Mini timer',
  block: (targets: string, mode: string): string => `Block: ${targets} · ${mode}`,
  punishment: (level: string): string => `Penalty: ${level}`,
  punishmentLevel: {
    distractions: 'every distraction',
    whitelist: 'whitelist only',
    nuclear: 'computer locked',
  },
  idle: 'No blocks',
  checking: 'Checking…',
  connecting: 'Connecting…',
  guardianStopped: 'Guardian stopped',
  guardianMissing: 'No guardian',
  camera: 'Camera on',
};
