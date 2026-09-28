/**
 * Every user-facing string of the website in English (en-US): the translation of copy.ts, with
 * exactly its shape (type `Copy`, and translationProblems() at build time). Keep both in sync.
 *
 * Conventions, the English side of the ones in copy.ts:
 * - Sentence case. Headlines end with a period; labels do not.
 * - Typographic minus «−» for negative points, curly quotes “ ”, ellipsis «…», 12-hour clock
 *   («5:42 PM»), en-US numbers («1,240»). A number and its unit are joined by a no-break space.
 * - The phrases Céntrate reads (demo examples, the phrase typed in the window mock) stay in
 *   Spanish: the parser understands Spanish today, and the page says so instead of pretending.
 *   An English gloss follows them where it helps.
 * - Same tone as the Spanish: calm and precise, humor only on the blocked page and empty
 *   states, penalties stated as data, never as guilt.
 */
import type { Copy } from './copy';

const ids = {
  highlights: 'features',
  demo: 'try-it',
  scene: 'guardian',
  block: 'blocking',
  study: 'study-mode',
  progress: 'progress',
  privacy: 'privacy',
  numbers: 'numbers',
  more: 'more-features',
  faq: 'faq',
  download: 'download',
  footnotes: 'notes',
} as const;

/** Footnotes of the home page, in the order of copy.ts. */
const notes = {
  admin:
    'On a computer you are an administrator of, no block is 100\u00a0% impossible to get around. Céntrate makes it as hard as it can, without hiding and without ever stopping you from uninstalling it.',
  attempts:
    'If you try again within 5\u00a0minutes, the penalty doubles (−10, −20, −40…) up to −80\u00a0points per attempt. If several layers catch the same service at once, or it comes back within 30\u00a0seconds, it counts as one attempt. Your balance can go below zero.',
  webcam:
    'Study Mode with the camera needs a webcam. Without one you can use Study Mode without the camera, which only looks at the app or website in front of you and at your keyboard and mouse activity.',
  blockedPage:
    'The blocked page, with your reason and the points you lose, needs the Céntrate extension for Chrome, Edge, Brave or Firefox. Without it, the guardian still blocks across the whole system, but the browser will only tell you the site does not load.',
  emergency:
    'An emergency unlock costs 200\u00a0points or half your balance, whichever is higher, plus your streak. You can cancel the wait. It does not exist in Hardcore or in exam mode.',
  punishment:
    'The punishment lasts 60\u00a0minutes by default (15 to 120 in Settings) and blocks all your distractions; if you want, you can make it stricter and allow only your study sites. It takes 100\u00a0points when it starts, and each strike takes 15. Pomodoro breaks and pauses do not count.',
  rewards:
    'Reward shop prices are an example. Earned breaks cannot be redeemed during a Hardcore block, exam mode or a punishment.',
  unsigned:
    'The installers are not signed with a certificate yet, so Windows and macOS show a warning the first time. The install guide explains how to open them and how to check their SHA-256.',
} as const;

export const en: Copy = {
  ids,

  ui: {
    skipLink: 'Skip to content',
    pause: 'Pause',
    play: 'Play',
    replay: 'Replay',
    pauseVideo: 'Pause the video',
    playVideo: 'Play the video',
    replayVideo: 'Replay the video',
    prev: 'Previous card',
    next: 'Next card',
    gallery: 'Gallery: {name}',
    cardPosition: 'Card {n} of {total}',
    copy: 'Copy',
    copied: 'Copied',
    copyAria: 'Copy {what}',
    footnoteRef: 'Note {n}',
    footnoteBack: 'Back to the text',
    version: 'Version {version}',
    versionFallback: 'Latest version',
    published: 'Released {date}',
    size: 'Size',
    notAvailable: 'Not available',
    duration: {
      minutes: '{m}\u00a0min',
      hours: '{h}\u00a0h',
      hoursMinutes: '{h}\u00a0h {m}\u00a0min',
    },
  },

  nav: {
    ariaLabel: 'Main',
    brand: 'Céntrate',
    brandAria: 'Céntrate, go to the home page',
    links: [
      { label: 'Features', href: `/en#${ids.highlights}` },
      { label: 'Study Mode', href: `/en#${ids.study}` },
      { label: 'Privacy', href: `/en#${ids.privacy}` },
    ],
    cta: 'Download',
    ctaAria: 'Download Céntrate',
    menuOpen: 'Open menu',
    menuClose: 'Close menu',
  },

  language: {
    hint: {
      text: 'View this page in English',
      dismiss: 'Dismiss',
      dismissAria: 'Dismiss the language suggestion',
    },
  },

  hero: {
    eyebrow: 'Céntrate',
    headline: 'Type it. Forget it.',
    lead: 'Type what you want to avoid and for how long, and Céntrate blocks it, even if you close the app.',
    cta: {
      windows: {
        label: 'Download free for Windows',
        note: 'Free, no account. Windows 10 and 11.',
      },
      mac: {
        label: 'Download free for macOS',
        note: 'Free, no account. Apple Silicon and Intel.',
      },
      linux: {
        label: 'Download free for Linux',
        note: 'Free, no account. .deb package for Ubuntu and Debian.',
      },
      other: {
        label: 'See the downloads',
        note: 'Céntrate is for computers: Windows, macOS and Linux.',
      },
    },
    otherSystems: { label: 'Other systems', href: '/en/download' },
    visualAria:
      'The Céntrate window: in the “What do you want to do?” field someone types “no veo YouTube en una hora” (Spanish for “no YouTube for an hour”), confirms with Enter and a one-hour countdown starts.',
  },

  highlights: {
    id: ids.highlights,
    headline: 'The highlights.',
    pause: 'Pause',
    resume: 'Resume',
    pauseAria: 'Pause autoplay',
    resumeAria: 'Resume autoplay',
    cards: [
      {
        title: 'Type it and you’re done.',
        text: 'Type “no veo YouTube en una hora” (no YouTube for an hour) and press Enter twice: once to review it, once to block. Céntrate reads Spanish phrases for now.',
      },
      {
        title: 'Still blocked when you close the app.',
        text: 'Close it, end it from Task Manager or restart your computer: the block lasts to the very last minute.',
        note: 'admin',
      },
      {
        title: 'Every attempt costs you 10\u00a0points.',
        text: 'You never get in. And if you try again within 5\u00a0minutes, the next one costs double.',
        note: 'attempts',
      },
      {
        title: 'Study Mode sees you study.',
        text: 'An AI that runs on your computer notices when you pick up your phone or walk away, and before anything else it asks if you’re still there.',
        note: 'webcam',
        dark: true,
      },
    ],
  },

  demo: {
    id: ids.demo,
    headline: 'Try it without installing anything.',
    lead: 'Type what you want to avoid, the way you’d say it, and see what Céntrate would do.',
    languageNote:
      'The app understands Spanish phrases today; English phrases are coming. Try one of the examples below.',
    label: 'What do you want to do?',
    inputHint: 'For example, “no veo YouTube en una hora”.',
    clear: 'Clear',
    examplesLabel: 'Try',
    // Parser input: the same Spanish phrases as copy.ts, with plain spaces.
    examples: [
      'no veo YouTube en una hora',
      'nada de TikTok ni Instagram durante 45 minutos',
      'bloquea las redes sociales hasta las 20:30',
      'sin juegos hora y media',
      'no quiero ver Netflix 2h',
      'estudiar mates 1 hora',
      'sin insta media hora',
      'nada de Discord hasta mañana a las 8',
      'no veo series 1h30',
    ],
    result: {
      title: 'What Céntrate would do',
      block: 'Céntrate would block {services} for {duration}, until {time}.',
      blockUntil: 'Céntrate would block {services} until {time} ({duration}).',
      category: 'the whole {category} category',
      mode: 'In Normal mode: after that you could only extend it, never shorten it.',
      study: 'Céntrate would suggest a {duration} Study Mode session for “{task}”.',
      studyNoTask: 'Céntrate would suggest a {duration} Study Mode session.',
      over4h: 'That’s more than 4\u00a0hours: the app would ask you to confirm twice.',
      over24h: 'A block can last 24\u00a0hours at most.',
      partial:
        'I understood {understood}, but not “{rest}”. The app would open the advanced form with that already filled in.',
      none: 'I didn’t understand “{text}”. The app wouldn’t make anything up: it would open the advanced form so you can choose.',
      tryHint:
        'Try a service and a time, like “no quiero ver Netflix 2h” (no Netflix for 2 hours).',
      empty: 'Type a phrase or pick an example.',
      restSeparator: '”, “',
      untilToday: 'until {time}',
      untilTomorrow: 'until tomorrow {time}',
      untilDate: 'until {date} {time}',
      endsToday: '{time}',
      endsTomorrow: 'tomorrow {time}',
      endsDate: '{date} {time}',
      categoryNames: {
        social: 'Social media',
        video: 'Video and streaming',
        games: 'Games',
        messaging: 'Messaging',
        shopping: 'Shopping',
        news: 'News and sports',
      },
      fields: {
        what: 'Blocked',
        duration: 'Duration',
        ends: 'Ends at',
        mode: 'Mode',
      },
      defaultMode: 'Normal',
    },
    note: 'This is a demo: nothing gets blocked here. It reads phrases exactly like the app does, and what you type never leaves this page.',
  },

  scene: {
    id: ids.scene,
    headline: { lead: 'Close it.', gradient: 'It keeps working.' },
    lead: 'Blocks are enforced by the guardian, a small system service that Céntrate installs. It works with the app closed, after a restart and even if you change the clock, and it lets go on its own when time is up.',
    leadNote: 'admin',
    beats: [
      {
        title: 'You close Céntrate.',
        text: 'With the X, with “Quit” or from Task Manager. The window goes away; the block doesn’t.',
      },
      {
        title: 'You open youtube.com.',
        text: 'Out of habit, almost without thinking.',
      },
      {
        title: 'It doesn’t load. And it costs you 10\u00a0points.',
        text: 'Instead you see your reason, “I want to pass math”, and what the attempt cost you.',
        note: 'blockedPage',
      },
    ],
    browser: {
      address: 'youtube.com',
      tabLoading: 'youtube.com',
      tabBlocked: 'Blocked · Céntrate',
    },
    summary:
      'Animation in three steps: the Céntrate window closes, a browser tries to open youtube.com and, instead, the Céntrate blocked page appears with the reason “I want to pass math” and −10\u00a0points.',
  },

  chapters: {
    block: {
      id: ids.block,
      eyebrow: 'Blocking',
      headline: 'You write the phrase. Céntrate sets the limit.',
      lead: 'Type “nada de TikTok ni Instagram durante 45 minutos” (no TikTok or Instagram for 45 minutes) and Céntrate works out what to block, for how long and until when. You confirm with Enter and, from then on, it can only be extended.',
      cards: [
        {
          title: 'Type the way you talk.',
          text: 'It gets “yt”, “insta”, “hora y media” or “hasta mañana a las 8”, no internet needed. Spanish only for now; English is on the way.',
          visual: 'typing',
        },
        {
          title: 'You confirm.',
          text: 'A card shows what gets blocked, how long it lasts and when it ends, and it never makes up what it didn’t understand.',
          visual: 'confirm',
        },
        {
          title: 'Websites and apps at once.',
          text: 'It blocks websites in the browser and closes apps like Steam, Discord or Roblox if you try to open them.',
        },
        {
          title: 'It can only be extended.',
          text: 'Add 15\u00a0minutes, half an hour or an hour with one click; there is no button to shorten it.',
          visual: 'countdown',
        },
        {
          title: 'Leaving early has a price.',
          text: 'You type a commitment phrase by hand, wait 10\u00a0minutes (30 in Strict) and lose at least 200\u00a0points and your streak; in Hardcore, there is no way out.',
          note: 'emergency',
        },
      ],
    },
    study: {
      id: ids.study,
      eyebrow: 'Study Mode',
      headline: 'Looking at your notebook is studying. Your phone isn’t.',
      lead: 'Say what you’re going to study and turn on the camera. An AI that runs on your computer checks whether you’re studying: if not, it warns you, and if you still aren’t, it blocks your distractions for an hour.',
      leadNote: 'webcam',
      cards: [
        {
          title: 'Made to fit you.',
          text: 'A calibration of about 2\u00a0minutes teaches it how you study: looking at the screen, with a book or with a notebook.',
        },
        {
          title: 'It asks first.',
          text: 'If you drift off for 15\u00a0seconds, it asks “Still there?”, and if you stay that way for 30\u00a0seconds more, it’s a strike and you lose 15\u00a0points.',
          visual: 'study',
        },
        {
          title: 'It learns from its mistakes.',
          text: 'If it warns you for no reason, press “I was studying!” and it will take that into account next time.',
        },
        {
          title: 'Three strikes, one hour without distractions.',
          text: 'On the third strike, the guardian blocks your distractions for 60\u00a0minutes, even if you close the app.',
          note: 'punishment',
        },
        {
          title: 'Also without a camera.',
          text: 'If you don’t have a camera or would rather not use it, Study Mode looks at the app in front of you and at your keyboard and mouse activity.',
        },
      ],
    },
    progress: {
      id: ids.progress,
      eyebrow: 'Progress',
      headline: 'Every minute adds up. Every attempt takes away.',
      lead: 'Points come from what really happens: the minutes you keep add up, and attempts and strikes take away. Spend them on breaks, look after your streak and watch your pet grow.',
      cards: [
        {
          title: 'How you earn them.',
          text: '+1\u00a0point per minute of a block you kept, +2 per focused minute in Study Mode and +20 if you finish a session without a single attempt.',
          visual: 'progress',
        },
        {
          title: 'Earned breaks.',
          text: 'Trade your points for free time with no penalty, like 15\u00a0minutes of YouTube for 150\u00a0points.',
          note: 'rewards',
        },
        {
          title: 'A streak to look after.',
          text: 'Every day you reach your goal, 60\u00a0focused minutes unless you change it, your streak grows by a day.',
        },
        {
          title: 'A pet that grows with you.',
          text: 'It goes from sprout to plant and from plant to tree while you focus, and it wilts if you give up.',
        },
        {
          title: 'Points nobody can touch.',
          text: 'They come from the guardian’s log, cannot be edited anywhere and your balance can go into the red.',
        },
      ],
    },
  },

  privacy: {
    id: ids.privacy,
    headline: 'Your camera never leaves your computer.',
    body: [
      'Study Mode analyzes the image on your computer, a few times per second and at low resolution, and throws it away right away. It doesn’t know who you are: only whether someone is there, where they are looking and whether there is a phone or a book.',
      'The camera only turns on when you start a session, and while it’s on you always see the “Camera on” indicator. And since the code is open source, anyone can check.',
    ],
    points: [
      {
        title: 'No image is ever saved.',
        text: 'No photos, no video: only numbers, like the minutes you stayed focused.',
      },
      {
        title: 'Everything is processed on your computer.',
        text: 'The AI ships inside the app and works without internet.',
      },
      {
        title: 'No account and no tracking cookies.',
        text: 'Not in the app, not on this website.',
      },
    ],
    link: { label: 'Read the privacy policy', href: '/en/privacy' },
  },

  numbers: {
    id: ids.numbers,
    ariaLabel: 'Céntrate in numbers',
    items: [
      {
        headline: '−10\u00a0points for every attempt.',
        text: 'Try again within 5\u00a0minutes and it doubles: −20, −40, up to −80.',
        note: 'attempts',
      },
      {
        headline: '60\u00a0minutes of punishment if you don’t study.',
        text: 'On the third strike of a session, the guardian blocks your distractions for an hour. Closing the app doesn’t lift it.',
        note: 'punishment',
      },
      {
        headline: '+2\u00a0points for every focused minute.',
        text: 'Twice as much as a minute of blocking. Study for 75\u00a0minutes and you’ve earned 15 of YouTube.',
        note: 'rewards',
      },
    ],
  },

  more: {
    id: ids.more,
    headline: 'And much more.',
    items: [
      {
        name: 'Pomodoro',
        text: '25/5, 50/10 or your own, and the camera doesn’t watch during breaks.',
      },
      {
        name: 'Schedules',
        text: 'Blocks that repeat on their own, like social media Monday to Friday from 4:00 to 7:00\u00a0PM.',
      },
      {
        name: 'Exam mode',
        text: 'Only your study sites, with no way to cancel until the time you choose.',
      },
      {
        name: 'Statistics',
        text: 'Your focused time by day, week and month, with a heat map and CSV export.',
      },
      {
        name: 'Sounds',
        text: 'Rain, white noise or lo-fi, built into the app and without internet.',
      },
      {
        name: 'Mini timer',
        text: 'A small, always-visible countdown you can place wherever you like.',
      },
      {
        name: 'Browser extension',
        text: 'For Chrome, Edge, Brave and Firefox: it blocks instantly and shows you your reason.',
      },
      {
        name: 'Your reason',
        text: 'A sentence of your own, like “I want to pass math”, that shows up right when you try to get in.',
      },
      {
        name: 'Reminders',
        text: '“Time to study” based on your schedules, and eye breaks with the 20-20-20 rule.',
      },
      {
        name: 'Achievements',
        text: 'Your first session, a 7\u00a0day streak, 10\u00a0hours of Study Mode, a week without attempts…',
      },
    ],
    spare: [
      {
        name: 'Quick templates',
        text: 'Homework 1\u00a0h, Exam 3\u00a0h or Read 30\u00a0min: one click and Enter.',
      },
      {
        name: 'Session tasks',
        text: 'Write down what you’re going to do and, when you finish, say whether you did it.',
      },
    ],
  },

  faq: {
    id: ids.faq,
    headline: 'Frequently asked questions.',
    items: [
      {
        q: 'Is Céntrate free?',
        a: 'Yes, completely: no ads, no account and no paid version. It’s open source under the MIT license, and you can read all the code on GitHub.',
      },
      {
        q: 'Can a block be bypassed?',
        a: 'Closing the app, ending it from Task Manager, restarting or changing your computer’s clock won’t lift it. Still, let’s be clear: on a computer you are an administrator of, no block is 100\u00a0% impossible to get around. Céntrate makes it hard and charges you for every attempt, because it’s built to help you, not to lock anyone in.',
      },
      {
        q: 'What if I really need to get in?',
        a: 'In Normal and Strict you have the emergency unlock: you type “I accept breaking my commitment and losing my points” by hand, wait 10\u00a0minutes (30 in Strict) and lose 200\u00a0points or half your balance, whichever is more, plus your streak. In Hardcore and exam mode there is no way to cancel, and Céntrate tells you so before you confirm.',
      },
      {
        q: 'Does the camera record or send anything?',
        a: 'No. It only turns on when you start Study Mode, and while it’s on you always see the “Camera on” indicator. Images are analyzed on your computer and thrown away right away: none is saved, uploaded or leaves the device. If you’d rather not use it, there is a Study Mode without the camera.',
      },
      {
        q: 'What if I cover the camera or close the app in the middle of Study Mode?',
        a: 'Covering the camera counts as not being there, and after a minute it adds a strike. If you force-quit the app, after 2\u00a0minutes it counts as giving up and the punishment starts. Pomodoro breaks and pauses don’t count.',
      },
      {
        q: 'Does it work offline?',
        a: 'Yes. Blocks, points and Study Mode work without a connection, because the AI ships inside the app. When there is internet, Céntrate only uses it to check GitHub for updates and to make sure nobody has moved the clock forward.',
      },
      {
        q: 'Why does it ask for administrator permission?',
        a: 'To install the guardian, the system service that keeps blocks running with the app closed. It asks only once, and the guardian only touches the hosts file, the apps on your list and its own folder.',
      },
      {
        q: 'Do I need the extension? Does it work in incognito?',
        a: 'The extension blocks instantly in Chrome, Edge, Brave and Firefox, and shows you the blocked page with your reason. Without it, the guardian still blocks across the whole system, but a site that was already open may take a while to cut off. In incognito it only works if you allow it in the extension’s settings; Céntrate detects this and explains how.',
      },
      {
        q: 'Windows or macOS warns me when I open it. Is that normal?',
        a: 'Yes. The installers are not signed with a certificate yet, which costs money every year, so the system doesn’t recognize the author. On Windows, click “More info” and then “Run anyway”. On macOS, go to System Settings → Privacy & Security and click “Open Anyway”. If you like, [check its SHA-256 first](/en/download#sha256).',
      },
      {
        q: 'Why does my antivirus warn about the hosts file?',
        a: 'Because Céntrate blocks websites by writing to that file, always inside its own section and after making a backup, and some antivirus programs watch it. If yours stops it, allow the change for Céntrate: [the steps are in the guide](/en/download#antivirus).',
      },
      {
        q: 'Does it work as parental control?',
        a: 'It isn’t made for that. Céntrate helps people who want to focus: it doesn’t hide, its icon is always in the tray and it can be uninstalled whenever you want. If your child is going to use it, the best way is to install it together and let them choose their own blocks.',
      },
      {
        q: 'How do I uninstall it?',
        a: 'Like any other program, whenever you want, even with a block running: in that case, it warns you first that you’ll lose your points and your streak. Uninstalling removes the guardian, its lines in the hosts file and everything it installed. [Steps for each system](/en/download#uninstall).',
      },
    ],
  },

  download: {
    id: ids.download,
    headline: 'Céntrate is free.',
    lead: 'No account, no ads, and open source.',
    buttons: {
      windows: { label: 'Download for Windows', file: 'Centrate-Setup.exe' },
      mac: { label: 'Download for macOS', file: 'Centrate.dmg' },
      deb: { label: 'Download for Linux (.deb)', file: 'Centrate.deb' },
      appImage: { label: 'Download for Linux (AppImage)', file: 'Centrate.AppImage' },
    },
    extension: {
      label: 'Extension for Chrome, Edge and Brave',
      file: 'Centrate-extension.zip',
    },
    requirementsTitle: 'Requirements',
    requirements: [
      '64-bit Windows 10 or 11.',
      'macOS 12 or later, on Apple Silicon or Intel.',
      '64-bit Ubuntu or Debian (.deb), or another 64-bit distribution (AppImage).',
      'Administrator permission once, to install the guardian.',
      'Chrome, Edge, Brave or Firefox, for the extension.',
      'A webcam, only for Study Mode with the camera.',
    ],
    unsigned: {
      text: 'Windows and macOS will show a warning the first time you open it.',
      note: 'unsigned',
    },
    guide: { label: 'Install guide', href: '/en/download' },
    changelog: { label: 'What’s new', href: '/en/changelog' },
  },

  footnotes: {
    id: ids.footnotes,
    title: 'Notes',
    items: notes,
  },

  footer: {
    links: {
      download: { label: 'Download', href: '/en/download' },
      changelog: { label: 'What’s new', href: '/en/changelog' },
      privacy: { label: 'Privacy', href: '/en/privacy' },
      source: { label: 'Source code' },
      issues: { label: 'Report a problem' },
    },
    license: 'Céntrate is free software under the MIT license.',
    cookies: 'This website uses no cookies.',
    trademarks:
      'YouTube, Windows, macOS and the other trademarks mentioned belong to their owners. Céntrate is not affiliated with any of them.',
    copyright: '© 2026 Imdlodoem23 and Céntrate contributors.',
  },

  /**
   * The Céntrate window mock, in English. Same sample data as copy.ts: the block was
   * confirmed at 4:42 PM for 1\u00a0h. The typed phrase stays in Spanish (the parser's language).
   */
  appWindow: {
    title: {
      idle: 'Céntrate',
      blocked: 'Céntrate · 42\u00a0min left',
      study: 'Céntrate · studying',
    },
    block: {
      idleHeader: 'Block: none',
      idleMeta: 'Next schedule: 4:00\u00a0PM',
      field: 'What do you want to do?',
      typed: 'no veo YouTube en una hora',
      chips: ['YouTube', '1\u00a0h', 'until 5:42\u00a0PM'],
      templates: ['Homework 1\u00a0h', 'Exam 3\u00a0h', 'Read 30\u00a0min', 'More…'],
      idleHelp: 'Type what you want to avoid and press Enter.',
      confirm: {
        what: 'YouTube',
        duration: '1\u00a0h',
        ends: 'ends at 5:42\u00a0PM',
        modes: ['Normal', 'Strict', 'Hardcore', 'Exam'],
        selectedMode: 'Normal',
        help: 'Normal: an emergency unlock takes 10\u00a0min and costs at least 200\u00a0points',
        motiveLabel: 'Your reason',
        motive: 'I want to pass math',
        reminder: 'It can only be extended, never shortened',
        edit: 'Edit…',
        submit: 'Block until 5:42\u00a0PM',
      },
      activeHeader: 'Block: YouTube · Normal',
      activeMeta: 'until 5:42\u00a0PM',
      newPill: 'New',
      countdown: { minutes: '42', seconds: ':18' },
      countdownAria: '42\u00a0minutes left',
      motive: 'I want to pass math',
      extend: ['+15\u00a0min', '+30\u00a0min', '+1\u00a0h', 'Other…'],
      emergency: 'Emergency unlock…',
      folded: 'Block: YouTube · 42\u00a0min',
    },
    study: {
      readyHeader: 'Study Mode: ready',
      readyMeta: 'With camera · calibrated',
      presets: ['25/5', '50/10', '1\u00a0h', 'More…'],
      activeHeader: 'Study Mode: history · 32:10',
      cameraPill: 'Camera on',
      meter: 'Focused',
      strikesAria: 'Strikes: 0 of 3',
      tiles: ['Pause (2)', 'Sound: Rain', 'Preview', 'Finish'],
    },
    progress: {
      header: 'Level 7 · 1,240\u00a0points',
      meta: 'Streak: 5\u00a0days',
      goal: 'Today: 42 of 60\u00a0min',
      tiles: ['Statistics…', 'Rewards…', 'Achievements…'],
    },
    footer: {
      guardian: 'Guardian active',
      extension: 'Extension connected',
      version: 'v{version}',
      buttons: ['Mini timer', 'Settings…', 'Quit'],
    },
    blockedPage: {
      header: 'YouTube: blocked',
      meta: '42\u00a0min left',
      motive: 'I want to pass math',
      points: '−10\u00a0points',
      quip: 'YouTube will still be here in 42\u00a0minutes. Your homework won’t.',
      back: 'Back to my stuff',
    },
    aria: {
      idle: 'The Céntrate window at rest, with the “What do you want to do?” field and the templates Homework 1\u00a0h, Exam 3\u00a0h and Read 30\u00a0min.',
      typing:
        'The Céntrate window with “no veo YouTube en una hora” (no YouTube for an hour) typed in the field. The app has understood YouTube, 1\u00a0hour, until 5:42\u00a0PM.',
      confirm:
        'Céntrate’s confirmation card: block YouTube for 1\u00a0hour, until 5:42\u00a0PM, in Normal mode, with the reason “I want to pass math”.',
      countdown:
        'The Céntrate window with YouTube blocked until 5:42\u00a0PM. 42\u00a0minutes left.',
      study:
        'The Céntrate window in Study Mode, studying history, with the camera on and the meter at “Focused”.',
      progress:
        'Progress in Céntrate: level 7, 1,240\u00a0points, a 5\u00a0day streak and 42 of 60\u00a0minutes today.',
      'blocked-page':
        'Céntrate’s blocked page: YouTube blocked, 42\u00a0minutes left, reason “I want to pass math” and −10\u00a0points.',
    },
  },

  pages: {
    descargar: {
      headline: 'Download Céntrate.',
      lead: 'Free, no account and open source. Pick your system and follow the steps: it takes a few minutes.',
      versionFallback: 'Latest version available on GitHub.',
      mobileNote:
        'Céntrate is for computers. Open this page on your Windows, macOS or Linux machine.',
      tocLabel: 'On this page',
      windows: {
        id: 'windows',
        toc: 'Windows',
        headline: 'Install on Windows.',
        requirement: '64-bit Windows 10 or 11.',
        button: 'Download Centrate-Setup.exe',
        steps: [
          'Download **Centrate-Setup.exe** and open it.',
          'If you see “Windows protected your PC”, click **More info** and then **Run anyway**.',
          'When Windows asks whether to allow the app to make changes to your device, click **Yes**. It’s the only time it asks for administrator permission, and it’s used to install the guardian.',
          'Finish the installer and open Céntrate. Its icon appears in the system tray, next to the clock; if you don’t see it, click the arrow that shows hidden icons.',
          'Follow the welcome: install the extension, try the camera if you like and create your first block.',
        ],
        notes: ['On Windows, Céntrate updates itself when a new version comes out.'],
      },
      macos: {
        id: 'macos',
        toc: 'macOS',
        headline: 'Install on macOS.',
        requirement: 'macOS 12 or later. One download for Apple Silicon and Intel.',
        button: 'Download Centrate.dmg',
        steps: [
          'Download **Centrate.dmg**, open it and drag Céntrate to the **Applications** folder.',
          'Open Céntrate from Applications. macOS will warn that it can’t verify the app: close the warning without moving it to the Trash.',
          'Go to **System Settings → Privacy & Security**, scroll down to **Security** and click **Open Anyway** next to the message about Céntrate. Confirm with your password. The button only appears for a while after you try to open the app.',
          'The first time, Céntrate asks for your administrator password to install the guardian. It only does this once.',
          'If you’re going to use Study Mode with the camera, allow camera access when asked.',
        ],
        notes: [
          'Optional: with the **Screen Recording** permission, Céntrate can also tell when something blocked is in front of you. It only reads the title of the active window and records nothing. Without that permission, everything else works the same.',
          'On macOS, Céntrate doesn’t update itself: when there is a new version, it lets you know and brings you to this page.',
        ],
      },
      linux: {
        id: 'linux',
        toc: 'Linux',
        headline: 'Install on Linux.',
        requirement: '64-bit Ubuntu or Debian. The AppImage works on other distributions.',
        deb: {
          title: '.deb package',
          text: 'Recommended on Ubuntu and Debian.',
          button: 'Download Centrate.deb',
          steps: [
            'Download **Centrate.deb**.',
            'Install it by double-clicking it in your software manager or, in a terminal opened in your downloads folder, with `sudo apt install ./Centrate.deb`.',
            'The guardian installs and starts on its own. Open Céntrate from the applications menu.',
          ],
        },
        appImage: {
          title: 'AppImage',
          text: 'For other 64-bit distributions.',
          button: 'Download Centrate.AppImage',
          steps: [
            'Download **Centrate.AppImage**.',
            'Make it executable in Properties → **Allow executing file as program**, or with `chmod +x Centrate.AppImage`.',
            'Open it. The first time it will ask for your password to install the guardian.',
          ],
        },
        notes: [
          'If the AppImage doesn’t open, install FUSE 2: `sudo apt install libfuse2t64` on Ubuntu 24.04 or later, or `sudo apt install libfuse2` on earlier versions.',
        ],
      },
      extension: {
        id: 'extension',
        toc: 'Extension',
        headline: 'Install the extension.',
        lead: 'The extension blocks instantly inside the browser and shows you the blocked page with your reason. Without it, the system-wide block is still on, but a site may take a while to stop loading. Install it in every browser you use.',
        chromium: {
          title: 'Chrome, Edge and Brave',
          text: 'For now it’s installed by hand, as an unpacked extension. It takes a couple of minutes.',
          button: 'Download Centrate-extension.zip',
          steps: [
            'Download **Centrate-extension.zip** and unzip it into a folder you won’t move or delete, for example in Documents.',
            'Open the extensions page: `chrome://extensions` in Chrome, `edge://extensions` in Edge or `brave://extensions` in Brave.',
            'Turn on **Developer mode**.',
            'Click **Load unpacked** and choose the folder.',
            'Enter the pairing code Céntrate shows you in the welcome or in **Settings… → System**.',
            'To make it work in incognito too, click **Details** on the extension and turn on **Allow in Incognito** (in Edge, **Allow in InPrivate**).',
          ],
          notes: [
            'Don’t delete or move the folder: the browser loads the extension from there.',
            'It’s normal for the browser to remind you that you have extensions in developer mode. Don’t turn it off.',
            'To update it, replace the contents of the folder with the new version and click the extension’s reload button.',
          ],
        },
        firefox: {
          title: 'Firefox',
          button: 'See the latest version on GitHub',
          steps: [
            'Open the latest version on GitHub and download the file that ends in **.xpi**.',
            'Drag it onto a Firefox window and click **Add**.',
            'If it asks for access to all websites, accept: without that permission it can’t block.',
            'Enter the pairing code Céntrate shows you.',
            'For private windows, open `about:addons` → Céntrate and, under **Run in Private Windows**, choose **Allow**.',
          ],
          notes: [
            'If the latest version doesn’t include the .xpi file yet, the Firefox extension will come in the next one. Meanwhile, the guardian still blocks across the whole system.',
          ],
        },
      },
      warnings: {
        id: 'warnings',
        toc: 'Security warnings',
        headline: 'Why you see a warning.',
        text: 'Signing the installers with a certificate costs money every year, and Céntrate doesn’t do it yet. That’s why Windows and macOS warn you the first time you open it. It doesn’t mean anything is wrong with the file, only that the system doesn’t know the author. The code is open and every version publishes its SHA-256 so you can check the file is the original.',
        items: [
          {
            label: 'Windows (SmartScreen)',
            text: '“Windows protected your PC” → **More info** → **Run anyway**.',
          },
          {
            label: 'macOS',
            text: '**System Settings → Privacy & Security → Open Anyway**.',
          },
        ],
      },
      checksum: {
        id: 'sha256',
        toc: 'Check the download',
        headline: 'Check that it’s the original.',
        text: 'Every version publishes a **SHA256SUMS.txt** file with the SHA-256 fingerprint of each download. It works like a fingerprint: if a single byte of the file changes, the fingerprint changes completely. Compute the one of your file and compare it with the published one.',
        table: { file: 'File', size: 'Size', hash: 'SHA-256' },
        commands: [
          {
            label: 'Windows (PowerShell)',
            command: 'Get-FileHash .\\Centrate-Setup.exe -Algorithm SHA256',
          },
          { label: 'macOS (Terminal)', command: 'shasum -a 256 Centrate.dmg' },
          { label: 'Linux', command: 'sha256sum Centrate.deb' },
        ],
        sumsLink: 'Download SHA256SUMS.txt',
        mismatch:
          'If they don’t match, don’t open it: delete it and download it again from this page.',
      },
      antivirus: {
        id: 'antivirus',
        toc: 'Antivirus',
        headline: 'If your antivirus warns you.',
        text: 'Céntrate blocks websites by writing to the hosts file, always between the lines `# >>> CENTRATE START` and `# <<< CENTRATE END` and after making a backup. Some antivirus programs watch that file.',
        items: [
          'On Windows, open **Windows Security → Virus & threat protection → Protection history**, choose the alert about the hosts file and click **Actions → Allow on device**.',
          'In other antivirus programs, add an exception for the Céntrate guardian (`centrate-guardian`).',
        ],
      },
      installs: {
        id: 'what-it-installs',
        toc: 'What gets installed',
        headline: 'What Céntrate installs.',
        items: [
          '**The app**, which lives in the system tray and is always visible.',
          '**The guardian**, a system service that enforces blocks even when the app is closed. It only touches the hosts file, the apps you block and its own folder.',
          '**A section of the hosts file**, always between `# >>> CENTRATE START` and `# <<< CENTRATE END`. It leaves the rest of the file alone.',
          '**Nothing else, and nothing hidden.** You can uninstall it whenever you want.',
        ],
      },
      problems: {
        id: 'troubleshooting',
        toc: 'Troubleshooting',
        headline: 'Troubleshooting.',
        items: [
          {
            title: '“Guardian stopped”.',
            text: 'Open Céntrate and click **Repair**. If nothing changes, run the installer again.',
          },
          {
            title: 'The blocked site still loads.',
            text: 'Check that the extension is installed and paired. Without it, browsers with secure DNS or with the site already open may take a while to respect the block; closing and reopening the browser helps.',
          },
          {
            title: 'Study Mode can’t find the camera.',
            text: 'On Windows, go to **Settings → Privacy & security → Camera** and turn on access for desktop apps. On macOS, go to **System Settings → Privacy & Security → Camera** and turn on Céntrate.',
          },
          {
            title: 'I can’t see the icon on Linux.',
            text: 'On Debian with GNOME, install and turn on the AppIndicator extension so Céntrate shows up in the top bar.',
          },
        ],
      },
      uninstall: {
        id: 'uninstall',
        toc: 'Uninstall',
        headline: 'Uninstall Céntrate.',
        text: 'You always can, even with a block running. It removes the guardian, the lines Céntrate added to the hosts file and everything it installed. If a block is running, it warns you first: the block will be removed and you’ll lose your points and your streak.',
        items: [
          {
            label: 'Windows 11',
            text: '**Settings → Apps → Installed apps**, click “···” next to Céntrate and choose **Uninstall**.',
          },
          {
            label: 'Windows 10',
            text: '**Settings → Apps → Apps & features**, choose Céntrate and click **Uninstall**.',
          },
          {
            label: 'macOS',
            text: 'In Céntrate, open **Settings… → System → Uninstall Céntrate…** and confirm with your password. That removes the guardian and its lines in the hosts file. Then drag Céntrate from Applications to the Trash.',
          },
          {
            label: 'Linux (.deb)',
            text: 'From your software manager or with `sudo apt remove centrate`.',
          },
          {
            label: 'Linux (AppImage)',
            text: 'In Céntrate, open **Settings… → System → Uninstall Céntrate…**. Then delete the Centrate.AppImage file.',
          },
          {
            label: 'Extension',
            text: 'On your browser’s extensions page, click **Remove**. In Chrome, Edge and Brave, delete its folder afterwards.',
          },
        ],
        dataNote:
          'If you also want to delete your statistics and settings, use **Settings… → Data → Delete all my data** before uninstalling.',
      },
      requirements: {
        id: 'requirements',
        toc: 'Requirements',
        headline: 'Requirements.',
        items: [
          '64-bit Windows 10 or 11, macOS 12 or later (Apple Silicon or Intel), or 64-bit Ubuntu or Debian.',
          'Administrator permission once, to install the guardian.',
          'Chrome, Edge, Brave or Firefox, for the extension.',
          'A webcam, only for Study Mode with the camera.',
          'No internet or account needed.',
        ],
      },
      closing: {
        releases: 'All versions on GitHub',
        changelog: { label: 'What’s new', href: '/en/changelog' },
        issuePrompt: 'Something not working?',
        issueLink: 'Open an issue on GitHub',
      },
    },

    novedades: {
      headline: 'What’s new.',
      lead: 'What changes in each version of Céntrate, as published on GitHub. Release notes are written in Spanish.',
      version: 'Version {version}',
      published: 'Released {date}',
      latestPill: 'Latest version',
      viewOnGitHub: 'View on GitHub',
      newRelease: 'There’s a new version: {version}.',
      download: 'Download',
      loading: 'Loading what’s new…',
      error: 'What’s new can’t be loaded from GitHub right now.',
      errorAction: 'See all versions on GitHub',
      empty: 'No version has been released yet. The first one is on its way.',
      cta: 'Download the latest version',
    },

    privacidad: {
      headline: 'Privacy policy.',
      updated:
        'Last updated: September 27, 2026. This is a translation: if it differs from the Spanish version, the Spanish one prevails.',
      lead: 'Céntrate works without an account, without internet and without sending us anything. Here is what data is processed, where it is stored and what rights you have, under the General Data Protection Regulation (GDPR) and the Spanish data protection law (LOPDGDD).',
      summary: {
        title: 'In short',
        items: [
          'Everything the app uses is stored on your computer. We don’t receive it and can’t see it.',
          'The camera is processed 100\u00a0% on your computer: no image is saved, uploaded or leaves the device.',
          'No account, no telemetry, no ads and no tracking cookies.',
        ],
      },
      sections: [
        {
          id: 'controller',
          title: 'Who is responsible.',
          blocks: [
            'Céntrate is an open source project, under the MIT license, published on GitHub by its author, the owner of the [Imdlodoem23](https://github.com/Imdlodoem23) account, who is responsible for this website and the app.',
            'The app doesn’t send us your data: everything described here is stored and processed by your own computer. For any question, see “Changes and contact”.',
          ],
        },
        {
          id: 'what-it-stores',
          title: 'What the app stores and where.',
          blocks: [
            'All of this is stored only on your computer:',
            {
              list: [
                'your blocks, schedules, templates, settings and your reason;',
                'the tasks of your Study Mode sessions;',
                'your points, XP, streak and achievements, and the event log they come from: attempts, strikes, punishments, completed blocks and emergency unlocks;',
                'your statistics, like focused minutes and the number of warnings;',
                'the Study Mode calibration, which is only numbers, never photos;',
                'rotating technical logs, with no personal data, to diagnose failures.',
              ],
            },
            'Part of it is stored by the guardian in a system folder only it can modify, so nobody can cheat: `C:\\ProgramData\\Centrate\\` on Windows, `/Library/Application Support/Centrate/` on macOS and `/var/lib/centrate/` on Linux. The rest is in the app’s data folder, inside your user account.',
            '“Copy diagnostics”, in Settings, only copies those technical logs to your clipboard: you decide whether to share them.',
          ],
        },
        {
          id: 'camera',
          title: 'The camera, 100\u00a0% on your computer.',
          blocks: [
            {
              list: [
                'It only turns on when you start Study Mode, after you give your consent the first time. While it’s on, you always see the “Camera on” indicator.',
                'It analyzes 2 to 4 images per second, at low resolution, with AI models that ship inside the app and work without internet.',
                'Each image is thrown away right away: it isn’t saved, isn’t uploaded and doesn’t leave your computer. The preview is optional and only appears on your screen.',
                'It doesn’t identify you: there is no face recognition. It only checks whether someone is there, where they are looking, whether their eyes have been closed for a long time and whether a phone or a book appears.',
                'The calibration and the “I was studying!” button store numbers, like head angles or the probability that there is a phone, never images. You can recalibrate whenever you want, and “Delete all my data” removes it.',
                'You can use Study Mode without the camera, which only looks at the app in front of you and at your keyboard and mouse activity.',
              ],
            },
          ],
        },
        {
          id: 'extension',
          title: 'The browser extension.',
          blocks: [
            'The extension compares, inside your browser, every site you open with your list of active blocks. It needs permission for all websites because that is the only way to redirect the ones you block.',
            'It only talks to the guardian on your own computer (`127.0.0.1`): it receives the list of what is blocked and reports attempts to it. It doesn’t store your history or send it anywhere.',
          ],
        },
        {
          id: 'internet',
          title: 'When the app connects to the internet.',
          blocks: [
            'The app works offline. When there is internet, it only connects to:',
            {
              list: [
                'check GitHub for a new version and, if there is one, download it (on macOS it only lets you know);',
                'compare the time with a time server, so that moving the computer’s clock forward doesn’t end a block early.',
              ],
            },
            'Neither connection sends any of your data, although, as with any connection, the server sees your IP address. There is no telemetry: the app doesn’t send us usage statistics or error reports.',
          ],
        },
        {
          id: 'website',
          title: 'This website.',
          blocks: [
            {
              list: [
                '**No cookies.** We don’t use cookies or analytics or advertising tools, so you won’t see a cookie banner. The website may remember a preference in your browser, like whether you paused the cards or chose a language, and that data never leaves it.',
                '**Self-hosted fonts.** Fonts are served from this same website, without connecting to third-party services.',
                '**Hosting.** The website is hosted on Render. Like any server, it logs technical data about each visit (IP address, date, requested page and browser) to serve it and protect it from abuse. We don’t use it to find out who you are or combine it with anything.',
                '**GitHub.** To show you the latest version, the website may query GitHub’s public API from your browser, and downloads come from GitHub Releases. In both cases, GitHub receives your IP address, as with any visit to its website.',
                '**The demo.** The demo on the home page runs in your browser: what you type is not sent anywhere.',
              ],
            },
          ],
        },
        {
          id: 'legal-basis',
          title: 'Legal basis.',
          blocks: [
            {
              list: [
                '**App data:** processed on your computer and under your control. We don’t access it.',
                '**Camera:** your consent (Article 6(1)(a) GDPR), which you give in the app the first time and can withdraw whenever you want by no longer using the camera or by using Study Mode without the camera.',
                '**The website’s technical logs:** our legitimate interest in serving it and keeping it secure (Article 6(1)(f) GDPR).',
              ],
            },
          ],
        },
        {
          id: 'retention',
          title: 'How long it is kept.',
          blocks: [
            'App data stays on your computer until you delete it with **Settings → Data → Delete all my data**. Uninstalling Céntrate removes the guardian and its system folder; to also delete your statistics and settings, use that option first.',
            'The website’s technical logs are kept for as long as Render’s policy sets.',
          ],
        },
        {
          id: 'third-parties',
          title: 'Who it is shared with.',
          blocks: [
            'Nobody: we don’t sell or hand over data. The only providers are Render, which hosts the website, and GitHub, which hosts the code, the downloads and the issues. Both are companies based in the United States, so that technical data may be processed outside the European Union, under their own privacy policies.',
          ],
        },
        {
          id: 'rights',
          title: 'Your rights.',
          blocks: [
            'You have the right of access, rectification, erasure, objection, restriction of processing and portability, and to withdraw your consent. Since the app’s data is on your computer, you exercise them yourself, without asking us:',
            {
              list: [
                '**Access and portability:** Settings → Data → **Export**, as CSV.',
                '**Erasure:** Settings → Data → **Delete all my data**, which asks you to type a confirmation word. Running blocks are not deleted: they end on time.',
                '**Rectification:** change your settings, schedules and templates whenever you want. Points can’t be edited, so nobody can cheat, but they can be deleted.',
              ],
            },
            'For anything else, write to us (see “Changes and contact”). If you think we haven’t respected your rights, you can file a complaint with the Spanish Data Protection Agency ([aepd.es](https://www.aepd.es)).',
          ],
        },
        {
          id: 'minors',
          title: 'Minors.',
          blocks: [
            'Céntrate doesn’t ask anyone for an account or personal data, including minors. If you’re under 14, read this policy with your parent or guardian, and only use Study Mode with the camera with their permission.',
          ],
        },
        {
          id: 'security',
          title: 'Security.',
          blocks: [
            'Only the guardian runs as administrator, and it does only what is strictly necessary: the hosts file, the apps on your list and its own folder. It only listens on your own computer (`127.0.0.1`), requires a key for any change, validates everything it receives and has no way to end a block early.',
          ],
        },
        {
          id: 'contact',
          title: 'Changes and contact.',
          blocks: [
            'If this policy changes, you’ll see it here with the new date and in [what’s new](/en/changelog). If online features ever exist, like accounts or studying with friends, they will be optional and this policy will be updated before they do.',
            'For any question, open an issue on [GitHub](https://github.com/Imdlodoem23/App-to-not-Procastinate/issues). Issues are public: don’t write personal data in them. If you need to discuss something privately, say so in the issue and we’ll give you a private channel.',
          ],
        },
      ],
    },

    notFound: {
      headline: 'This page doesn’t exist.',
      lead: 'We didn’t block it, promise: the link may be mistyped or the page may have moved.',
      home: { label: 'Go to the home page', href: '/en' },
      download: { label: 'Download Céntrate', href: '/en/download' },
    },
  },

  meta: {
    siteName: 'Céntrate',
    locale: 'en_US',
    ogImageAlt: 'The Céntrate window with YouTube blocked until 5:42 PM and a countdown.',
    home: {
      title: 'Céntrate: the free app to stop procrastinating',
      ogTitle: 'Céntrate. Type it. Forget it.',
      description:
        'Type what you want to avoid and for how long, and Céntrate blocks it even if you close the app. With Study Mode and points. Free, no account, for Windows, macOS and Linux.',
    },
    descargar: {
      title: 'Download Céntrate for Windows, macOS and Linux',
      description:
        'Download Céntrate for free. Steps for each system, the browser extension, how to get past the security warnings, check the SHA-256 and uninstall.',
    },
    novedades: {
      title: 'What’s new · Céntrate',
      description: 'What changes in each version of Céntrate, as published on GitHub.',
    },
    privacidad: {
      title: 'Privacy policy · Céntrate',
      description:
        'What Céntrate stores and where: everything on your computer, the camera 100\u00a0% local, and no account or tracking cookies. GDPR compliant.',
    },
    notFound: {
      title: 'Page not found · Céntrate',
      description: 'This page doesn’t exist. Go back to the home page or download Céntrate.',
    },
  },
};
