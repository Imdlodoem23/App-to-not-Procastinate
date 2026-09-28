/**
 * The guide (options page, opened in a tab): pairing step by step, the host permission,
 * incognito per browser, installing in Chrome/Edge/Brave and Firefox, what the extension can
 * see, and what to do when something fails. Sections follow the app's layout (PROMPT §10:
 * «Cosa: valor» headers, one column) and the live parts follow the background snapshot.
 *
 * Its URL hash picks a section (`options.html#incognito`, background/state.ts
 * `GUIDE_SECTIONS`); the heading gets the focus.
 */
import './options.css';
import type { BrowserFamily } from '@centrate/shared/domain';
import type { ExtensionStateSnapshot } from '../../background/state';
import { PAGES, applyDocumentLanguage } from '../i18n';
import { bindHelp, byId, el, icon, nextId, setAttr, setText, show } from '../shared/dom';
import { formatClock, formatDayMonth } from '../shared/format';
import type { IconName } from '../shared/icons';
import { createPairingForm } from '../shared/pairing-form';
import {
  extensionAvailable,
  getState,
  refreshState,
  requestHostPermission,
  watchState,
} from '../shared/runtime';
import { connectionLine, pairingNeed } from '../shared/status';
import { followSystemTheme } from '../shared/theme';

type SectionId = keyof typeof PAGES.guide.toc;

interface SectionParts {
  section: HTMLElement;
  heading: HTMLHeadingElement;
  title: HTMLElement;
  value: HTMLElement;
}

function buildSection(id: SectionId, iconName: IconName, title: string): SectionParts {
  const titleId = `${id}-title`;
  const titleText = el('span', { text: title });
  const value = el('span', { className: 'section-value' });
  const heading = el('h2', { className: 'section-title', id: titleId, attrs: { tabindex: -1 } }, [
    titleText,
  ]);
  const header = el('div', { className: 'section-header' }, [icon(iconName), heading, value]);
  const section = el(
    'section',
    { className: 'section guide-section', id, attrs: { 'aria-labelledby': titleId } },
    [header],
  );
  return { section, heading, title: titleText, value };
}

function list(tag: 'ol' | 'ul', items: readonly string[], className: string): HTMLElement {
  return el(
    tag,
    { className },
    items.map((item) => el('li', { text: item })),
  );
}

/** «hoy a las 17:42», «el 28/9 a las 17:42»; «today at 5:42 PM», «on 9/28 at 5:42 PM». */
function formatWhen(ms: number, now: number): string {
  const g = PAGES.guide;
  const time = formatClock(ms);
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return g.whenToday(time);
  return g.whenDate(formatDayMonth(ms), time);
}

function externalLink(href: string, text: string): HTMLAnchorElement {
  return el('a', { text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
}

function main(): void {
  const g = PAGES.guide;
  const c = PAGES.common;
  applyDocumentLanguage();
  followSystemTheme(document.documentElement);
  document.title = g.documentTitle;

  const root = byId('guide');
  let state: ExtensionStateSnapshot | null = null;

  // Header: title, intro and the connection line.
  const statusDot = el('span', { className: 'dot' });
  const statusText = el('span', { attrs: { role: 'status' } });
  root.append(
    el('div', { className: 'section guide-intro' }, [
      el('h1', { className: 'guide-title', text: g.title }),
      el('p', { className: 'text-muted', text: g.intro }),
      el('p', { className: 'guide-status' }, [statusDot, statusText]),
    ]),
  );

  // Table of contents: door tiles to each section.
  const order: SectionId[] = [
    'pairing',
    'host-permission',
    'incognito',
    'chromium',
    'firefox',
    'privacy',
    'troubleshooting',
  ];
  root.append(
    el('nav', { className: 'guide-toc', attrs: { 'aria-label': g.tocLabel } }, [
      el(
        'ul',
        { className: 'tiles guide-toc-tiles' },
        order.map((id) =>
          el('li', {}, [
            el('a', { className: 'tile tile--text tile--door', attrs: { href: `#${id}` } }, [
              el('span', { className: 'tile-label', text: g.toc[id] }),
            ]),
          ]),
        ),
      ),
    ]),
  );

  // 1. Pairing.
  const pairing = buildSection('pairing', 'link', g.pairing.title);
  // «Emparejada con el guardián 0.1.0 hoy a las 17:42.»: spoken when it changes (re-pairing).
  const pairedLine = el('p', { className: 'guide-done', attrs: { role: 'status' } });
  const againButton = el('button', {
    className: 'link-button',
    text: g.pairing.again,
    attrs: { type: 'button' },
  });
  let showForm = false;
  const pairingForm = createPairingForm({
    onPaired(next) {
      state = next;
      showForm = false;
      update();
      // The form (and the focus in it) is hidden now: the heading says «Emparejar: hecho».
      pairing.heading.focus();
    },
  });
  againButton.addEventListener('click', () => {
    // A fresh form: no line left over from the last pairing or a failed code.
    pairingForm.reset();
    showForm = true;
    update();
    pairingForm.focus();
  });
  pairing.section.append(
    list('ol', g.pairing.steps, 'steps'),
    el('p', { className: 'text-muted', text: g.pairing.note }),
    pairedLine,
    el('div', { className: 'pairing-more' }, [againButton]),
    pairingForm.element,
  );

  // 2. Host permission.
  const host = buildSection('host-permission', 'globe', g.hostPermission.title);
  const grantButton = el('button', { className: 'tile tile--text', attrs: { type: 'button' } }, [
    el('span', { className: 'tile-label', text: g.hostPermission.grant }),
  ]);
  const grantHelp = el('p', { className: 'help', id: nextId('grant-help') });
  bindHelp(grantHelp, [[grantButton, g.hostPermission.grantHelp]]);
  const grantRow = el('div', { className: 'guide-grant' }, [
    el('div', { className: 'tiles guide-grant-tiles' }, [grantButton]),
    grantHelp,
  ]);
  const manualLabel = el('p', { className: 'text-muted', text: g.hostPermission.manual });
  const manualSteps = el('div');
  host.section.append(el('p', { text: g.hostPermission.body }), grantRow, manualLabel, manualSteps);
  grantButton.addEventListener('click', () => {
    requestHostPermission()
      .then(() => refreshState())
      .then((next) => {
        if (next !== null) state = next;
        update();
      })
      .catch(() => {
        // Nothing else to try from here: the manual steps stay visible.
      });
  });

  // 3. Incognito.
  const incognito = buildSection('incognito', 'eye-off', g.incognito.title);
  const browsers = el('ul', { className: 'guide-browsers' });
  incognito.section.append(el('p', { text: g.incognito.body }), browsers);

  // 4-5. Installing.
  const chromium = buildSection('chromium', 'puzzle', g.chromium.title);
  chromium.section.append(
    list('ol', g.chromium.steps, 'steps'),
    el('p', {}, [externalLink(g.releasesUrl, g.releasesLink)]),
    list('ul', g.chromium.notes, 'notes'),
  );
  const firefox = buildSection('firefox', 'puzzle', g.firefox.title);
  firefox.section.append(
    list('ol', g.firefox.steps, 'steps'),
    el('p', {}, [externalLink(g.releasesUrl, g.releasesLink)]),
    list('ul', g.firefox.notes, 'notes'),
  );

  // 6. Privacy.
  const privacy = buildSection('privacy', 'shield', g.privacy.title);
  privacy.section.append(list('ul', g.privacy.points, 'points'));

  // 7. Troubleshooting and diagnostics.
  const trouble = buildSection('troubleshooting', 'life-buoy', g.troubleshooting.title);
  const t = g.troubleshooting;
  const diagnostics = el('dl', { className: 'guide-diagnostics' });
  trouble.section.append(
    el(
      'dl',
      { className: 'guide-faq' },
      t.items.flatMap((item) => [el('dt', { text: item.term }), el('dd', { text: item.detail })]),
    ),
    el('h3', { className: 'guide-subtitle', text: t.diagnosticsLabel }),
    diagnostics,
  );

  root.append(
    pairing.section,
    host.section,
    incognito.section,
    chromium.section,
    firefox.section,
    privacy.section,
    trouble.section,
  );

  function renderBrowsers(family: BrowserFamily | null): void {
    const entries = [...g.incognito.browsers];
    entries.sort((a, b) => {
      const ca = family !== null && a.families.includes(family) ? 0 : 1;
      const cb = family !== null && b.families.includes(family) ? 0 : 1;
      return ca - cb;
    });
    browsers.replaceChildren(
      ...entries.map((entry) => {
        const current = family !== null && entry.families.includes(family);
        const name = current ? `${entry.name} (${g.yourBrowser})` : entry.name;
        return el('li', { attrs: { 'data-current': current } }, [
          el('span', { className: 'guide-browser-name', text: name }),
          el('span', { text: entry.steps }),
        ]);
      }),
    );
  }

  function renderDiagnostics(now: number): void {
    const d = t.diagnostics;
    const browser = state?.browser ?? null;
    const rows: Array<[string, string]> = [
      [d.version, state === null ? '' : c.version(state.extVersion)],
      [d.browser, browser === null ? '' : `${c.browserNames[browser.family]} ${browser.version}`],
      [d.id, extensionAvailable() ? chrome.runtime.id : ''],
      [d.status, connectionLine(state).text],
      [d.lastSync, state?.lastRulesAt == null ? d.never : formatWhen(state.lastRulesAt, now)],
    ];
    diagnostics.replaceChildren(
      ...rows.flatMap(([term, value]) => [
        el('dt', { text: term }),
        el('dd', { className: term === d.id ? 'mono' : undefined, text: value }),
      ]),
    );
  }

  function update(): void {
    const now = Date.now();
    const line = connectionLine(state);
    setText(statusText, line.text);
    setAttr(statusDot, 'data-accent', line.tone);

    const need = pairingNeed(state);
    setText(
      pairing.title,
      state === null ? g.pairing.title : need === 'none' ? g.pairing.done : g.pairing.pending,
    );
    const pairedInfo = state?.pairing ?? null;
    show(pairedLine, need === 'none' && pairedInfo !== null);
    if (pairedInfo !== null) {
      setText(
        pairedLine,
        g.pairing.pairedWith(pairedInfo.guardianVersion, formatWhen(pairedInfo.pairedAt, now)),
      );
    }
    show(
      againButton.parentElement as HTMLElement,
      need === 'none' && pairedInfo !== null && !showForm,
    );
    show(pairingForm.element, need !== 'none' || showForm);

    const granted = state?.capabilities?.hostPermission ?? null;
    setText(
      host.title,
      granted === null
        ? g.hostPermission.title
        : granted
          ? g.hostPermission.granted
          : g.hostPermission.missing,
    );
    show(grantRow, granted === false);
    show(manualLabel, granted === false);
    show(manualSteps, granted === false);
    const engine = state?.browser?.engine ?? null;
    manualSteps.replaceChildren(
      list(
        'ol',
        engine === 'firefox' ? g.hostPermission.firefoxSteps : g.hostPermission.chromiumSteps,
        'steps',
      ),
    );

    const family = state?.browser?.family ?? null;
    const allowed = state?.capabilities?.incognitoAllowed ?? null;
    setText(
      incognito.title,
      allowed === null ? g.incognito.title : g.incognito.state(family, allowed),
    );
    renderBrowsers(family);

    setText(chromium.value, engine === 'chromium' ? g.yourBrowser : '');
    setText(firefox.value, engine === 'firefox' ? g.yourBrowser : '');

    renderDiagnostics(now);
  }

  const focusHash = (): void => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id === '') return;
    const target = document.getElementById(id);
    if (target === null || target.tagName !== 'SECTION') return;
    target.scrollIntoView({ block: 'start' });
    target.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  };
  window.addEventListener('hashchange', focusHash);

  update();
  focusHash();
  if (!extensionAvailable()) return;
  watchState((next) => {
    state = next;
    update();
  });
  void getState().then((next) => {
    if (next === null) return;
    state = next;
    update();
  });
}

main();
