/**
 * blocked.html entry (the page every blocked navigation is redirected to). Reads its query
 * string, its tab's attempt info (chrome.storage.session, written by the background) and
 * the background snapshot, then renders `blockedView` on a minute-aligned ticker (the page
 * shows «quedan N min», no seconds countdown).
 *
 * It never reports anything (docs/ARCHITECTURE.md §9.5) and never sends the user back to
 * the blocked site while it is blocked: «Volver a lo mío» goes back in history only when the
 * previous entry is not the blocked site (model.ts `backAction`), otherwise a new tab page
 * replaces this tab. Only once nothing covers the site any more does the tile become
 * «Abrir YouTube», which opens the page the attempt wanted in this tab.
 */
import './blocked.css';
import type { BlockedTabInfo } from '../../background/rules';
import {
  BLOCKED_INFO_MESSAGE,
  parseBlockedPageParams,
  parseBlockedTabInfo,
  readBlockedTabInfo,
  watchBlockedTabInfo,
} from '../../background/rules';
import type { ExtensionStateSnapshot } from '../../background/state';
import { PAGES, applyDocumentLanguage } from '../i18n';
import { createAnnouncer, startTicker } from '../shared/countdown';
import { byId, icon, setAttr, setText, show } from '../shared/dom';
import { extensionAvailable, getState, watchState } from '../shared/runtime';
import { followSystemTheme } from '../shared/theme';
import type { BackAction, BlockedAction, InfoContext } from './model';
import { backAction, blockedView, isCurrentInfo } from './model';

/**
 * Until the guardian's answer arrives the page re-reads its info (session storage, else
 * `BLOCKED_INFO_MESSAGE`) this often, a while.
 */
const INFO_POLL_MS = 1_000;
const INFO_POLL_MAX = 15;
/** The humor line waits this long at most for the first answers (so it does not swap). */
const READY_TIMEOUT_MS = 400;
/** After `history.back()`, a page still here this much later opens a new tab instead. */
const BACK_FALLBACK_MS = 700;
/** While «Comprobando la hora…», ask the background again this often (besides broadcasts). */
const CHECKING_POLL_MS = 5_000;
interface Shortcut {
  /** `KeyboardEvent.code` of the letter. */
  code: string;
  /** `aria-keyshortcuts`. */
  label: string;
}

/**
 * Alt + a letter of the tile's label, like the app's mnemonics: Alt + V («Volver a lo mío»)
 * and Alt + A («Abrir YouTube»); Alt + B («Back to my work») and Alt + O («Open YouTube»).
 */
function shortcuts(): Readonly<Record<BlockedAction['kind'], Shortcut>> {
  const letters = PAGES.blocked.shortcuts;
  const shortcut = (letter: string): Shortcut => ({
    code: `Key${letter.toUpperCase()}`,
    label: `Alt+${letter.toUpperCase()}`,
  });
  return { back: shortcut(letters.back), open: shortcut(letters.open) };
}

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function navigationType(): string | null {
  const entry = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  return entry?.type ?? null;
}

async function currentTabId(): Promise<number | null> {
  if (!extensionAvailable() || typeof chrome.tabs?.getCurrent !== 'function') return null;
  try {
    return (await chrome.tabs.getCurrent())?.id ?? null;
  } catch {
    return null;
  }
}

function sessionStorageUsable(): boolean {
  return typeof chrome.storage?.session?.get === 'function';
}

async function askInfo(): Promise<BlockedTabInfo | null> {
  try {
    return parseBlockedTabInfo(await chrome.runtime.sendMessage({ type: BLOCKED_INFO_MESSAGE }));
  } catch {
    return null;
  }
}

async function readInfo(tabId: number): Promise<BlockedTabInfo | null> {
  if (sessionStorageUsable()) {
    try {
      return await readBlockedTabInfo(tabId);
    } catch {
      // Fall back to asking the background.
    }
  }
  return askInfo();
}

/** Shows `second` in the place of `first` when `useSecond`, else `first` again. */
function swapIcon(first: Element, second: Element, useSecond: boolean): void {
  if (useSecond !== second.isConnected) {
    (useSecond ? first : second).replaceWith(useSecond ? second : first);
  }
}

/** Replaces this tab with the browser's new tab page (Chromium and Firefox alike). */
async function openNewTabHere(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true });
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // Last resort below.
  }
  location.replace('about:blank');
}

function main(): void {
  const b = PAGES.blocked;
  const keys = shortcuts();
  applyDocumentLanguage();
  followSystemTheme(document.documentElement);
  const framed = isFramed();
  if (framed) {
    document.documentElement.dataset['framed'] = '';
    byId('main').setAttribute('aria-label', b.framedLabel);
  }
  const params = parseBlockedPageParams(location.search);
  const loadedAt = performance.timeOrigin;
  const ctx: InfoContext = { tabId: null, params, loadedAt, navigationType: navigationType() };
  const humorIndex = Math.floor(Math.random() * 1_000);

  const title = byId('blocked-title');
  const lockIcon = icon('lock');
  const openIcon = icon('lock-open');
  title.before(lockIcon);
  const remaining = byId('blocked-remaining');
  const announcer = createAnnouncer(byId('blocked-live'));
  const reasonBox = byId('blocked-reason');
  setText(byId('blocked-reason-label'), b.reasonLabel);
  const reasonText = byId('blocked-reason-text');
  const pointsBox = byId('blocked-points');
  const pointsValue = byId('blocked-points-value');
  const pointsNote = byId('blocked-points-note');
  const humor = byId('blocked-humor');
  const back = byId<HTMLButtonElement>('blocked-back');
  const backIcon = icon('corner-up-left', 20);
  const forwardIcon = icon('arrow-right', 20);
  back.prepend(backIcon);
  const backLabel = byId('blocked-back-label');
  const backHelp = byId('blocked-back-help');
  back.setAttribute('aria-describedby', backHelp.id);

  let info: BlockedTabInfo | null = null;
  let snapshot: ExtensionStateSnapshot | null = null;
  let ready = false;
  let endedRefreshed = false;
  let leaving = false;
  let action: BlockedAction = { kind: 'back' };
  let checkingPoll: ReturnType<typeof setTimeout> | null = null;

  const currentBackAction = (): BackAction =>
    backAction({ historyLength: history.length, params, info, loadedAt });

  const render = (now: number): number | null => {
    const view = blockedView({
      params,
      info: framed ? null : info,
      snapshot,
      now,
      humorIndex,
      ready,
    });
    document.title = view.documentTitle;
    setText(title, view.title);
    swapIcon(lockIcon, openIcon, view.phase === 'ended');
    setText(remaining, view.headerValue ?? '');
    // The header value is the only time on the page: a timer with the words in full.
    setAttr(remaining, 'role', view.remainingLabel === null ? null : 'timer');
    setAttr(remaining, 'aria-label', view.remainingLabel);
    // Silent while «Comprobando la hora…»: «Bloqueo terminado» once the phase is `ended`.
    announcer.update(view.announce);

    show(reasonBox, view.reason !== null);
    setText(reasonText, view.reason ?? '');

    const points = view.points;
    if (points === null || points === 'pending') {
      setText(pointsValue, '');
      pointsValue.removeAttribute('data-tone');
      show(pointsNote, false);
    } else {
      setText(pointsValue, points.text);
      setAttr(pointsValue, 'data-tone', points.tone);
      setText(pointsNote, points.note ?? '');
      show(pointsNote, points.note !== null);
    }
    // The line keeps its height while the guardian answers; otherwise nothing is left empty.
    show(pointsBox, points !== null);

    setText(humor, view.humor);

    action = view.action;
    setText(backLabel, view.actionLabel);
    const opening = action.kind === 'open';
    swapIcon(backIcon, forwardIcon, opening);
    back.setAttribute('aria-keyshortcuts', keys[action.kind].label);
    let help: string = b.openHelp;
    if (!opening) help = currentBackAction() === 'history' ? b.backHelpHistory : b.backHelpNewTab;
    setText(backHelp, help);

    if (view.phase === 'checking' && checkingPoll === null) {
      // The background broadcasts new rules; this only covers a missed broadcast.
      checkingPoll = setTimeout(() => {
        checkingPoll = null;
        void getState().then((state) => {
          if (state !== null) snapshot = state;
          ticker.refresh();
        });
      }, CHECKING_POLL_MS);
    }

    if (view.remainingMs !== null && view.remainingMs > 0) endedRefreshed = false;
    else if (view.remainingMs === 0 && !endedRefreshed) {
      // The block may have been extended: ask once more at the end.
      endedRefreshed = true;
      void getState().then((state) => {
        if (state !== null) {
          snapshot = state;
          ticker.refresh();
        }
      });
    }
    return view.nextTickMs;
  };
  const ticker = startTicker(render);

  const accept = (candidate: BlockedTabInfo | null): void => {
    if (candidate === null) return;
    if (isCurrentInfo(candidate, ctx)) {
      info = candidate;
      ticker.refresh();
    }
  };

  const loads: Array<Promise<unknown>> = [];
  if (extensionAvailable()) {
    loads.push(
      getState().then((state) => {
        if (state !== null) snapshot = state;
      }),
    );
    watchState((state) => {
      snapshot = state;
      ticker.refresh();
    });
    if (!framed) {
      loads.push(
        currentTabId().then(async (tabId) => {
          ctx.tabId = tabId;
          if (tabId === null) return;
          // Watch, read, and read again while the guardian's answer is pending: Firefox
          // registers the listener asynchronously, and a write landing meanwhile (the
          // answer usually comes within ms) never reaches it (e2e/firefox/).
          if (sessionStorageUsable()) watchBlockedTabInfo(tabId, accept);
          accept(await readInfo(tabId));
          let polls = 0;
          const poll = (): void => {
            polls += 1;
            if (polls > INFO_POLL_MAX || (info !== null && info.status !== 'reporting')) return;
            void readInfo(tabId).then((next) => {
              accept(next);
              setTimeout(poll, INFO_POLL_MS);
            });
          };
          setTimeout(poll, INFO_POLL_MS);
        }),
      );
    }
  }
  const markReady = (): void => {
    if (ready) return;
    ready = true;
    ticker.refresh();
  };
  void Promise.allSettled(loads).then(markReady);
  setTimeout(markReady, READY_TIMEOUT_MS);

  // A page restored from the back/forward cache asks again (blocks may have changed).
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !extensionAvailable()) return;
    leaving = false;
    void getState().then((state) => {
      if (state !== null) snapshot = state;
      ticker.refresh();
    });
  });

  const runAction = (): void => {
    if (leaving || framed) return;
    leaving = true;
    if (action.kind === 'open') {
      // The block has ended: the page the attempt wanted replaces this one.
      location.replace(action.url);
      return;
    }
    if (currentBackAction() === 'history') {
      const fallback = setTimeout(() => void openNewTabHere(), BACK_FALLBACK_MS);
      window.addEventListener('pagehide', () => clearTimeout(fallback), { once: true });
      history.back();
      return;
    }
    void openNewTabHere().finally(() => {
      leaving = false;
    });
  };
  back.addEventListener('click', runAction);
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === keys[action.kind].code) {
      event.preventDefault();
      runAction();
    }
  });
}

main();
