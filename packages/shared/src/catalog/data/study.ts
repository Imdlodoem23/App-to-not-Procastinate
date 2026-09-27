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
      'res.cdn.office.net',
      'aadcdn.msauth.net',
      'aadcdn.msftauth.net',
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
    domains: ['educa.madrid.org', 'aules.edu.gva.es', 'xtec.cat', 'educa.jcyl.es', 'blinklearning.com'],
  },
  {
    id: 'notion',
    name: 'Notion',
    domains: ['notion.so', 'www.notion.so', 'notion.site'],
  },
];

/*
 * Default study apps (never closed by the whitelist punishment). Same process-name
 * conventions as APP_DATA. Editable by the user later.
 * - macOS VS Code runs as `Electron` in older builds and `Code` in newer ones.
 */
export const STUDY_APP_DATA: readonly App[] = [
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
    processes: { win: ['ms-teams.exe', 'Teams.exe'], mac: ['MSTeams', 'Microsoft Teams'], linux: [] },
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
    processes: { win: ['Code.exe'], mac: ['Code', 'Electron'], linux: ['code'] },
  },
  {
    id: 'geogebra',
    name: 'GeoGebra',
    processes: { win: ['GeoGebra.exe'], mac: ['GeoGebra'], linux: ['geogebra'] },
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
