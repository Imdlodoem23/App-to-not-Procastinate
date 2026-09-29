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
   * Alt + key of each door. Section 1 takes p t i, the footer z a s, and section 2 picks the
   * first free letter of its own labels (0 5 b d e h l m n o r x across the fixtures: «Deberes»,
   * «Examen», «Leer», «Más…», the card's modes, «Editar…», «Bloquear», «Reintentar»,
   * «Reparar», the extend row). «Estadísticas» keeps its free «c» and «Logros» its «g»;
   * every letter of «Recompensas» is taken by one of those, so it answers to Alt + W (as
   * «Rewards» does in English), not underlined.
   */
  mnemonics: { stats: 'c', rewards: 'w', achievements: 'g' },
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
