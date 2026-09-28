/**
 * English strings of the Bloqueos window (same shape as `es.ts`, `BloqueosMessages`). Mode
 * names, target lists and points come from `src/shared/format.ts`; numbers and clock times are
 * formatted before they get here.
 */
import type { BloqueosMessages } from './es';

export const BLOQUEOS_EN: BloqueosMessages = {
  seed: (phrase: string): string => `From your phrase “${phrase}”: fill in what is missing`,

  targets: {
    title: (label: string): string => `What to block: ${label}`,
    titleNone: 'What to block: nothing yet',
    titleWhitelist: 'What to block: everything except the allowlist',
    results: (n: number): string =>
      n === 0 ? 'No results' : n === 1 ? '1 result' : `${n} results`,
    searchLabel: 'Search the catalog',
    searchPlaceholder: 'Search: YouTube, social, games…',
    noResults: 'Not in the catalog: if it is a site, add it under “Custom domains”',
    groupsLabel: 'Catalog categories',
    show: (n: number): string => (n === 1 ? 'Show 1 service' : `Show ${n} services`),
    hide: 'Hide',
    otros: 'Other',
    otrosNote: 'only if picked',
    includedIn: (category: string): string => `Already blocked by “${category}”`,
    domains: {
      label: 'Custom domains',
      placeholder: 'example.com',
      add: 'Add',
      invalid: 'That does not look like a site: try example.com',
      protected: 'That cannot be blocked: the system needs it',
      duplicate: 'Already on the list',
      max: (n: number): string => `${n} domains at most`,
      catalog: (domain: string, service: string): string =>
        `${domain} belongs to ${service}: checked in the catalog`,
      help: 'Sites that are not in the catalog',
    },
    apps: {
      label: 'Computer apps',
      placeholder: 'Discord, steam.exe…',
      add: 'Add',
      invalid: 'Type the program name, for example steam.exe',
      protected: 'That cannot be blocked: the system needs it',
      duplicate: 'Already on the list',
      max: (n: number): string => `${n} apps at most`,
      suggestions: 'Suggestions',
      suggestionsLabel: 'Matching apps',
      help: 'They close if you open them during the block',
    },
    remove: (what: string): string => `Remove ${what}`,
    removeHelp: 'Press a tile to remove it',
    whitelistIntro: 'Exam blocks every site and app except study ones:',
    whitelistList: (names: string, more: number): string =>
      more > 0 ? `${names} and ${more} more` : names,
  },

  duration: {
    title: (label: string): string => `Duration: ${label}`,
    titleOpen: 'Duration: not chosen',
    datum: (when: string): string => `until ${when}`,
    presetsLabel: 'Duration',
    presetHelp: (label: string, until: string): string => `${label}: ${until}`,
    minutesLabel: 'Duration',
    minutesPlaceholder: '45 min, 2 h, 1h30…',
    untilLabel: 'Until',
    untilPlaceholder: 'HH:MM',
    help: 'From 5 min to 24 h, or until a set time',
    invalidMinutes: 'Type how long: 45 min, 2 h, 1h30…',
    invalidUntil: 'Type the time like this: 18:30',
    tooShort: '5 min at least',
    tooLong: '24 h at most',
  },

  mode: {
    title: (mode: string): string => `Mode: ${mode}`,
    rowLabel: 'Mode',
    datum: {
      normal: 'emergency: 10 min',
      strict: 'emergency: 30 min',
      hardcore: 'no emergency',
      exam: 'no emergency',
    },
    help: {
      normal: 'Normal: the emergency takes 10 min and costs at least 200 points',
      strict: 'Strict: the emergency takes 30 min and costs at least 200 points',
      hardcore: 'Hardcore: cannot be cancelled in any way',
      exam: 'Exam: only study sites and apps, and cannot be cancelled',
    },
  },

  reason: {
    title: 'Your reason',
    datum: 'shown when you try to get in',
    label: 'Your reason (optional)',
    placeholder: 'I want to pass maths',
  },

  actions: {
    rowLabel: 'Save or block',
    save: 'Save as template',
    saveHelp: 'Stays with your templates, ready in one click',
    block: 'Block',
    blockHelp: 'You confirm it in the main window: it can only be extended, never shortened',
    problem: {
      no_targets: 'Choose what to block',
      no_duration: 'Choose how long',
      too_short: '5 min at least',
      too_long: '24 h at most',
    },
    sent: 'Confirm it in the main window',
    nameLabel: 'Template name',
    nameRowLabel: 'Save the template',
    saveName: 'Save',
    saveNameHelp: 'Saves the template with this name',
    cancel: 'Cancel',
    cancelHelp: 'Back to the form without saving',
    nameEmpty: 'Give it a name',
    nameLong: (max: number): string => `${max} characters at most`,
    saved: (label: string): string => `Saved: “${label}”`,
    full: 'You already have 30 templates: delete one first',
  },

  active: {
    title: (n: number): string =>
      n === 0 ? 'Active: none' : n === 1 ? 'Active: 1 block' : `Active: ${n} blocks`,
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    punishment: 'Penalty',
    until: (when: string): string => `until ${when}`,
    empty: 'Nothing is blocked right now',
    emergency: 'Emergency unlock…',
    listLabel: 'Active blocks',
  },

  templates: {
    title: (n: number): string => `Templates: ${n}`,
    desc: (targets: string, duration: string, mode: string): string =>
      `${targets} · ${duration} · ${mode}`,
    defaultMode: 'default mode',
    builtin: 'built-in',
    use: 'Use',
    useHelp: 'Loads it into the form above',
    remove: 'Delete',
    removeConsequence: (label: string): string => `“${label}” is deleted for good`,
    rowLabel: (label: string): string => `Template ${label}`,
  },

  schedules: {
    title: (on: number, total: number): string =>
      total === 0 ? 'Schedules: none' : `Schedules: ${on} of ${total} active`,
    loading: 'Schedules: loading…',
    unavailable: 'Schedules: not connected',
    next: (when: string): string => `Next: ${when}`,
    row: (days: string, start: string, end: string, targets: string): string =>
      `${days} ${start}–${end} · ${targets}`,
    desc: (name: string, mode: string): string => (name ? `${name} · ${mode}` : mode),
    running: 'Running: you can change it when it ends',
    frozen: 'Starts in under 10 min: it can no longer be removed',
    saving: 'Saving…',
    empty: 'You have no schedules yet',
    retry: 'Retry',
    days: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
    everyDay: 'Every day',
    range: (a: string, b: string): string => `${a}–${b}`,
    daySeparator: ', ',
  },

  exam: {
    title: 'Exam mode: allowlist + Hardcore',
    datum: 'cannot be cancelled',
    rowLabel: 'Start an exam',
    tile: (duration: string): string => `Exam ${duration}`,
    tileHelp: (duration: string): string =>
      `Everything except the allowlist for ${duration}: you confirm it in the main window`,
    rowHelp: 'One click opens the confirmation in the main window',
    customize: 'Customize',
    customizeHelp: 'Prepares the exam in the form above',
  },

  until: {
    today: (time: string): string => `until ${time}`,
    tomorrow: (time: string): string => `until tomorrow at ${time}`,
    weekday: (day: string, time: string): string => `until ${day} at ${time}`,
  },
  when: {
    tomorrow: (time: string): string => `tomorrow ${time}`,
    weekday: (day: string, time: string): string => `${day} ${time}`,
  },
};
