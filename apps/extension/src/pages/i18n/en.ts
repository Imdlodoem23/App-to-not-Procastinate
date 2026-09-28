/**
 * English strings of the extension pages (same shape as `es.ts`, `PagesMessages`). Same rules
 * as the Spanish (PROMPT §10): sentence case, typographic minus «−», humor only on the blocked
 * page, errors with an action and penalties as a plain fact. Browser labels are the browsers'
 * own English ones; numbers and times arrive formatted (`shared/format.ts`, en-US).
 */
import type { BrowserFamily } from '@centrate/shared/domain';
import type { HumorContext, IncognitoBrowser, PagesMessages } from './es';

/** Official downloads (GitHub Releases of the project). */
const RELEASES_URL = 'https://github.com/Imdlodoem23/App-to-not-Procastinate/releases/latest';

/** «incognito», «InPrivate», «private windows»: what each browser calls private windows. */
function privateName(family: BrowserFamily | null): string {
  switch (family) {
    case 'edge':
      return 'InPrivate';
    case 'firefox':
    case 'brave':
    case 'other':
    case null:
      return 'private windows';
    default:
      return 'incognito';
  }
}

/** A duration in words: «43 minutes», «1 hour and 5 minutes». */
function durationWords(hours: number, minutes: number): string {
  const parts: string[] = [];
  if (hours > 0) parts.push(hours === 1 ? '1 hour' : `${hours} hours`);
  if (minutes > 0 || hours === 0) parts.push(minutes === 1 ? '1 minute' : `${minutes} minutes`);
  return parts.join(' and ');
}

/** «Allow in Incognito» per browser, in the browsers' own English labels. */
const INCOGNITO_BROWSERS: readonly IncognitoBrowser[] = [
  {
    families: ['chrome', 'chromium'],
    name: 'Chrome',
    steps: 'chrome://extensions › Céntrate › Details › turn on “Allow in Incognito”.',
  },
  {
    families: ['edge'],
    name: 'Edge',
    steps: 'edge://extensions › Céntrate › Details › turn on “Allow in InPrivate”.',
  },
  {
    families: ['brave'],
    name: 'Brave',
    steps: 'brave://extensions › Céntrate › Details › turn on “Allow in Private”.',
  },
  {
    families: ['opera', 'vivaldi'],
    name: 'Opera and Vivaldi',
    steps: 'On the extensions page, find Céntrate and turn on the incognito permission.',
  },
  {
    families: ['firefox'],
    name: 'Firefox',
    steps: 'about:addons › Céntrate › “Run in Private Windows” › “Allow”.',
  },
];

export const PAGES_EN: PagesMessages = {
  appName: 'Céntrate',

  common: {
    modes: {
      normal: 'Normal',
      strict: 'Strict',
      hardcore: 'Hardcore',
      exam: 'Exam',
    },
    punishmentLevels: {
      distractions: 'all distractions',
      whitelist: 'allowlist only',
      nuclear: 'computer locked',
    },
    targets: {
      /** At the start of a line (a row): «Everything except the allowlist · Exam». */
      whitelistOnly: 'Everything except the allowlist',
      /** After «Block:» (a header): «Block: allowlist only · Exam». */
      whitelistShort: 'allowlist only',
      separator: ', ',
      more: (count: number): string => `+${count}`,
    },
    remaining: {
      /** «42 min left», «1 h 5 min left». */
      words: (_minutes: number, label: string): string => `${label} left`,
      /** «43 minutes left», «1 hour and 5 minutes left». */
      aria: (hours: number, minutes: number): string => `${durationWords(hours, minutes)} left`,
      announce: (minutes: number): string =>
        minutes === 1 ? '1 minute left' : `${minutes} minutes left`,
      ended: 'Block finished',
      prose: durationWords,
    },
    /** «until 5:42 PM», «until tomorrow 8:00 AM», «until 9/30 8:00 AM» (like the app). */
    until: {
      today: (time: string): string => `until ${time}`,
      tomorrow: (time: string): string => `until tomorrow ${time}`,
      date: (date: string, time: string): string => `until ${date} ${time}`,
    },
    points: {
      /** «−10 points», «1 point». */
      long: (amount: string, value: number): string =>
        Math.abs(value) === 1 ? `${amount} point` : `${amount} points`,
    },
    browserNames: {
      chrome: 'Chrome',
      edge: 'Edge',
      brave: 'Brave',
      opera: 'Opera',
      vivaldi: 'Vivaldi',
      chromium: 'Chromium',
      firefox: 'Firefox',
      other: 'Other browser',
    },
    guide: 'Open guide',
    guideHelp: 'Step by step: pairing, permissions, incognito and privacy',
    retry: 'Retry',
    retryHelp: 'Looks for the guardian again now',
    version: (version: string): string => `v${version}`,
    privateName,
  },

  status: {
    connected: 'Guardian connected',
    connecting: 'Connecting to the guardian…',
    unreachable: 'Guardian not responding',
    unauthorized: 'Pairing revoked',
    untrusted: 'Invalid answer from the guardian',
    error: 'Guardian error',
    notPaired: 'Not paired',
  },

  notices: {
    unauthorized: 'The guardian revoked this pairing: pair again with a new code.',
    host_permission_missing:
      'The browser does not let Céntrate access websites: nothing is blocked here right now.',
    guardian_unreachable: 'Guardian not responding: your blocks stay on until they end.',
    guardian_unreachable_empty:
      'Guardian not responding: open Céntrate on this computer to check that it is running.',
    untrusted_rules: 'The guardian sent an invalid answer: your blocks stay on until they end.',
    browser_mismatch: 'This pairing belongs to another browser: pair from here with a new code.',
    peer_not_browser: 'The guardian does not recognize this browser. See what to do in the guide.',
    origin_not_allowed:
      'The guardian does not recognize this extension: install it from the official package.',
    guardian_error: 'The guardian returned an error: your blocks stay on until they end.',
    /** «Nothing is blocked in incognito windows: allow the extension there.» */
    incognito_not_allowed: (family: BrowserFamily | null): string => {
      const name = privateName(family);
      const where = name === 'private windows' ? name : `${name} windows`;
      return `Nothing is blocked in ${where}: allow the extension there.`;
    },
    actions: {
      grant: 'Grant access',
      grantHelp: 'The browser will ask you for access to all websites',
      howTo: 'How to do it…',
      howToHelp: 'Opens the guide at this step',
      guide: 'Guide…',
    },
  },

  pairing: {
    title: 'Extension: not paired',
    titleAgain: 'Extension: pair again',
    intro: 'In Céntrate, open Settings… › System and press “New code”. Type the 6 digits here.',
    codeLabel: 'Pairing code',
    codePlaceholder: '6 digits',
    submit: 'Pair',
    submitting: 'Pairing…',
    portToggle: 'Other port…',
    portToggleHelp: 'Only if the app shows “Port: N”',
    portLabel: 'Port',
    success: 'Paired: it now enforces your blocks.',
    errors: {
      invalid_format: 'The code has 6 digits. Check it and try again.',
      code_invalid: 'That code is not valid. Check it in the app and type it again.',
      code_expired: 'The code has expired. Get another one in the app with “New code”.',
      no_code: 'The app has not created a code. Press “New code” in Settings… › System.',
      peer_not_browser:
        'The guardian did not recognize this browser. See “Troubleshooting” in the guide.',
      origin_not_allowed:
        'The guardian does not recognize this extension. Install it from the official package (see the guide).',
      rate_limited: 'Too many attempts. Wait a moment and try again.',
      unreachable:
        'The guardian cannot be found on this computer. Open Céntrate to check that it is running.',
      timeout: 'The guardian did not answer in time. Try again.',
      read_only:
        'The guardian is in safe mode and cannot pair right now. Open Céntrate and press Repair.',
      key_changed:
        'That code does not come from the guardian that signs your active blocks. You can pair with another one once they end.',
      guardian_elsewhere:
        'The guardian is still running on the paired port. Pair without changing the port.',
      unexpected: 'Something went wrong while pairing. Try again.',
    },
    rateLimitedFor: (seconds: number): string =>
      `Too many attempts. Wait ${seconds} s and try again.`,
    badPort: 'The port is a number between 1 and 65535.',
    extensionUnavailable: 'The extension is not answering. Close it and open it again.',
  },

  blocked: {
    documentTitle: (title: string): string => `${title} · Céntrate`,
    title: (name: string): string => `${name}: blocked`,
    titleUnknown: 'This site: blocked',
    unknownName: 'This site',
    unknownInlineName: 'this site',
    titleEnded: (name: string): string => `${name}: block finished`,
    titleEndedUnknown: 'This site: block finished',
    checking: 'Checking the time…',
    checkingLine: (inlineName: string): string =>
      `You can open ${inlineName} as soon as Céntrate confirms the time.`,
    reasonLabel: 'Your reason',
    sameAttempt: 'Same attempt: it was not charged again.',
    enforced: 'This tab was already open when the block started: it does not count as an attempt.',
    back: 'Back to my work',
    shortcuts: { back: 'B', open: 'O' },
    backHelpHistory: 'Goes back to the previous page',
    backHelpNewTab: 'Closes this page and opens a new tab',
    open: (name: string): string => `Open ${name}`,
    openHelp: 'Opens the page you were trying to see in this tab',
    endedLine: 'You can go back in now.',
    examLine: 'Exam mode: only what you allowed gets in here. Good luck.',
    whitelistLine: 'Only the sites on your list are open. Everything else can wait.',
    humor: [
      (c: HumorContext): string | null =>
        c.time === null ? null : `${c.name} will still be there in ${c.time}. Your deadline won’t.`,
      (c: HumorContext): string | null =>
        c.time === null ? null : `${c.name} can wait ${c.time}. Your work, not so much.`,
      (c: HumorContext): string | null =>
        c.time === null ? null : `Future you, ${c.time} from now, will thank you.`,
      (c: HumorContext): string => `${c.name} isn’t going anywhere. Your focus is.`,
      (c: HumorContext): string =>
        `No one has ever passed an exam thanks to ${c.inlineName}. As far as we know.`,
    ],
    framedLabel: 'Content blocked by Céntrate',
  },

  popup: {
    documentTitle: 'Céntrate',
    blockNone: 'Block: none',
    blockNoneHelp: 'Create blocks in the Céntrate app: they apply here on their own.',
    /** «Block: YouTube, Instagram · Strict». */
    block: (targets: string, mode: string): string => `Block: ${targets} · ${mode}`,
    /** «Penalty: all distractions». */
    punishment: (level: string): string => `Penalty: ${level}`,
    row: (targets: string, mode: string): string => `${targets} · ${mode}`,
    /** «Break: YouTube». */
    allowance: (name: string): string => `Break: ${name}`,
    more: (count: number): string => `and ${count} more`,
    blocksLabel: 'Active blocks',
    noticesLabel: 'Warnings',
    retrying: 'Retrying…',
    /** «checked at 5:42 PM». */
    checkedAt: (time: string): string => `checked at ${time}`,
    retryStill: (unreachable: boolean, checked: string): string =>
      `${unreachable ? 'Still not responding' : 'Still failing'} · ${checked}`,
    footerChecked: (line: string, checked: string): string => `${line} · ${checked}`,
  },

  guide: {
    documentTitle: 'Extension guide · Céntrate',
    title: 'Extension guide',
    intro:
      'The extension enforces in the browser the same blocks Céntrate enforces on the rest of the computer. It needs to be paired with the guardian and allowed to see which websites you visit.',
    tocLabel: 'In this guide',
    toc: {
      pairing: 'Pairing',
      'host-permission': 'Site access',
      incognito: 'Incognito',
      chromium: 'Chrome, Edge and Brave',
      firefox: 'Firefox',
      privacy: 'Privacy',
      troubleshooting: 'Troubleshooting',
    },
    yourBrowser: 'your browser',
    /** «today at 5:42 PM». */
    whenToday: (time: string): string => `today at ${time}`,
    /** «on 9/28 at 5:42 PM». */
    whenDate: (date: string, time: string): string => `on ${date} at ${time}`,
    releasesUrl: RELEASES_URL,
    releasesLink: 'Céntrate downloads on GitHub',
    pairing: {
      title: 'Pairing',
      done: 'Pairing: done',
      pending: 'Pairing: pending',
      steps: [
        'Install Céntrate on this computer and open it.',
        'In Céntrate, open Settings… › System and press “New code”. You will see 6 digits that expire after 5 minutes.',
        'Type them below or in the extension window (the Céntrate icon in the browser toolbar).',
      ],
      note: 'If the app shows “Port: N”, press “Other port…” and type it too. Pairing again never shortens a running block.',
      /** «Paired with guardian 0.1.0 on 9/28 at 5:42 PM». */
      pairedWith: (version: string, when: string): string =>
        `Paired with guardian ${version} ${when}.`,
      again: 'Pair again…',
    },
    chromium: {
      title: 'Install in Chrome, Edge and Brave',
      steps: [
        'Download Centrate-extension.zip from the latest release and unzip it into a folder you will not delete.',
        'Open the extensions page: chrome://extensions in Chrome, edge://extensions in Edge or brave://extensions in Brave.',
        'Turn on “Developer mode” (top right; in Edge, in the left panel).',
        'Press “Load unpacked” and choose the folder you unzipped.',
        'Pin Céntrate to the toolbar (the puzzle piece icon) and pair it with the code.',
      ],
      notes: [
        'The browser may warn you that you have extensions in developer mode: that is normal, do not turn it off.',
        'To update it, replace the files in the folder and press the reload button (↻) on the Céntrate card. The pairing is kept.',
      ],
    },
    firefox: {
      title: 'Install in Firefox',
      steps: [
        'You need Firefox 128 or later.',
        'Download the .xpi file from the latest release.',
        'In Firefox, open about:addons, press ⚙ › “Install Add-on From File…” and choose the .xpi (or drag it onto the Firefox window).',
        'Press “Add”. If access to all websites is missing afterwards, grant it as explained in “Site access”, above.',
        'Pair it with the code.',
      ],
      notes: [
        'The .xpi is signed by Mozilla, so Firefox keeps it after a restart.',
        'To update it, install the new .xpi the same way. The pairing is kept.',
        'If the release has no .xpi: download Centrate-extension-firefox.zip (the Firefox one, not the Chrome one), unzip it and, in about:debugging › This Firefox, press “Load Temporary Add-on…” and choose the manifest.json in that folder.',
        'A temporary add-on disappears when Firefox closes: you will have to load it again every time you open Firefox. After loading it, open about:addons › Céntrate and set “Run in Private Windows” to “Allow”.',
      ],
    },
    hostPermission: {
      title: 'Site access',
      granted: 'Site access: granted',
      missing: 'Site access: missing',
      body: 'To redirect blocked websites, the extension needs access to all websites. Without it, the browser enforces no block and gives no warning.',
      grant: 'Grant access',
      grantHelp: 'The browser will ask you for access to all websites',
      manual: 'If the browser does not ask you, grant it by hand:',
      firefoxSteps: [
        'Open about:addons and go to Céntrate.',
        'In the “Permissions” tab, turn on “Access your data for all websites”.',
      ],
      chromiumSteps: [
        'Open the extensions page and press “Details” on Céntrate.',
        'Under “Site access”, choose “On all sites”.',
      ],
    },
    incognito: {
      title: 'Incognito and private windows',
      /** «Incognito: allowed», «InPrivate: not allowed», «Private windows: allowed». */
      state: (family: BrowserFamily | null, allowed: boolean): string => {
        const name = privateName(family);
        const label = name.charAt(0).toUpperCase() + name.slice(1);
        return `${label}: ${allowed ? 'allowed' : 'not allowed'}`;
      },
      body: 'Browsers keep extensions out of private windows until you allow them in. Until you do, nothing is blocked there.',
      browsers: INCOGNITO_BROWSERS,
    },
    privacy: {
      title: 'Privacy: what the extension sees',
      points: [
        'It looks at the address of every page you open to compare it with your blocks. That check happens inside the browser.',
        'It never sends your browsing history.',
        'Only when you try to open something blocked, it sends the domain (for example, youtube.com, never the full address) to the Céntrate guardian, which runs on your own computer, to take off the points for the attempt.',
        'Every 30 seconds it tells the guardian it is still active: the browser and extension versions and whether it has its permissions. Nothing about your websites.',
        'It keeps the pairing and the latest list of blocks in the browser, to keep blocking even if the guardian does not respond. The address of a blocked page only stays in the session memory and is erased when the browser closes.',
        'There are no analytics and no Céntrate servers: nothing leaves your computer.',
      ],
    },
    troubleshooting: {
      title: 'Troubleshooting',
      items: [
        {
          term: 'Guardian not responding',
          detail:
            'Open Céntrate: if the guardian is stopped, press Repair. Meanwhile, the extension keeps the blocks it already had until they end.',
        },
        {
          term: 'Invalid or expired code',
          detail:
            'Get another one with “New code” and type it within 5 minutes. After 5 wrong tries, the code stops working.',
        },
        {
          term: 'The guardian does not recognize this extension',
          detail:
            'In Chrome, Edge and Brave the guardian only accepts the official extension. Install it from Centrate-extension.zip in the latest release.',
        },
        {
          term: 'The guardian does not recognize this browser',
          detail:
            'The guardian checks that whatever pairs is a browser. If you use an uncommon browser or a proxy on this computer, try Chrome, Edge, Brave or Firefox.',
        },
        {
          term: 'Pairing from another browser',
          detail: 'Each browser pairs separately: pair this one with a new code.',
        },
        {
          term: 'Nothing is blocked',
          detail:
            'Check site access (above), that the extension is turned on and, in private windows, that it is allowed.',
        },
      ],
      diagnosticsLabel: 'Details for getting help',
      diagnostics: {
        version: 'Extension version',
        browser: 'Browser',
        id: 'Extension ID',
        status: 'Status',
        lastSync: 'Last sync',
        never: 'Never',
      },
    },
  },
};
