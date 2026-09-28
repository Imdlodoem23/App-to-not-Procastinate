/** English strings of the tray and the main window title (same shape as `es.ts`). */
import type { TrayMessages } from './es';

export const TRAY_EN: TrayMessages = {
  appName: 'Céntrate',
  separator: ' · ',
  tooltip: {
    noBlocks: 'no blocks',
    punishment: 'penalty',
    blocks: (count: number): string => `${count} blocks`,
    checkingClock: 'checking the time',
    studying: 'studying',
  },
  linkDown: {
    not_installed: 'guardian not installed',
    unreachable: 'guardian stopped',
    timeout: 'guardian stopped',
    unauthorized: 'update the guardian',
    incompatible: 'update the guardian',
  },
  title: {
    punishment: (duration: string): string => `penalty ${duration}`,
    studying: 'studying',
    checkingClock: 'checking the time',
  },
  menu: {
    status: {
      noBlocks: 'No blocks',
      connecting: 'Connecting to the guardian…',
      checkingClock: 'Checking the time…',
      punishment: 'Penalty',
      blocks: (count: number): string => `${count} blocks`,
    },
    extend: 'Extend',
    extendItem: (label: string): string => `+${label}`,
    quick: 'Quick block',
    open: 'Open Céntrate',
    quit: 'Quit (blocks stay active)',
  },
};
