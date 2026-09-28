/**
 * The popup (toolbar button): the extension's state at a glance, in the app's layout
 * (PROMPT §10): warnings only when something fails, the «Bloqueo» section with its
 * countdowns, the pairing form when not paired, and a footer with the connection line
 * («● Guardián conectado» / «● Guardián no responde»), «Abrir guía» and «Reintentar».
 *
 * Everything comes from the background snapshot and its broadcasts. Without the guardian the
 * background keeps the last rules until each block's end, so the countdowns keep running.
 * A block whose end has passed while the snapshot still lists it reads «Comprobando la
 * hora…», like blocked.html (model.ts `popupTimes`).
 *
 * Feedback that hides what had the focus moves it to the «Bloqueo» heading (pairing, a
 * «Reintentar» that fixed it) and says so in a `role="status"` line: #popup-live for the
 * pairing, the line next to the warning's «Reintentar» (or the footer's) for a retry.
 */
import './popup.css';
import type { ExtensionStateSnapshot, GuideSection } from '../../background/state';
import { PAGES_ES } from '../i18n/es';
import { createAnnouncer, createCountdownView, startTicker } from '../shared/countdown';
import { bindHelp, byId, el, icon, setAttr, setText, show } from '../shared/dom';
import { createPairingForm } from '../shared/pairing-form';
import {
  extensionAvailable,
  getState,
  openGuide,
  refreshState,
  requestHostPermission,
  watchState,
} from '../shared/runtime';
import type { Notice } from '../shared/status';
import {
  canRetry,
  connectionLine,
  noticesFor,
  pairingNeed,
  retryOffered,
  retryResult,
} from '../shared/status';
import { followSystemTheme } from '../shared/theme';
import type { BlockSection } from './model';
import { blockSection, popupTimes } from './model';

/** The background may be waking up: ask again a few times before giving up. */
const STATE_RETRIES = 5;
const STATE_RETRY_MS = 300;
/**
 * «Reintentando…» shows at least this long: a refused loopback connection fails within
 * milliseconds, and a result nobody could see (or hear change) is no result.
 */
const RETRY_MIN_MS = 600;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function main(): void {
  const p = PAGES_ES.popup;
  const c = PAGES_ES.common;
  followSystemTheme(document.documentElement);
  document.title = p.documentTitle;

  // Notices («Aviso de protección»).
  const noticesSection = byId('notices');
  setText(byId('notices-title'), p.noticesLabel);
  const noticesList = byId('notices-list');
  const noticesHelp = byId('notices-help');

  // «Bloqueo».
  const blockSectionEl = byId('block');
  const blockTitle = byId('block-title');
  blockTitle.before(icon('lock'));
  const blockUntil = byId('block-until');
  const countdownEl = byId('block-countdown');
  const countdown = createCountdownView(countdownEl);
  // Speaks the 15, 5 and 1 min marks, and «Bloqueo terminado» once the block has gone.
  const announcer = createAnnouncer(byId('block-live'));
  // Confirmations whose own element is hidden (the pairing form).
  const popupLive = byId('popup-live');
  // The mode's 3 px bar: its color comes from `data-accent` on #block.
  const modeBar = byId('block-bar');
  const blockHelp = byId('block-help');
  const blockRows = byId('block-rows');
  blockRows.setAttribute('aria-label', p.blocksLabel);

  // Pairing.
  const pairingSection = byId('pairing');
  const pairingTitle = byId('pairing-title');
  pairingTitle.before(icon('link'));
  setText(byId('pairing-intro'), PAGES_ES.pairing.intro);

  // Footer.
  const statusDot = byId('status-dot');
  const statusText = byId('status-text');
  const version = byId('status-version');
  const guideButton = byId<HTMLButtonElement>('open-guide');
  guideButton.prepend(icon('circle-question-mark'));
  setText(byId('open-guide-label'), c.guide);
  const retryButton = byId<HTMLButtonElement>('retry');
  retryButton.prepend(icon('refresh-cw'));
  const retryLabel = byId('retry-label');
  setText(retryLabel, c.retry);
  bindHelp(byId('footer-help'), [
    [guideButton, c.guideHelp],
    [retryButton, c.retryHelp],
  ]);

  let state: ExtensionStateSnapshot | null = null;
  let justPaired = false;
  let focusedPairing = false;
  let noticesKey = '';
  let rowsKey = '';
  let rowValues: HTMLElement[] = [];
  let untilText = '';
  let section: BlockSection | null = null;
  /** «Reintentar» running (both tiles read «Reintentando…»), and when the last one ended. */
  let retrying = false;
  let retryCheckedAt: number | null = null;
  /** The warning's «Reintentar» tile and the `role="status"` line next to it. */
  let noticeRetry: { button: HTMLButtonElement; label: HTMLElement; status: HTMLElement } | null =
    null;

  /** Where the focus goes when what had it disappears: the «Bloqueo» heading, else the guide. */
  const focusStable = (): void => {
    (blockSectionEl.hidden ? guideButton : blockTitle).focus();
  };

  const pairingForm = createPairingForm({
    onPaired(next) {
      justPaired = true;
      state = next;
      // Hides the form, and moves the focus that was in it to the «Bloqueo» heading.
      renderAll();
      if (document.activeElement === document.body) focusStable();
      // The green notice is not live, and the form's own help line is hidden now.
      setText(popupLive, PAGES_ES.pairing.success);
    },
  });
  byId('pairing-slot').replaceWith(pairingForm.element);

  /** One path for the warning's and the footer's «Reintentar». */
  const retry = (): void => {
    if (retrying) return;
    retrying = true;
    renderRetry();
    const started = Date.now();
    void refreshState()
      .then((next) => {
        if (next !== null) state = next;
      })
      .then(() => wait(RETRY_MIN_MS - (Date.now() - started)))
      .finally(() => {
        retrying = false;
        retryCheckedAt = Date.now();
        renderAll();
      });
  };

  const goToGuide = (where?: GuideSection): void => {
    void openGuide(where).then(() => window.close());
  };

  const runAction = (notice: Notice): void => {
    const action = notice.action;
    if (action === null) return;
    switch (action.kind) {
      case 'retry':
        retry();
        break;
      case 'guide':
        goToGuide(action.section);
        break;
      case 'grant':
        // Must start inside the click (user gesture); the guide is the fallback.
        requestHostPermission()
          .then(() => refreshState())
          .then((next) => {
            if (next !== null) state = next;
            renderAll();
          })
          .catch(() => goToGuide('host-permission'));
        break;
    }
  };

  const renderNotices = (): void => {
    const notices = noticesFor(state);
    const key = JSON.stringify([justPaired, notices.map((n) => [n.problem, n.text])]);
    if (key === noticesKey) return;
    noticesKey = key;
    const items: HTMLElement[] = [];
    const helps: Array<readonly [HTMLElement, string]> = [];
    if (justPaired && pairingNeed(state) === 'none') {
      items.push(
        el('div', { className: 'notice', attrs: { 'data-accent': 'green' } }, [
          el('div', { className: 'notice-line' }, [
            icon('shield-check'),
            el('p', { className: 'notice-text', text: PAGES_ES.pairing.success }),
          ]),
        ]),
      );
    }
    noticeRetry = null;
    for (const notice of notices) {
      const children: HTMLElement[] = [
        el('div', { className: 'notice-line' }, [
          icon('triangle-alert'),
          el('p', { className: 'notice-text', text: notice.text }),
        ]),
      ];
      if (notice.action !== null) {
        const action = notice.action;
        const door = action.kind === 'guide';
        const label = el('span', { className: 'tile-label', text: action.label });
        const button = el(
          'button',
          {
            className: door ? 'tile tile--text tile--door' : 'tile tile--text',
            attrs: { type: 'button' },
          },
          [label],
        );
        button.addEventListener('click', () => runAction(notice));
        helps.push([button, action.help]);
        const tiles: HTMLElement[] = [button];
        if (action.kind === 'retry' && noticeRetry === null) {
          // Beside the tile (the row's free columns): «Sigue sin responder · comprobado a
          // las 17:42». In the page from the start, so a change is always spoken.
          const status = el('p', { className: 'notice-status', attrs: { role: 'status' } });
          noticeRetry = { button, label, status };
          tiles.push(status);
        }
        children.push(el('div', { className: 'tiles notice-tiles' }, tiles));
      }
      items.push(
        el('div', { className: 'notice', attrs: { 'data-accent': notice.tone } }, children),
      );
    }
    noticesList.replaceChildren(...items);
    setText(noticesHelp, '');
    show(noticesHelp, helps.length > 0);
    if (helps.length > 0) bindHelp(noticesHelp, helps);
    show(noticesSection, items.length > 0);
  };

  /**
   * Shows the longest title that stays on one line beside «hasta 17:42» (the header never
   * wraps or clips). Runs after the times are rendered: the value's width matters.
   */
  const fitTitle = (): void => {
    const titles = section?.titles ?? [];
    for (const [i, candidate] of titles.entries()) {
      setText(blockTitle, candidate);
      // One 18 px line; a second line makes it at least 36 px.
      if (blockTitle.scrollHeight < 27 || i === titles.length - 1) return;
    }
  };

  const renderBlock = (): void => {
    section = blockSection(state);
    show(blockSectionEl, section !== null);
    if (section === null) return;
    setAttr(blockSectionEl, 'data-accent', section.accent);
    setText(blockHelp, section.reason ?? section.emptyHelp ?? '');
    blockHelp.classList.toggle('help--reason', section.reason !== null);
    const key = JSON.stringify([section.rows.map((r) => [r.key, r.title, r.endsAt]), section.more]);
    if (key !== rowsKey) {
      rowsKey = key;
      rowValues = [];
      const items = section.rows.map((row) => {
        const value = el('span', { className: 'row-value' });
        rowValues.push(value);
        return el('li', { className: 'row' }, [
          el('span', { className: 'row-title', text: row.title }),
          value,
        ]);
      });
      if (section.more > 0) {
        items.push(el('li', { className: 'row row--more', text: p.more(section.more) }));
      }
      blockRows.replaceChildren(...items);
    }
    show(blockRows, section.rows.length > 0 || section.more > 0);
  };

  const renderPairing = (): void => {
    const need = pairingNeed(state);
    show(pairingSection, need !== 'none');
    setText(pairingTitle, need === 'again' ? PAGES_ES.pairing.titleAgain : PAGES_ES.pairing.title);
    if (need !== 'none' && !focusedPairing) {
      focusedPairing = true;
      pairingForm.focus();
    }
  };

  /**
   * The footer line; after the footer's own «Reintentar» (no warning offers one) it carries
   * the result: «Guardián no responde · comprobado a las 17:42» (it is `role="status"`).
   */
  const renderFooter = (): void => {
    const line = connectionLine(state);
    const footerRetry = canRetry(state);
    const result = footerRetry && !retrying ? retryResult(state, retryCheckedAt) : null;
    setText(statusText, result?.footer ?? line.text);
    setAttr(statusDot, 'data-accent', line.tone);
    setText(version, state === null ? '' : c.version(state.extVersion));
    show(retryButton, footerRetry);
  };

  /**
   * Both «Reintentar» tiles: «Reintentando…» and `aria-disabled` while it runs (the focus
   * stays on the tile), then the dated result beside the warning's tile. The line empties
   * while it runs, so a second failure in the same minute is spoken again.
   */
  function renderRetry(): void {
    const label = retrying ? p.retrying : c.retry;
    const tiles: Array<[HTMLButtonElement, HTMLElement]> = [[retryButton, retryLabel]];
    if (noticeRetry !== null) tiles.push([noticeRetry.button, noticeRetry.label]);
    for (const [button, text] of tiles) {
      setText(text, label);
      setAttr(button, 'aria-disabled', retrying ? 'true' : null);
    }
    if (noticeRetry !== null) {
      const result = retrying ? null : retryResult(state, retryCheckedAt);
      setText(noticeRetry.status, result?.notice ?? '');
    }
    renderFooter();
  }

  /**
   * Countdown and its bar, «hasta 17:42» (or «Comprobando la hora…» once the end has passed
   * while the snapshot still lists the block) and the rows' «quedan N min»; returns the next
   * tick.
   */
  const renderTimes = (now: number): number | null => {
    const times = popupTimes(section, now);
    const counting = times.countdownMs !== null;
    if (times.countdownMs !== null) countdown.update(times.countdownMs);
    show(countdownEl, counting);
    show(modeBar, counting);
    setText(blockUntil, times.until);
    for (const [i, value] of rowValues.entries()) setText(value, times.rowValues[i] ?? '');
    announcer.update(times.announce);
    // «Comprobando la hora…» is wider than «hasta 17:42»: the title may need a shorter form.
    if (times.until !== untilText) {
      untilText = times.until;
      fitTitle();
    }
    return times.nextTickMs;
  };
  const ticker = startTicker(renderTimes);

  function renderAll(): void {
    const focused = document.activeElement;
    // A retry result only belongs to the problem it tried to fix.
    if (!retrying && !retryOffered(state)) retryCheckedAt = null;
    renderNotices();
    renderBlock();
    renderPairing();
    renderRetry();
    ticker.refresh();
    fitTitle();
    if (state !== null) settle();
    // What had the focus was removed or hidden (a warning that went away, the pairing form).
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      (!focused.isConnected || focused.closest('[hidden]') !== null)
    ) {
      focusStable();
    }
  }

  /** The first answer arrived (or will not): the popup is no longer loading. */
  function settle(): void {
    byId('main').removeAttribute('aria-busy');
  }

  guideButton.addEventListener('click', () => goToGuide());
  retryButton.addEventListener('click', retry);

  renderAll();
  if (!extensionAvailable()) {
    settle();
    return;
  }
  watchState((next) => {
    state = next;
    renderAll();
  });
  let attempts = 0;
  const load = (): void => {
    attempts += 1;
    void getState().then((next) => {
      if (next === null) {
        if (attempts < STATE_RETRIES) setTimeout(load, STATE_RETRY_MS);
        else settle();
        return;
      }
      state = next;
      renderAll();
      // Re-probe at once when the last try failed (the worker may have been asleep).
      if (next.paired && next.link !== 'connected') {
        void refreshState().then((fresh) => {
          if (fresh !== null) {
            state = fresh;
            renderAll();
          }
        });
      }
    });
  };
  load();
}

main();
