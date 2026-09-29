/**
 * The guardian link rule (docs/DESKTOP.md §6.1), pure:
 *
 * - A request that fails with a transient error (connection refused or reset, a 5xx, a rate
 *   limit) counts one failure and asks for one retry after 1 s; a second consecutive failure
 *   sets the link `down`. So a single blip never shows the warning, and a stopped guardian
 *   shows it 1–3 s after the failure.
 * - Deterministic failures go `down` at once: `client.json` missing (`not_installed`), a 401
 *   after re-reading the token (`unauthorized`), an API the app does not speak
 *   (`incompatible`) and a **timeout** (3 s without an answer is already a real failure;
 *   waiting for a second one would show the warning 7–9 s late, over the 5 s budget).
 * - Any success sets `ok` with `failures: 0`.
 *
 * Only transitions produce a new `GuardianLink` object (the counter lives in the poller), so
 * a steady state publishes nothing.
 */
import type { GuardianLink, LinkDownReason, UiError } from '../../shared/ui-state';

export function linkDownReason(error: UiError): LinkDownReason {
  switch (error.kind) {
    case 'not_installed':
      return 'not_installed';
    case 'timeout':
      return 'timeout';
    case 'unauthorized':
      return 'unauthorized';
    case 'incompatible':
    case 'invalid_response':
      return 'incompatible';
    default:
      return 'unreachable';
  }
}

const IMMEDIATE: ReadonlySet<LinkDownReason> = new Set([
  'not_installed',
  'timeout',
  'unauthorized',
  'incompatible',
]);

export interface LinkStep {
  link: GuardianLink;
  failures: number;
  /** Schedule the quick retry (`UI_TIMINGS.linkRetryMs`) instead of the normal cadence. */
  retry: boolean;
}

export function linkOnSuccess(link: GuardianLink, nowMs: number): LinkStep {
  if (link.status === 'ok' && link.failures === 0) return { link, failures: 0, retry: false };
  return {
    link: { status: 'ok', reason: null, since: nowMs, lastOkAt: nowMs, failures: 0 },
    failures: 0,
    retry: false,
  };
}

export function linkOnFailure(
  link: GuardianLink,
  failures: number,
  error: UiError,
  nowMs: number,
): LinkStep {
  const reason = linkDownReason(error);
  const count = failures + 1;
  if (link.status === 'down') {
    if (link.reason === reason) return { link, failures: count, retry: false };
    return { link: { ...link, reason, failures: count }, failures: count, retry: false };
  }
  if (IMMEDIATE.has(reason) || count >= 2) {
    return {
      link: { status: 'down', reason, since: nowMs, lastOkAt: link.lastOkAt, failures: count },
      failures: count,
      retry: false,
    };
  }
  return { link, failures: count, retry: true };
}

/** `apiVersion` the guardian reports is not the one this app speaks. */
export function incompatibleLink(link: GuardianLink, nowMs: number): GuardianLink {
  if (link.status === 'down' && link.reason === 'incompatible') return link;
  return {
    status: 'down',
    reason: 'incompatible',
    since: nowMs,
    lastOkAt: link.lastOkAt,
    failures: link.failures,
  };
}
