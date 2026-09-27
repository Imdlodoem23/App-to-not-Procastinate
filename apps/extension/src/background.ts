// Background service worker: syncs the active block list from the guardian.
export const GUARDIAN_ORIGIN = 'http://127.0.0.1:47600';

chrome.runtime.onInstalled.addListener(() => {
  console.info('Céntrate extension installed');
});
