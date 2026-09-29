/**
 * English strings of section 2 «Bloqueo» (same shape as `es.ts`, `BloqueoMessages`). The
 * phrase parser reads English phrases in any UI locale, so the field's examples are English.
 */
import type { BloqueoMessages } from './es';

export const BLOQUEO_EN: BloqueoMessages = {
  sectionName: 'Block',

  header: {
    none: 'Block: none',
    finished: 'Block: finished',
    active: (targets: string, mode: string): string => `Block: ${targets} · ${mode}`,
    activeCount: (count: number, mode: string): string => `Block: ${count} · ${mode}`,
    activeMode: (mode: string): string => `Block: ${mode}`,
    categoryShort: {
      social: 'Social',
      video: 'Video',
      games: 'Games',
      messaging: 'Messaging',
      shopping: 'Shopping',
      news: 'News',
    },
    whitelistShort: 'allowlist only',
    punishment: (level: string, minutes: number): string => `Punishment: ${level} · ${minutes} min`,
    punishmentShort: (what: string): string => `Punishment: ${what}`,
    nextSchedule: (when: string): string => `Next schedule: ${when}`,
    finishedPoints: (points: string): string => `Done. ${points}`,
    finishedNoPoints: 'Done',
    newPill: 'New',
    newPillLabel: 'New block: back to the field',
  },

  field: {
    label: 'What do you want to do?',
    hint: 'What do you want to do? Type it and press Enter',
    placeholder: (example: string): string => `e.g. ${example}`,
    // English phrases the parser fully understands (checked in the bloqueo tests).
    examples: [
      'no YouTube for an hour',
      'block TikTok and Instagram for 45 minutes',
      'block social media until 8:30 pm',
      'no games for an hour and a half',
      'no Netflix for 2h',
      'no Twitch or Discord for 30 min',
    ],
    notUnderstood: (fragments: readonly string[]): string =>
      `Not understood: ${fragments.map((f) => `“${f}”`).join(', ')}`,
    notUnderstoodAll: (text: string): string => `Not understood: “${text}”`,
    understood: (parts: readonly string[]): string => `Understood: ${parts.join(', ')}`,
    missingDuration: 'add how long',
    missingTargets: 'add what to block',
    chipHint: 'Fix this part',
    moreChips: (count: number): string => `+${count}`,
    hiddenTargets: (count: number, kind: 'web' | 'category' | 'mixed'): string =>
      kind === 'web'
        ? `${count} ${count === 1 ? 'site' : 'sites'}`
        : kind === 'category'
          ? `${count} ${count === 1 ? 'category' : 'categories'}`
          : `${count} items`,
  },

  templates: {
    rowLabel: 'Templates',
    rowHelp: 'One click prepares the block and Enter confirms it',
    more: 'More…',
    moreHelp: 'Opens Blocks: full form, templates and schedules',
    help: (targets: string, duration: string, mode: string): string =>
      `${targets} · ${duration} · ${mode}`,
    modeFromSettings: (mode: string): string => `${mode} (default)`,
  },

  card: {
    label: 'Confirm the block',
    targetsLabel: 'What gets blocked',
    durationChip: 'Duration',
    endChip: 'End time',
    // Language-neutral examples the Spanish parser reads («hasta las 8:00 PM» parses).
    editTargetsPlaceholder: 'YouTube, Instagram, marca.com…',
    editDurationPlaceholder: '45 min, 2 h, 1h30…',
    editEndPlaceholder: '18:30, 8:00 PM…',
    editHelp: 'Enter to apply · Esc to undo',
    modesLabel: 'Mode',
    modeHelp: {
      normal: 'Normal: an emergency unlock takes 10 min and costs at least 200 points',
      strict: 'Strict: an emergency unlock takes 30 min and costs at least 200 points',
      hardcore: 'Hardcore: cannot be cancelled in any way',
      exam: 'Exam: only study sites and apps, and cannot be cancelled',
    },
    reasonLabel: 'Your reason',
    reasonPlaceholder: 'Your reason (optional): “I want to pass math”',
    reminder: 'It can only be extended, never shortened',
    edit: 'Edit…',
    editHelp2: 'Opens Blocks with this block to change more',
    confirm: (until: string): string => `Block ${until}`,
    confirmAgain: (duration: string): string => `Yes, block ${duration}`,
    confirmHelp: 'It can only be extended, never shortened',
    confirmAgainHelp: 'Press again to block',
    pending: 'Blocking…',
    pendingHelp: 'Waiting for the guardian',
    summary: (targets: string, duration: string, until: string, mode: string): string =>
      `Blocks ${targets} for ${duration}, ${until}, ${mode} mode`,
    summaryWhitelist: 'everything except the allowlist',
    summaryNoTargets: (duration: string, until: string, mode: string): string =>
      `Nothing chosen to block. ${duration}, ${until}, ${mode} mode`,
    durationWords: (hours: number, minutes: number): string => {
      const parts: string[] = [];
      if (hours > 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`);
      if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minute' : `${minutes} minutes`);
      return parts.join(' and ');
    },
    consequenceLong: (duration: string, ends: string): string =>
      `${duration}: ends ${ends} and can only be extended`,
    consequenceNoEmergency: (until: string): string =>
      `You will not be able to cancel it in any way ${until}`,
    problem: {
      no_targets: 'Choose what to block: press a tile or Edit…',
      too_short: 'At least 5 min',
      too_long: 'Up to 24 h',
    },
    retry: 'Retry',
    retryHelp: 'Sends the same block again: it is never duplicated',
    repair: 'Repair',
    repairHelp: 'Starts the guardian (asks for administrator permission)',
    repairStarted: 'Guardian started: press Retry',
    repairCancelled: 'Permission was not granted',
    repairUnsupported: 'This cannot be repaired from here: see Settings',
  },

  active: {
    extendLabel: 'Extend',
    plus: (duration: string): string => `+${duration}`,
    other: 'Other…',
    extendHelp: 'It can only be extended, never shortened',
    extendTileHelp: (plus: string, ends: string): string => `${plus}: ends ${ends}`,
    otherHelp: 'Extend by any amount',
    maxReached: 'Up to 24 h in total',
    undoLine: (plus: string, ends: string): string => `${plus} · ends ${ends}`,
    undo: (seconds: number): string => `Undo (${seconds} s)`,
    undoLabel: (plus: string): string => `Undo the ${plus} extension`,
    sending: (plus: string): string => `${plus} · extending…`,
    failed: 'Could not extend',
    tooLate: 'Already extended',
    undone: 'Extension undone',
    undoAnnounce: (plus: string, ends: string, seconds: number): string =>
      `${plus}, ends ${ends}. You can undo it for ${seconds} seconds`,
    failedAnnounce: 'Could not extend: you can try again',
    otherPlaceholder: 'How much more? 20 min, 1 h…',
    otherLabel: 'How much you want to extend',
    otherApply: 'Extend',
    otherInvalid: 'Type how much: 20 min, 1 h, 1h30…',
    otherTooMuch: (max: string): string => `Up to ${max} more`,
    otherHelpLabel: 'Enter extends · Esc cancels',
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    more: (count: number): string => `and ${count} more…`,
    moreHelp: 'Opens Blocks with every active block',
    emergency: 'Emergency unlock…',
    emergencyHelp: 'Cancels the block after a wait, and you lose points',
    noEmergency: {
      hardcore: 'Hardcore: cannot be cancelled',
      exam: 'Exam: cannot be cancelled',
    },
    emergencyCounting: (countdown: string): string => `Emergency: ${countdown}`,
    emergencyReady: 'Emergency: ready',
    bootHold: 'Checking the time…',
    reasonLabel: 'Your reason',
  },

  punishment: {
    level: {
      distractions: 'all distractions',
      whitelist: 'allowlist only',
      nuclear: 'computer locked',
    },
    cause: (cause, task: string): string => {
      if (cause === 'three_strikes') return task ? `3 strikes on “${task}”` : '3 strikes';
      return task ? `Study Mode abandoned: “${task}”` : 'Study Mode abandoned';
    },
  },

  study: {
    reason: (task: string): string => `Study ${task}`,
  },

  when: {
    tomorrow: (time: string): string => `tomorrow ${time}`,
    weekday: (day: string, time: string): string => `${day} ${time}`,
  },
  ends: {
    today: (time: string): string => `at ${time}`,
    tomorrow: (time: string): string => `tomorrow at ${time}`,
    weekday: (day: string, time: string): string => `on ${day} at ${time}`,
  },
  untilLong: {
    today: (time: string): string => `until ${time}`,
    tomorrow: (time: string): string => `until tomorrow at ${time}`,
    weekday: (day: string, time: string): string => `until ${day} at ${time}`,
  },
  untilShort: {
    today: (time: string): string => `until ${time}`,
    tomorrow: (time: string): string => `until tomorrow ${time}`,
    date: (date: string, time: string): string => `until ${date} ${time}`,
  },
};
