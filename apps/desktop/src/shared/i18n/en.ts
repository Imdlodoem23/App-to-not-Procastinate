/**
 * English strings shared by the main process and the renderers (same shape as `es.ts`).
 * Numbers arrive formatted by `src/shared/format.ts` («1,240», «−10»).
 */
import type { SharedMessages } from './es';

export const SHARED_EN: SharedMessages = {
  appName: 'Céntrate',
  modes: {
    normal: 'Normal',
    strict: 'Strict',
    hardcore: 'Hardcore',
    exam: 'Exam',
  },
  categories: {
    social: 'Social media',
    video: 'Video and streaming',
    games: 'Games',
    messaging: 'Messaging',
    shopping: 'Shopping',
    news: 'News and sports',
  },
  targets: {
    whitelistOnly: 'Everything except the allowlist',
    none: 'Nothing',
    separator: ', ',
    more: (count: number): string => `+${count}`,
  },
  remaining: {
    words: (_minutes: number, label: string): string => `${label} left`,
    aria: (hours: number, minutes: number): string => {
      const parts: string[] = [];
      if (hours > 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`);
      if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minute' : `${minutes} minutes`);
      return `${parts.join(' and ')} left`;
    },
    announce: (minutes: number): string =>
      minutes === 1 ? '1 minute left' : `${minutes} minutes left`,
    ended: 'Block finished',
  },
  points: {
    long: (amount: string, value: number): string =>
      Math.abs(value) === 1 ? `${amount} point` : `${amount} points`,
    short: (amount: string): string => `${amount} pts`,
  },
  templates: {
    // «Homework 1 h» (the website's mock) is 2 px wider than a main-window tile (83 px of text
    // at 13 px): «1h» keeps the whole label visible.
    deberes: 'Homework 1h',
    examen: 'Exam 3 h',
    leer: 'Read 30 min',
  },
  keepAwake: {
    title: 'Keep awake',
    forever: 'Until I turn it off',
    turnOff: 'Turn off',
    awake: 'Awake',
    until: (clock: string): string => `until ${clock}`,
    failed: 'This computer could not be kept awake',
    unsupported: 'This computer does not allow keeping it awake',
  },
};
