import type { App, StudySite } from '../types';

/*
 * Default study whitelist (punishment level 2 and exam mode). The user can edit it.
 *
 * Every entry also allows its subdomains (see `isDomainAllowedInWhitelist`), so
 * registrable domains are listed when the whole site is for studying (wikipedia.org,
 * moodlecloud.com) and exact hosts when the parent also serves distractions (never
 * google.com, googleapis.com, googleusercontent.com or live.com as a whole).
 *
 * - Moodle: self-hosted sites (aulavirtual.<school>.es…) have their own domains and a
 *   whitelist cannot guess them; moodle.org and MoodleCloud are listed and the user adds
 *   their school's site.
 * - General web search is left out on purpose; the user can add it.
 * - Khan Academy embeds YouTube videos (youtube-nocookie.com), which stay blocked in
 *   whitelist mode unless the extension allows embeds started from a whitelisted page.
 * - Hosts that cannot be enumerated (Drive download hosts, Docs image hosts) are
 *   `hostPatterns`, anchored regular expressions the extension turns into `regexFilter`
 *   allow rules. Whitelist mode also allows ALWAYS_ALLOWED_HOSTS (./always-allowed.ts),
 *   such as accounts.youtube.com, a step of Google's sign-in flow.
 * - Regional platforms cover the largest education departments; a school's own Moodle
 *   (aulavirtual.<school>.es, the Basque Country's per-school sites…) is added by the
 *   user.
 */
export const STUDY_SITE_DATA: readonly StudySite[] = [
  {
    id: 'google-classroom',
    name: 'Google Classroom',
    domains: ['classroom.google.com'],
  },
  {
    id: 'google-workspace',
    name: 'Google Docs, Drive, Slides y Sheets',
    domains: [
      'docs.google.com',
      'drive.google.com',
      'sheets.google.com',
      'slides.google.com',
      'forms.google.com',
      'sites.google.com',
      'keep.google.com',
      'meet.google.com',
      'usercontent.google.com',
      'docs.googleusercontent.com',
      // Internal APIs of Drive, Docs and Classroom.
      'clients6.google.com',
    ],
    hostPatterns: [
      // Exports and downloads: doc-0s-8c-docs.googleusercontent.com.
      '^[a-z0-9-]+-docs\\.googleusercontent\\.com$',
      // Images in Docs and Slides, avatars in Classroom: lh3, lh7-rt, lh7-us….
      '^lh[3-7](?:-[a-z]+)?\\.googleusercontent\\.com$',
      // Drive thumbnails: lh3.google.com/u/0/d/<id>.
      '^lh[3-7]\\.google\\.com$',
    ],
  },
  {
    id: 'google-account',
    name: 'Cuenta de Google',
    domains: [
      'accounts.google.com',
      'apis.google.com',
      'ogs.google.com',
      'ssl.gstatic.com',
      'www.gstatic.com',
      'fonts.gstatic.com',
      'fonts.googleapis.com',
    ],
  },
  {
    id: 'google-scholar',
    name: 'Google Académico',
    domains: ['scholar.google.com', 'scholar.google.es'],
  },
  {
    id: 'moodle',
    name: 'Moodle',
    domains: ['moodle.org', 'moodle.com', 'moodlecloud.com'],
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    domains: [
      'office.com',
      'www.office.com',
      'microsoft365.com',
      'www.microsoft365.com',
      'cloud.microsoft',
      'login.microsoftonline.com',
      'login.live.com',
      'onedrive.live.com',
      'officeapps.live.com',
      'teams.live.com',
      'teams.microsoft.com',
      'sharepoint.com',
      'onenote.com',
      'www.onenote.com',
      // Office and Teams static files: res.cdn.office.net, res-1.cdn.office.net,
      // statics.teams.cdn.office.net.
      'cdn.office.net',
      // SharePoint and OneDrive for Business static files (static2.sharepointonline.com).
      'sharepointonline.com',
      // Microsoft sign-in (aadcdn.msauth.net, logincdn.msftauth.net, acctcdn.msauth.net).
      'msauth.net',
      'msftauth.net',
      'account.live.com',
      // OneDrive share links and downloads.
      '1drv.ms',
      '1drv.com',
      'microsoftpersonalcontent.com',
    ],
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    domains: [
      'wikipedia.org',
      'es.wikipedia.org',
      'en.wikipedia.org',
      'es.m.wikipedia.org',
      'en.m.wikipedia.org',
      'wikimedia.org',
      'upload.wikimedia.org',
      'wiktionary.org',
      'es.wiktionary.org',
    ],
  },
  {
    id: 'khan-academy',
    name: 'Khan Academy',
    domains: [
      'khanacademy.org',
      'www.khanacademy.org',
      'es.khanacademy.org',
      'kastatic.org',
      'cdn.kastatic.org',
    ],
  },
  {
    id: 'geogebra',
    name: 'GeoGebra',
    domains: ['geogebra.org', 'www.geogebra.org'],
  },
  {
    id: 'desmos',
    name: 'Desmos',
    domains: ['desmos.com', 'www.desmos.com'],
  },
  {
    id: 'wolframalpha',
    name: 'WolframAlpha',
    domains: ['wolframalpha.com', 'www.wolframalpha.com', 'wolframcdn.com'],
  },
  {
    id: 'rae',
    name: 'RAE (diccionario)',
    domains: ['rae.es', 'www.rae.es', 'dle.rae.es'],
  },
  {
    id: 'translators',
    name: 'Traductores y diccionarios',
    domains: [
      'translate.google.com',
      'translate.google.es',
      'deepl.com',
      'www.deepl.com',
      'wordreference.com',
      'www.wordreference.com',
      'linguee.es',
      'www.linguee.es',
      'linguee.com',
      'www.linguee.com',
      'reverso.net',
      'context.reverso.net',
    ],
  },
  {
    id: 'school-platforms',
    name: 'Plataformas educativas',
    domains: [
      // Madrid: EducaMadrid and Raíces.
      'educa.madrid.org',
      'educa2.madrid.org',
      'raices.madrid.org',
      // Andalucía: Moodle Centros and Séneca/iPasen.
      'educacionadistancia.juntadeandalucia.es',
      'seneca.juntadeandalucia.es',
      // Comunitat Valenciana, Catalunya, Castilla y León.
      'aules.edu.gva.es',
      'xtec.cat',
      'edu365.cat',
      'educa.jcyl.es',
      // Galicia, Aragón, Castilla-La Mancha, Región de Murcia, Extremadura.
      'edu.xunta.gal',
      'aeducar.es',
      'educamosclm.castillalamancha.es',
      'murciaeduca.es',
      'educarex.es',
      // Asturias, Cantabria, Canarias (EVAGD and Medusa), Illes Balears.
      'educastur.es',
      'educantabria.es',
      'www3.gobiernodecanarias.org',
      'educaib.eu',
    ],
  },
  {
    id: 'publishers',
    name: 'Libros digitales de editoriales',
    domains: ['blinklearning.com', 'smsavia.com', 'anayaeducacion.es', 'oupe.es'],
  },
  {
    id: 'class-tools',
    name: 'Herramientas de clase',
    domains: ['liveworksheets.com', 'quizlet.com', 'kahoot.it', 'genial.ly', 'zoom.us'],
  },
  {
    id: 'notion',
    name: 'Notion',
    domains: [
      'notion.so',
      'www.notion.so',
      'notion.site',
      'notion.com',
      'notion-static.com',
      'notionusercontent.com',
    ],
  },
];

/*
 * Default study apps (never closed by the whitelist punishment and exam mode). Same
 * process-name conventions as APP_DATA. The user can add more.
 *
 * What the catalog assumes about whitelist mode (to confirm in the guardian): it closes
 * only apps outside this list and never a protected process (protected.ts, which
 * includes accessibility tools such as the on-screen keyboard and screen readers); and,
 * on macOS, a process counts as allowed when its name, its bundle or any `.app` bundle on
 * its path is listed, because browser helpers run from nested bundles
 * (Google Chrome.app/…/Google Chrome Helper (Renderer).app).
 *
 * - Browsers are listed: the study websites are only reachable through them, and the
 *   extension enforces the site whitelist inside them.
 * - macOS VS Code runs as `Code` (older builds as the generic `Electron`, so its bundle
 *   name `Visual Studio Code` is listed instead).
 */
export const STUDY_APP_DATA: readonly App[] = [
  {
    id: 'browsers',
    name: 'Navegadores',
    processes: {
      // msedgewebview2.exe: Edge WebView2, which the new Teams, Outlook and Office
      // add-ins render with.
      win: [
        'chrome.exe',
        'msedge.exe',
        'msedgewebview2.exe',
        'firefox.exe',
        'brave.exe',
        'opera.exe',
        'vivaldi.exe',
      ],
      mac: [
        'Google Chrome',
        'Microsoft Edge',
        'firefox',
        'Brave Browser',
        'Safari',
        'Opera',
        'Vivaldi',
        'Arc',
        'Chromium',
      ],
      linux: [
        'chrome',
        'chromium',
        'chromium-browser',
        'msedge',
        'firefox',
        'firefox-bin',
        'firefox-esr',
        'brave',
        'opera',
        'vivaldi-bin',
      ],
    },
  },
  {
    id: 'word',
    name: 'Microsoft Word',
    processes: { win: ['WINWORD.EXE'], mac: ['Microsoft Word'], linux: [] },
  },
  {
    id: 'excel',
    name: 'Microsoft Excel',
    processes: { win: ['EXCEL.EXE'], mac: ['Microsoft Excel'], linux: [] },
  },
  {
    id: 'powerpoint',
    name: 'Microsoft PowerPoint',
    processes: { win: ['POWERPNT.EXE'], mac: ['Microsoft PowerPoint'], linux: [] },
  },
  {
    id: 'onenote',
    name: 'Microsoft OneNote',
    processes: { win: ['ONENOTE.EXE', 'onenoteim.exe'], mac: ['Microsoft OneNote'], linux: [] },
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    processes: {
      win: ['ms-teams.exe', 'Teams.exe'],
      mac: ['MSTeams', 'Microsoft Teams'],
      linux: [],
    },
  },
  {
    id: 'notion',
    name: 'Notion',
    processes: { win: ['Notion.exe'], mac: ['Notion'], linux: [] },
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    processes: { win: ['Obsidian.exe'], mac: ['Obsidian'], linux: ['obsidian'] },
  },
  {
    id: 'acrobat',
    name: 'Adobe Acrobat',
    processes: {
      win: ['Acrobat.exe', 'AcroRd32.exe'],
      mac: ['AdobeAcrobat', 'AdobeReader'],
      linux: [],
    },
  },
  {
    id: 'libreoffice',
    name: 'LibreOffice',
    processes: {
      win: ['soffice.exe', 'soffice.bin'],
      mac: ['soffice'],
      linux: ['soffice.bin', 'soffice', 'libreoffice'],
    },
  },
  {
    id: 'iwork',
    name: 'Pages, Numbers y Keynote',
    processes: { win: [], mac: ['Pages', 'Numbers', 'Keynote'], linux: [] },
  },
  {
    id: 'vscode',
    name: 'Visual Studio Code',
    processes: { win: ['Code.exe'], mac: ['Code', 'Visual Studio Code'], linux: ['code'] },
  },
  {
    id: 'geogebra',
    name: 'GeoGebra',
    processes: { win: ['GeoGebra.exe'], mac: ['GeoGebra'], linux: ['geogebra'] },
  },
  {
    id: 'zoom',
    name: 'Zoom',
    processes: { win: ['Zoom.exe'], mac: ['zoom.us'], linux: ['zoom'] },
  },
  {
    id: 'anki',
    name: 'Anki',
    processes: { win: ['anki.exe'], mac: ['anki'], linux: ['anki'] },
  },
  {
    id: 'zotero',
    name: 'Zotero',
    processes: { win: ['zotero.exe'], mac: ['zotero'], linux: ['zotero'] },
  },
  {
    id: 'calculator',
    name: 'Calculadora',
    processes: {
      win: ['CalculatorApp.exe', 'Calculator.exe'],
      mac: ['Calculator'],
      linux: ['gnome-calculator', 'kcalc'],
    },
  },
  {
    id: 'text-editor',
    name: 'Editor de texto',
    processes: {
      win: ['notepad.exe'],
      mac: ['TextEdit'],
      linux: ['gnome-text-editor', 'gedit', 'kate'],
    },
  },
];
