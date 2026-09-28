/**
 * Spanish strings of the mini timer (PROMPT §5 «Mini temporizador flotante», §10 «Mini
 * temporizador»): 180×44, the service icon, the time at 20 px and the camera dot. The window has
 * no controls (it is dragged by its body), so these are its accessible names and the short text
 * that takes the countdown's place when nothing counts down. `en.ts` has the same shape
 * (`MiniTimerMessages`).
 */
import type { PunishmentLevel } from '@centrate/shared/domain';
import type { Widen } from '../../../../../shared/i18n/locale';

export const MINI_TIMER_ES = {
  /** The window's hidden `<h1>` and the name of its landmark. */
  title: 'Mini temporizador',
  /** What the countdown belongs to (screen readers): «Bloqueo: YouTube, Instagram · Estricto». */
  block: (targets: string, mode: string): string => `Bloqueo: ${targets} · ${mode}`,
  /** «Castigo: todas las distracciones». */
  punishment: (level: string): string => `Castigo: ${level}`,
  punishmentLevel: {
    distractions: 'todas las distracciones',
    whitelist: 'solo lista blanca',
    nuclear: 'ordenador bloqueado',
  } satisfies Record<PunishmentLevel, string>,
  /** In place of the countdown (13 px, it must fit in 128 px). */
  idle: 'Sin bloqueos',
  checking: 'Comprobando…',
  connecting: 'Conectando…',
  guardianStopped: 'Guardián detenido',
  guardianMissing: 'Sin guardián',
  /** The camera dot's text (the dot alone would be color only). */
  camera: 'Cámara activa',
};

export type MiniTimerMessages = Widen<typeof MINI_TIMER_ES>;
