/**
 * English strings the footer added in Phase 5 (same shape as `es.ts`, `FooterMessages`).
 */
import type { FooterMessages } from './es';

export const FOOTER_EN: FooterMessages = {
  downloading: (version: string, percent: string): string =>
    `Downloading v${version} · ${percent}%`,
  downloadingStart: (version: string): string => `Downloading v${version}…`,
  awake: {
    error: 'Awake: error',
    help: 'Change how long, or turn it off',
    failed: 'Keep awake could not be changed',
  },
  result: {
    restarting: 'Restarting to update. Your blocks stay active',
    downloadPage: 'I opened the download page of the new version',
    failed: 'The update could not be downloaded',
    unsupported: 'This install does not update itself: download it from the website',
  },
};
