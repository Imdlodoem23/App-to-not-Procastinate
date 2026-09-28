import type { Browser } from '../types';

/*
 * Web browsers the guardian recognises by process name (docs/ARCHITECTURE.md §9.3 and
 * §10.8): the loopback peer of an extension's pairing claim and heartbeats must be one of
 * them, and «Cerrar navegadores sin la extensión» closes the ones running without a
 * protecting extension.
 *
 * Process names follow the conventions of apps.ts (Windows image names with `.exe`,
 * macOS bundle executables, Linux executable base names). On macOS the extension's
 * requests leave from the browser's network helper (`<name> Helper`), so helpers are
 * listed next to the main executable; on Windows and Linux every Chromium process runs
 * under the main executable's name.
 *
 * - `family` is the engine: it decides which Céntrate extension build runs there
 *   (Chromium or Firefox) and Safari runs none.
 * - `extensionFamily` is the `browser` value (BrowserFamily) the Céntrate extension
 *   reports in that browser, so pairing binds to it and `browsersWithoutExtension` lists
 *   the browser under it. Browsers without a family of their own use the one their
 *   extension cannot tell apart from: Arc presents itself as Google Chrome, Opera GX as
 *   Opera and Yandex as plain Chromium. Safari, without an extension, is `other`.
 * - A process name may belong to several browsers of the same engine (Chromium runs as
 *   `chrome.exe` on Windows and as `chrome` in its Linux snap, like Google Chrome; Opera
 *   GX runs as `opera.exe`). A test checks that such browsers share `family`.
 *
 * Deliberate gaps:
 * - Yandex Browser on Windows runs as the generic `browser.exe`, which is not listed
 *   (closing that name could hit unrelated programs), so it can neither pair nor be closed
 *   there; the hosts file still applies.
 * - Arc's macOS helpers are not listed until their names are confirmed on a Mac.
 * - Edge WebView2 (`msedgewebview2.exe`) is not a browser: apps embed it.
 */
export const BROWSER_DATA: readonly Browser[] = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    family: 'chromium',
    extensionFamily: 'chrome',
    processes: {
      win: ['chrome.exe'],
      mac: [
        'Google Chrome',
        'Google Chrome Helper',
        'Google Chrome Beta',
        'Google Chrome Beta Helper',
        'Google Chrome Dev',
        'Google Chrome Dev Helper',
        'Google Chrome Canary',
        'Google Chrome Canary Helper',
      ],
      linux: ['chrome'],
    },
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    family: 'chromium',
    extensionFamily: 'edge',
    processes: {
      win: ['msedge.exe'],
      mac: [
        'Microsoft Edge',
        'Microsoft Edge Helper',
        'Microsoft Edge Beta',
        'Microsoft Edge Beta Helper',
        'Microsoft Edge Dev',
        'Microsoft Edge Dev Helper',
        'Microsoft Edge Canary',
        'Microsoft Edge Canary Helper',
      ],
      linux: ['msedge'],
    },
  },
  {
    id: 'brave',
    name: 'Brave',
    family: 'chromium',
    extensionFamily: 'brave',
    processes: {
      win: ['brave.exe'],
      mac: [
        'Brave Browser',
        'Brave Browser Helper',
        'Brave Browser Beta',
        'Brave Browser Beta Helper',
        'Brave Browser Nightly',
        'Brave Browser Nightly Helper',
      ],
      linux: ['brave'],
    },
  },
  {
    id: 'opera',
    name: 'Opera',
    family: 'chromium',
    extensionFamily: 'opera',
    processes: {
      win: ['opera.exe'],
      mac: ['Opera', 'Opera Helper'],
      linux: ['opera'],
    },
  },
  {
    id: 'opera-gx',
    name: 'Opera GX',
    family: 'chromium',
    extensionFamily: 'opera',
    processes: {
      win: ['opera.exe'],
      mac: ['Opera GX', 'Opera GX Helper'],
      linux: [],
    },
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    family: 'chromium',
    extensionFamily: 'vivaldi',
    processes: {
      win: ['vivaldi.exe'],
      mac: ['Vivaldi', 'Vivaldi Helper'],
      linux: ['vivaldi-bin'],
    },
  },
  {
    id: 'firefox',
    name: 'Firefox',
    family: 'firefox',
    extensionFamily: 'firefox',
    processes: {
      // Firefox, Developer Edition and Nightly share the executable name; the network
      // runs in the main process.
      win: ['firefox.exe'],
      mac: ['firefox'],
      linux: ['firefox', 'firefox-bin', 'firefox-esr'],
    },
  },
  {
    id: 'safari',
    name: 'Safari',
    family: 'safari',
    extensionFamily: 'other',
    processes: {
      win: [],
      mac: ['Safari', 'Safari Technology Preview'],
      linux: [],
    },
  },
  {
    id: 'arc',
    name: 'Arc',
    family: 'chromium',
    extensionFamily: 'chrome',
    processes: {
      win: ['Arc.exe'],
      mac: ['Arc'],
      linux: [],
    },
  },
  {
    id: 'chromium',
    name: 'Chromium',
    family: 'chromium',
    extensionFamily: 'chromium',
    processes: {
      win: ['chrome.exe'],
      mac: ['Chromium', 'Chromium Helper'],
      linux: ['chromium', 'chromium-browser', 'chrome'],
    },
  },
  {
    id: 'yandex',
    name: 'Yandex Browser',
    family: 'chromium',
    extensionFamily: 'chromium',
    processes: {
      win: [],
      mac: ['Yandex', 'Yandex Helper'],
      linux: ['yandex_browser'],
    },
  },
];
