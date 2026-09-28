/**
 * What the popup and the guide say about the protection (pure): the connection line
 * («● Guardián conectado» / «● Guardián no responde»), the warnings with their action, and
 * whether the pairing form shows. Input: the background snapshot (background/state.ts).
 */
import type {
  ExtensionProblem,
  ExtensionStateSnapshot,
  GuideSection,
} from '../../background/state';
import { PAGES_ES } from '../i18n/es';
import { formatClock } from './format';

/** Accent of a dot or a notice (`neutral`: nothing wrong, nothing to do). */
export type Tone = 'green' | 'orange' | 'red' | 'neutral';

export interface ConnectionLine {
  tone: Tone;
  text: string;
}

/** The status dot and its text. `null` snapshot: the background did not answer. */
export function connectionLine(state: ExtensionStateSnapshot | null): ConnectionLine {
  const s = PAGES_ES.status;
  if (state === null) return { tone: 'neutral', text: s.connecting };
  if (!state.paired) return { tone: 'neutral', text: s.notPaired };
  if (state.problems.includes('unauthorized')) return { tone: 'red', text: s.unauthorized };
  switch (state.link) {
    case 'connected':
      return { tone: 'green', text: s.connected };
    case 'unknown':
      return { tone: 'neutral', text: s.connecting };
    case 'unreachable':
      return { tone: 'orange', text: s.unreachable };
    case 'unauthorized':
      return { tone: 'red', text: s.unauthorized };
    case 'untrusted':
      return { tone: 'red', text: s.untrusted };
    case 'error':
      return { tone: 'orange', text: s.error };
  }
}

export type NoticeAction =
  | { kind: 'grant'; label: string; help: string }
  | { kind: 'guide'; section: GuideSection; label: string; help: string }
  | { kind: 'retry'; label: string; help: string };

export interface Notice {
  problem: ExtensionProblem;
  tone: 'orange' | 'red';
  text: string;
  action: NoticeAction | null;
}

const RETRY: NoticeAction = {
  kind: 'retry',
  label: PAGES_ES.common.retry,
  help: PAGES_ES.common.retryHelp,
};

function guide(section: GuideSection, label: string): NoticeAction {
  return { kind: 'guide', section, label, help: PAGES_ES.notices.actions.howToHelp };
}

/**
 * One warning per problem, in the snapshot's order (most important first). `not_paired`
 * has none: the pairing form is the message.
 */
export function noticesFor(state: ExtensionStateSnapshot | null): Notice[] {
  if (state === null) return [];
  const n = PAGES_ES.notices;
  const hasRules = (state.rules?.blocks.length ?? 0) > 0;
  const notices: Notice[] = [];
  for (const problem of state.problems) {
    switch (problem) {
      case 'not_paired':
        break;
      case 'unauthorized':
        notices.push({ problem, tone: 'red', text: n.unauthorized, action: null });
        break;
      case 'host_permission_missing':
        notices.push({
          problem,
          tone: 'red',
          text: n.host_permission_missing,
          action: { kind: 'grant', label: n.actions.grant, help: n.actions.grantHelp },
        });
        break;
      case 'guardian_unreachable':
        notices.push({
          problem,
          tone: 'orange',
          text: hasRules ? n.guardian_unreachable : n.guardian_unreachable_empty,
          action: RETRY,
        });
        break;
      case 'untrusted_rules':
        notices.push({ problem, tone: 'orange', text: n.untrusted_rules, action: RETRY });
        break;
      case 'browser_mismatch':
        notices.push({ problem, tone: 'red', text: n.browser_mismatch, action: null });
        break;
      case 'peer_not_browser':
        notices.push({
          problem,
          tone: 'red',
          text: n.peer_not_browser,
          action: guide('troubleshooting', n.actions.guide),
        });
        break;
      case 'origin_not_allowed':
        notices.push({
          problem,
          tone: 'red',
          text: n.origin_not_allowed,
          action: guide('troubleshooting', n.actions.guide),
        });
        break;
      case 'guardian_error':
        notices.push({ problem, tone: 'orange', text: n.guardian_error, action: RETRY });
        break;
      case 'incognito_not_allowed':
        notices.push({
          problem,
          tone: 'orange',
          text: n.incognito_not_allowed(state.browser?.family ?? null),
          action: guide('incognito', n.actions.howTo),
        });
        break;
    }
  }
  return notices;
}

/** Whether the pairing form shows, and with which header. */
export function pairingNeed(state: ExtensionStateSnapshot | null): 'none' | 'first' | 'again' {
  if (state === null) return 'none';
  if (!state.paired) return 'first';
  if (state.problems.includes('unauthorized') || state.problems.includes('browser_mismatch')) {
    return 'again';
  }
  return 'none';
}

/**
 * «Reintentar» in the footer: paired and the guardian is not answering well, unless a
 * warning above already offers it (one «Reintentar» per window).
 */
export function canRetry(state: ExtensionStateSnapshot | null): boolean {
  return (
    state !== null &&
    state.paired &&
    state.link !== 'connected' &&
    state.link !== 'unknown' &&
    state.link !== 'unauthorized' &&
    !noticesFor(state).some((notice) => notice.action?.kind === 'retry')
  );
}

/** Whether the popup offers «Reintentar» at all (in a warning or in the footer). */
export function retryOffered(state: ExtensionStateSnapshot | null): boolean {
  return canRetry(state) || noticesFor(state).some((notice) => notice.action?.kind === 'retry');
}

/** What a «Reintentar» that did not fix it leaves on screen (PROMPT §10: a dated fact). */
export interface RetryResult {
  /** Next to the warning's tile: «Sigue sin responder · comprobado a las 17:42». */
  notice: string;
  /** The footer line, when its own tile ran: «Guardián no responde · comprobado a las 17:42». */
  footer: string;
}

/**
 * After a «Reintentar» that ran at `checkedAt` (`null`: none yet). `null` when there is
 * nothing to say: no retry has run, or the problem is gone (the warning disappears and the
 * footer's `role="status"` already says «Guardián conectado»).
 */
export function retryResult(
  state: ExtensionStateSnapshot | null,
  checkedAt: number | null,
): RetryResult | null {
  if (checkedAt === null || state === null || !retryOffered(state)) return null;
  const p = PAGES_ES.popup;
  const checked = p.checkedAt(formatClock(checkedAt));
  return {
    notice: p.retryStill(state.link === 'unreachable', checked),
    footer: p.footerChecked(connectionLine(state).text, checked),
  };
}
