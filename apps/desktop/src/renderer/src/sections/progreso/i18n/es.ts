/**
 * Spanish strings of section 4 «Progreso» added with its doors (PROMPT §10 «Progreso»). The
 * header, the goal bar and the door labels live in the renderer's own table
 * (`RENDERER.progreso`); these are the doors' Alt + letter and their live help. `en.ts` has the
 * same shape (`ProgresoMessages`).
 */
import type { RewardsLockReason } from '@centrate/shared/domain';
import type { Widen } from '../../../../../shared/i18n/locale';

export const PROGRESO_ES = {
  /**
   * Alt + letter of each door. Section 2 takes the first free letter of its labels («Deberes»
   * d, «Examen» e, «Leer» l, «Más…» m, the card's modes n e h x, «Editar…» d, «Bloquear» b,
   * the extend row 5 0 h o), section 1 p t i and the footer z a s: these never meet them.
   */
  mnemonics: { stats: 'c', rewards: 'r', achievements: 'g' },
  /** Logros… with the count of `snapshot.progress`: «3 de 8 conseguidos: mira cómo lograr el resto». */
  achievementsCount: (achieved: string, total: string): string =>
    `${achieved} de ${total} conseguidos: mira cómo lograr el resto`,
  /** Reached since Logros was last opened. */
  achievementsFresh: (title: string): string => `Logro nuevo: ${title}`,
  achievementsFreshMany: (count: string): string => `${count} logros nuevos`,
  /** Recompensas… while the guardian keeps the shop closed (`rewardsLock`). */
  rewardsLocked: {
    hardcore: 'Cerradas mientras dure el Hardcore',
    exam: 'Cerradas mientras dure el examen',
    punishment: 'Cerradas mientras dure el castigo',
    study: 'Cerradas durante el Study Mode',
    emergency: 'Cerradas con una emergencia en marcha',
  } satisfies Record<RewardsLockReason, string>,
};

export type ProgresoMessages = Widen<typeof PROGRESO_ES>;
