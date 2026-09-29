/**
 * When a block's time is up, as the popup and blocked.html both say it (pure; PROMPT §10,
 * docs/ARCHITECTURE.md §10.2). A block the rules still list is still enforced after its
 * `endsAt`: the guardian's boot hold keeps it until it confirms the time, or its new rules
 * are on their way. Meanwhile the pages say «Comprobando la hora…», never 0:00,
 * «hasta 05:50» in the past, «quedan 0 min» or «Bloqueo terminado», and the screen reader
 * hears «Bloqueo terminado» only once the block has really gone.
 */
import { PAGES } from '../i18n';
import { countdownAnnouncement } from './format';

/**
 * `running`: the end is ahead (or unknown: an unreadable end never ends a block).
 * `checking`: the end has passed but the block is still enforced. `ended`: nothing enforces
 * it any more.
 */
export type EndPhase = 'running' | 'checking' | 'ended';

/** `enforced`: the rules (or what the page knows) still list the block. */
export function endPhase(endsAt: number | null, now: number, enforced: boolean): EndPhase {
  if (endsAt === null || endsAt > now) return 'running';
  return enforced ? 'checking' : 'ended';
}

/** What a page's `aria-live` region follows, on every render. */
export type AnnounceInput =
  /** A block counting down (`key` names it: another key starts over, silently). */
  | { kind: 'counting'; key: string; remainingMs: number }
  /** Its end has passed and it is still enforced: silent. */
  | { kind: 'checking'; key: string }
  /** The block has gone (left the rules, or blocked.html reached `ended`). */
  | { kind: 'ended' }
  /** Nothing known (loading, no block, an unknown end): silent, and forgets. */
  | { kind: 'none' };

export interface EndAnnouncer {
  /** What to say now, or `null`. */
  next(input: AnnounceInput): string | null;
}

/**
 * The polite live region's logic: «Quedan 15 minutos» (and 5, 1) when a running block
 * crosses a mark (`countdownAnnouncement`), and «Bloqueo terminado» on the move to `ended`
 * from a block seen counting or held, never when the time merely crosses 0.
 */
export function createEndAnnouncer(): EndAnnouncer {
  let tracked: string | null = null;
  let lastMs: number | null = null;
  return {
    next(input) {
      let said: string | null = null;
      switch (input.kind) {
        case 'counting':
          if (tracked === input.key && lastMs !== null) {
            said = countdownAnnouncement(lastMs, input.remainingMs);
          }
          tracked = input.key;
          lastMs = input.remainingMs;
          break;
        case 'checking':
          tracked = input.key;
          lastMs = null;
          break;
        case 'ended':
          if (tracked !== null) said = PAGES.common.remaining.ended;
          tracked = null;
          lastMs = null;
          break;
        case 'none':
          tracked = null;
          lastMs = null;
          break;
      }
      return said;
    },
  };
}
