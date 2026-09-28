/**
 * English strings of the Recompensas window (same shape as `es.ts`, `RecompensasMessages`).
 * A penalty or a shortfall is a fact, never a reproach.
 */
import type { RecompensasMessages } from './es';

export const RECOMPENSAS_EN: RecompensasMessages = {
  title: (points: string): string => `Rewards: ${points}`,
  titleLocked: 'Rewards: closed',
  loading: 'Reading the shop…',
  open: (service: string, time: string): string => `${service} until ${time}`,
  openMany: (count: string): string => `${count} breaks open`,

  locked: {
    hardcore: 'Nothing can be redeemed during a Hardcore block',
    exam: 'Nothing can be redeemed during an exam',
    punishment: 'Nothing can be redeemed during a punishment',
    study: 'Nothing can be redeemed during Study Mode',
    emergency: 'Nothing can be redeemed while an emergency unlock is pending',
  },
  closed: 'Nothing can be redeemed right now',

  shop: {
    rowLabel: 'Shop',
    offer: (duration: string, service: string): string => `${duration} of ${service}`,
    redeem: 'Redeem',
    redeeming: 'Redeeming…',
    help: (service: string, duration: string, left: string): string =>
      `${service} for ${duration} without penalty · ${left} left`,
    helpExtend: (duration: string, service: string, left: string): string =>
      `Adds ${duration} to ${service} · ${left} left`,
    consequence: (points: string, service: string, time: string): string =>
      `${points}: ${service} open until ${time}`,
    short: (points: string): string => `You need ${points} more`,
    limit: (service: string, duration: string): string =>
      `At most ${duration} of ${service} at a time`,
    notBlocked: (service: string): string => `${service} is not blocked now`,
    rowHelp: 'An earned break opens that service for a while, without penalty',
    rowHelpShort: (points: string): string =>
      `Not enough yet: every minute of a finished block adds ${points}`,
    redeemed: (service: string, time: string, left: string): string =>
      `Redeemed: ${service} open until ${time} · ${left} left`,
    hidden: (services: string, count: number): string =>
      count === 1
        ? `${services} is not blocked now: no need to redeem it`
        : `${services} are not blocked now: no need to redeem them`,
  },

  errors: {
    short: (points: string): string => `You need ${points} more`,
    notBlocked: (service: string): string => `${service} is no longer blocked: no need to redeem it`,
    limit: (service: string, duration: string): string =>
      `At most ${duration} of ${service} at a time`,
    unknownOffer: 'That reward no longer exists: update Céntrate',
    load: 'I could not read the shop',
    retry: 'Try again',
    retryHelp: 'Asks the guardian for the shop again',
  },

  empty: {
    text: 'Rewards open something you have blocked for a while, and nothing is blocked now',
    action: 'Blocks…',
    help: 'Choose what to block and for how long',
  },

  mascot: {
    label: 'Your mascot',
    grow: {
      sprout: (minutes: string): string => `${minutes} more today and it becomes a plant`,
      plant: (minutes: string): string => `${minutes} more today and it becomes a tree`,
    },
    tree: 'You met your goal today: it is a tree now',
    wilted: (minutes: string): string =>
      `It wilted when you gave up: ${minutes} of focus brings it back`,
    about: 'It grows while you focus and wilts if you give up',
    names: {
      sprout: 'Your sprout',
      plant: 'Your plant',
      tree: 'Your tree',
      wilted: 'Your plant, wilted',
    },
  },

  keys: {
    retry: 't',
    empty: 'b',
  },
};
