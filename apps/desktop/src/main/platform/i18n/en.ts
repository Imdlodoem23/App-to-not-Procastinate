/** English copy of the platform services (same shape as `es.ts`). */
import type { PlatformMessages } from './es';

export const PLATFORM_EN: PlatformMessages = {
  osd: {
    extended: (added: string, clock: string): string => `+${added} · until ${clock}`,
    noBlock: 'No block to extend',
    extendRefused: 'That block cannot be extended',
    maxReached: '24 h in total at most',
    miniTimerShown: 'Mini timer',
    miniTimerHidden: 'Mini timer hidden',
    nuclearQuit: 'Nuclear in progress · use the emergency exit',
    awakeOn: (until: string | null): string => (until ? `Awake ${until}` : 'Awake'),
    awakeOff: 'No longer kept awake',
    awakeFailed: 'Keep awake could not be changed',
  },
  surfaceTitles: {
    miniTimer: 'Mini timer',
    nuclear: 'Céntrate · Punishment',
  },
  csv: {
    dialogTitle: 'Export CSV',
    filterName: 'CSV',
    names: { events: 'events', days: 'days' },
    events: ['date', 'type', 'points', 'target', 'minutes', 'mode'],
    days: ['day', 'study_minutes', 'block_minutes', 'attempts', 'points', 'goal_met'],
  },
};
