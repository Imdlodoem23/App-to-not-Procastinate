/**
 * Spanish strings of the Recompensas window (PROMPT §7 «Tienda de recompensas», §10 «Ventanas de
 * detalle › Recompensas»). Numbers, durations, points and clock times arrive formatted; the
 * functions only put them in order. A penalty or a shortfall is a fact, never a reproach.
 * `en.ts` has the same shape (`RecompensasMessages`).
 */
import type { RewardsLockReason } from '@centrate/shared/domain';
import type { MascotStage } from '@centrate/shared/points';
import type { Widen } from '../../../../../shared/i18n/locale';

export const RECOMPENSAS_ES = {
  /** «Recompensas: 1.240 puntos» (`points` already says «puntos»). */
  title: (points: string): string => `Recompensas: ${points}`,
  titleLocked: 'Recompensas: cerradas',
  loading: 'Leyendo la tienda…',
  /** Datum: the open break that ends last. */
  open: (service: string, time: string): string => `${service} hasta las ${time}`,
  openMany: (count: string): string => `${count} descansos abiertos`,

  /** Why the shop is closed (`lockReason`), also the reason of every disabled «Canjear». */
  locked: {
    hardcore: 'Durante un bloqueo Hardcore no se canjea nada',
    exam: 'Durante un examen no se canjea nada',
    punishment: 'Durante un castigo no se canjea nada',
    study: 'Durante el Study Mode no se canjea nada',
    emergency: 'Con una emergencia en marcha no se canjea nada',
  } satisfies Record<RewardsLockReason, string>,
  /** Closed without a known reason (a newer guardian). */
  closed: 'Ahora mismo no se canjea nada',

  shop: {
    rowLabel: 'Tienda',
    /** «15 min de YouTube». */
    offer: (duration: string, service: string): string => `${duration} de ${service}`,
    redeem: 'Canjear',
    redeeming: 'Canjeando…',
    /** Help of an offer that can be redeemed. */
    help: (service: string, duration: string, left: string): string =>
      `${service} ${duration} sin penalización · te quedarán ${left}`,
    /** The service already has an open break: redeeming adds to it. */
    helpExtend: (duration: string, service: string, left: string): string =>
      `Suma ${duration} a ${service} · te quedarán ${left}`,
    /** The armed «¿Seguro?» consequence: «−150 puntos: YouTube abierto hasta las 17:15». */
    consequence: (points: string, service: string, time: string): string =>
      `${points}: ${service} abierto hasta las ${time}`,
    /** «Te faltan 40 puntos» (`points` already says «puntos»). */
    short: (points: string): string => `Te faltan ${points}`,
    limit: (service: string, duration: string): string =>
      `Como mucho ${duration} de ${service} a la vez`,
    notBlocked: (service: string): string => `${service} no está bloqueado ahora`,
    /** The row's help when nothing is hovered. */
    rowHelp: 'Un descanso ganado abre ese servicio un rato, sin penalización',
    rowHelpShort: (points: string): string =>
      `Aún no te llega: cada minuto de bloqueo cumplido suma ${points}`,
    /** After a redemption (green, and said by the polite region). */
    redeemed: (service: string, time: string, left: string): string =>
      `Canjeado: ${service} abierto hasta las ${time} · te quedan ${left}`,
    /** Offers of services no block covers now, hidden from the list. */
    hidden: (services: string, count: number): string =>
      count === 1
        ? `${services} no está bloqueado ahora: no hace falta canjearlo`
        : `${services} no están bloqueados ahora: no hace falta canjearlos`,
  },

  errors: {
    /** `insufficient_points` from the guardian (the balance moved meanwhile). */
    short: (points: string): string => `Te faltan ${points}`,
    notBlocked: (service: string): string =>
      `${service} ya no está bloqueado: no hace falta canjearlo`,
    limit: (service: string, duration: string): string =>
      `Como mucho ${duration} de ${service} a la vez`,
    unknownOffer: 'Esa recompensa ya no existe: actualiza Céntrate',
    load: 'No he podido leer la tienda',
    retry: 'Reintentar',
    retryHelp: 'Vuelve a pedir la tienda al guardián',
  },

  empty: {
    text: 'Las recompensas abren un rato algo que tienes bloqueado, y ahora no hay nada bloqueado',
    action: 'Bloqueos…',
    help: 'Elige qué bloquear y durante cuánto',
  },

  mascot: {
    label: 'Tu mascota',
    /** «18 min más hoy y será una planta». */
    grow: {
      sprout: (minutes: string): string => `${minutes} más hoy y será una planta`,
      plant: (minutes: string): string => `${minutes} más hoy y será un árbol`,
    },
    tree: 'Hoy has cumplido tu objetivo: ya es un árbol',
    wilted: (minutes: string): string =>
      `Se marchitó al rendirte: vuelve a crecer con ${minutes} concentrado`,
    /** When the next phase is not known from today's minutes. */
    about: 'Crece mientras te concentras y se marchita si te rindes',
    names: {
      sprout: 'Tu brote',
      plant: 'Tu planta',
      tree: 'Tu árbol',
      wilted: 'Tu planta, marchita',
    } satisfies Record<MascotStage, string>,
  },

  keys: {
    retry: 'r',
    empty: 'b',
  },
};

export type RecompensasMessages = Widen<typeof RECOMPENSAS_ES>;
