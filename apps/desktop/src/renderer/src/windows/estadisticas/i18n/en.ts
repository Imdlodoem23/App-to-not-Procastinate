/**
 * English strings of the Estadísticas window (same shape as `es.ts`, `EstadisticasMessages`).
 * Numbers, durations, clock times and dates arrive formatted. Points lost are a fact, never a
 * reproach.
 */
import type { EstadisticasMessages } from './es';

export const ESTADISTICAS_EN: EstadisticasMessages = {
  title: (duration: string): string => `Focused: ${duration}`,
  loading: 'Reading your statistics…',

  ranges: {
    rowLabel: 'Period',
    day: 'Day',
    week: 'Week',
    month: 'Month',
    help: {
      day: 'Your focused time hour by hour',
      week: 'Your focused time from Monday to Sunday',
      month: 'Your focused time on each day of the month',
    },
  },

  nav: {
    rowLabel: 'Change period',
    previous: {
      day: '‹ Previous day',
      week: '‹ Previous week',
      month: '‹ Previous month',
    },
    current: {
      day: 'Today',
      week: 'This week',
      month: 'This month',
    },
    next: {
      day: 'Next day ›',
      week: 'Next week ›',
      month: 'Next month ›',
    },
    previousHelp: 'See the previous period',
    currentHelp: 'Go back to the current period',
    nextHelp: 'See the next period',
    atCurrent: 'You are already looking at the current period',
    future: 'What has not happened yet has no statistics',
  },

  dates: {
    today: 'today',
    yesterday: 'yesterday',
    dayShort: (weekday: string, day: number, month: string): string =>
      `${weekday}, ${month} ${day}`,
    dayLong: (weekday: string, day: number, month: string): string =>
      `${weekday}, ${month} ${day}`,
    weekSameMonth: (from: number, to: number, month: string): string => `${month} ${from}–${to}`,
    weekTwoMonths: (from: number, fromMonth: string, to: number, toMonth: string): string =>
      `${fromMonth} ${from} – ${toMonth} ${to}`,
    withYear: (text: string, year: number): string => `${text}, ${year}`,
    weekTick: (weekday: string, day: number): string => `${weekday} ${day}`,
    barDay: (weekday: string, day: number): string => `${weekday} ${day}`,
    hourRange: (from: string, to: string): string => `${from}–${to}`,
    logToday: (time: string): string => `today ${time}`,
    logYesterday: (time: string): string => `yesterday ${time}`,
    logOlder: (day: number, month: string, time: string): string => `${month} ${day} ${time}`,
  },

  chart: {
    caption: {
      day: 'Focused minutes per hour',
      week: 'Focused minutes per day',
      month: 'Focused minutes per day',
    },
    readout: (when: string, duration: string, attempts: number): string =>
      attempts > 0
        ? `${when}: ${duration} · ${attempts === 1 ? '1 attempt' : `${attempts} attempts`}`
        : `${when}: ${duration}`,
    hint: 'Hover over a bar, or use the arrow keys, to see its minutes',
    none: 'No focused time in this period',
    table: {
      when: { day: 'Hour', week: 'Day', month: 'Day' },
      minutes: 'Focused',
      attempts: 'Attempts',
      points: 'Points',
    },
  },

  summary: {
    label: 'Summary of the period',
    average: 'Daily average',
    bestDay: 'Best day',
    bestHour: 'Best hour',
    best: (when: string, duration: string): string => `${when} · ${duration}`,
    noBest: 'none yet',
    goal: 'Goal met',
    goalToday: "Today's goal",
    goalDay: 'Daily goal',
    goalDays: (met: number, days: number): string =>
      `${met} of ${days} ${days === 1 ? 'day' : 'days'}`,
    goalProgress: (done: string, goal: string): string => `${done} of ${goal}`,
    goalMet: 'met',
    study: 'In Study Mode',
    blocks: 'Blocks completed',
    attempts: 'Attempts',
    points: 'Points',
  },

  heatmap: {
    title: (days: number): string => `Streak: ${days} ${days === 1 ? 'day' : 'days'}`,
    best: (days: number): string => `best: ${days} ${days === 1 ? 'day' : 'days'}`,
    summary: (active: number, goal: number): string =>
      `Last year: ${active} active ${active === 1 ? 'day' : 'days'} · ${goal} with the goal met`,
    readout: (day: string, duration: string, goalMet: boolean): string =>
      goalMet ? `${day}: ${duration} · goal met` : `${day}: ${duration}`,
    readoutNone: (day: string): string => `${day}: no focused time`,
    less: 'Less',
    more: 'More',
    weekdays: ['Mon', 'Wed', 'Fri'],
  },

  targets: {
    title: 'What you try to open most',
    listLabel: 'What you try to open most, with its attempts',
    attempts: (n: number): string => (n === 1 ? '1 attempt' : `${n} attempts`),
    none: 'No attempts in this period',
  },

  hours: {
    title: 'Your best hours',
    listLabel: 'Your best hours, with their minutes',
    none: 'No minutes in this period yet',
  },

  log: {
    title: (n: string, count: number): string => `Log: ${n} ${count === 1 ? 'event' : 'events'}`,
    titleLoading: 'Log',
    listLabel: 'Event log, newest first',
    filters: {
      rowLabel: 'Filter the log',
      all: 'All',
      blocks: 'Blocks',
      attempts: 'Attempts',
      points: 'Points',
      study: 'Study Mode',
      help: {
        all: 'Everything that happened, newest first',
        blocks: 'Blocks created, extended and completed',
        attempts: 'Every time you tried to open something blocked',
        points: 'Only what added or took away points',
        study: 'Sessions, focused minutes and strikes',
      },
    },
    events: {
      guardian_started: 'Guardian started',
      epoch_started: 'New log',
      clock_jump: 'Clock change detected',
      day_closed: 'Day closed',
      block_created: 'Block',
      block_extended: 'Extended',
      block_completed: 'Block completed',
      block_cancelled: 'Block cancelled',
      block_reactivated: 'Block reactivated',
      attempt: 'Attempt',
      process_closed: 'App closed',
      study_started: 'Study Mode',
      study_paused: 'Study Mode paused',
      study_resumed: 'Study Mode resumed',
      focus_minutes: 'Focused',
      strike: 'Strike',
      study_ended: 'Study Mode ended',
      study_outcome: 'Session result',
      punishment_started: 'Punishment',
      punishment_ended: 'Punishment ended',
      emergency_requested: 'Emergency requested',
      emergency_cancelled: 'Emergency cancelled',
      emergency_confirmed: 'Emergency unlock',
      reward_redeemed: 'Reward',
      reward_ended: 'Reward ended',
      schedule_created: 'New schedule',
      schedule_updated: 'Schedule changed',
      schedule_deleted: 'Schedule deleted',
      settings_changed: 'Settings changed',
      extension_paired: 'Extension paired',
      extension_revoked: 'Extension removed',
      tamper_detected: 'Tampering detected',
      ledger_repaired: 'Log repaired',
    },
    unknownEvent: 'Other event',
    none: 'Nothing in the log with this filter',
    more: 'Show more',
    moreHelp: (shown: string, total: string): string => `Showing ${shown} of ${total} events`,
    loadingMore: 'Loading…',
  },

  exports: {
    rowLabel: 'Export CSV',
    events: 'Export events',
    days: 'Export days',
    eventsHelp: 'A CSV file with every event: date, type, target and points',
    daysHelp: 'A CSV file with one row per day: minutes, attempts and points',
    help: 'Save your data as CSV to open it in a spreadsheet',
    saving: 'Saving…',
    saved: (file: string, rows: string, count: number): string =>
      `Saved: ${file} · ${rows} ${count === 1 ? 'row' : 'rows'}`,
    cancelled: 'Nothing was saved',
    failed: 'I could not save the file. Try again',
  },

  empty: {
    text: 'Your statistics will appear after your first session',
    action: 'Start 25 min',
    help: 'Opens the confirmation of a 25 min block in the main window',
  },

  keys: {
    ranges: { day: 'd', week: 'w', month: 'm' },
    previous: 'v',
    current: { day: 't', week: 'h', month: 'h' },
    next: 'n',
    filters: { all: 'a', blocks: 'b', attempts: 'e', points: 'p', study: 'u' },
    exportEvents: 'x',
    exportDays: 'y',
    more: 's',
    empty: 'i',
    retry: 'r',
  },

  error: {
    text: 'I could not read your statistics',
    retry: 'Retry',
    retryHelp: 'Reads the log on this computer again',
  },
};
