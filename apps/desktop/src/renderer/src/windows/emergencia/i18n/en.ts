/**
 * English strings of the Emergencia window (same shape as `es.ts`, `EmergenciaMessages`).
 * Penalties are a fact, never a reproach; the way back is always the recommended one.
 */
import type { EmergenciaMessages } from './es';

export const EMERGENCIA_EN: EmergenciaMessages = {
  title: {
    request: (what: string): string => `Emergency: ${what}`,
    unavailable: 'Emergency: not available',
    counting: 'Emergency: waiting',
    ready: 'Emergency: ready',
    done: 'Emergency: unlocked',
  },
  readyAt: (time: string): string => `ready at ${time}`,
  deadline: (time: string): string => `until ${time}`,
  wait: (minutes: number): string => `${minutes} min wait`,
  blocks: (n: number): string => (n === 1 ? '1 block' : `${n} blocks`),
  loss: (points: string, streakDays: number): string =>
    streakDays > 0
      ? `You will lose ${points} and your ${streakDays}-day streak`
      : `You will lose ${points}`,
  lossShort: (signedPoints: string): string => signedPoints,
  listLabel: 'Affected blocks',
  row: (targets: string, mode: string): string => `${targets} · ${mode}`,
  cancels: 'gets cancelled',
  stays: 'stays active',

  phrase: {
    intro: 'Type this phrase by hand:',
    quoted: (text: string): string => `“${text}”`,
    label: 'Commitment phrase',
    empty: 'Type it yourself: pasting does not count',
    typing: 'Keep typing…',
    mismatch: 'It does not match: check what you typed',
    ok: 'It matches',
    pasted: 'Type it by hand: pasting does not count',
  },

  actions: {
    rowLabel: 'What to do',
    request: (minutes: number): string => `Start the ${minutes} min wait`,
    requestHelp: 'The block stays on while you wait, and you can cancel for free',
    requestDisabled: 'First type the exact phrase',
    requesting: 'Requesting…',
    stay: 'Stay blocked',
    stayHelp: 'Closes this window without losing anything',
    cancel: 'Cancel (recommended)',
    cancelHelp: 'You lose nothing and the block stays on',
    unlock: 'Unlock',
    unlockHelp: 'Asks for confirmation before charging anything',
    close: 'Close',
    closeHelp: 'Closes this window',
  },

  waiting: 'Waiting',
  waitingHelp: 'When it ends you will have 5 min to unlock; otherwise the block stays on',
  waitMark: (minutes: number): string =>
    minutes === 1 ? 'You can unlock in 1 minute' : `You can unlock in ${minutes} minutes`,
  waitEnd: 'You can unlock now',
  decideMark: (minutes: number): string =>
    minutes === 1 ? '1 minute left to decide' : `${minutes} minutes left to decide`,
  decideEnd: 'Time is up: the block stays on',
  readyLead: 'You have',
  readyTail: 'to decide; after that, the block stays on',
  cancelled: 'Cancelled: you have lost nothing',

  announce: {
    stage: (title: string, datum: string | null): string => (datum ? `${title}, ${datum}` : title),
    phraseOk: 'Phrase correct: you can start the wait now',
    phraseMismatch: 'The phrase has a mistake: check it',
    pasted: 'Pasting is not allowed: you have to type the phrase',
  },

  done: {
    cancelled: (n: number): string =>
      n === 1 ? '1 block has been cancelled' : `${n} blocks have been cancelled`,
    lost: (points: string, streakDays: number): string =>
      streakDays > 0
        ? `You have lost ${points} and your ${streakDays}-day streak`
        : `You have lost ${points}`,
    balance: (points: string): string => `Balance: ${points}`,
  },

  unavailable: {
    noEmergency: (mode: string, until: string): string =>
      `${mode}: cannot be cancelled in any way ${until}`,
    none: 'There is no block that can be cancelled',
    help: 'Nobody can shorten it, not even from here',
  },

  until: {
    today: (time: string): string => `until ${time}`,
    tomorrow: (time: string): string => `until tomorrow at ${time}`,
    later: (date: string, time: string): string => `until ${date} at ${time}`,
  },

  modes: {
    hardcore: 'Hardcore',
    exam: 'Exam',
  },
};
