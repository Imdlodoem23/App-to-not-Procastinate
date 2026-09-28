/**
 * The popup, pure part: the «Bloqueo» section built from the background snapshot (PROMPT §10:
 * the title is the state, a big countdown for the block that ends last, the others as 28 px
 * rows, at most 2, then «y N más»), and its times at a given moment (`popupTimes`).
 */
import { getService } from '@centrate/shared/catalog';
import type { ExtensionStateSnapshot } from '../../background/state';
import { PAGES } from '../i18n';
import type { ModeAccent } from '../shared/blocks';
import { blockTargets, modeAccent, modeLabel, punishmentTitle } from '../shared/blocks';
import {
  formatRemaining,
  formatUntil,
  nextMinuteDelay,
  nextTickDelay,
  parseIso,
} from '../shared/format';
import type { AnnounceInput } from '../shared/phase';
import { endPhase } from '../shared/phase';

/** Rows under the countdown before «y N más». */
export const MAX_ROWS = 2;

export interface BlockRow {
  key: string;
  /** «Reddit · Normal», «Descanso: YouTube». */
  title: string;
  endsAt: number | null;
}

export interface BlockSection {
  /** «Bloqueo: YouTube, Instagram · Estricto», «Bloqueo: ninguno». */
  title: string;
  /**
   * `title` first, then shorter versions («Bloqueo: YouTube +2 · Estricto»): the popup shows
   * the first that fits on one line beside «hasta 17:42» (never clipped).
   */
  titles: string[];
  /** The block that ends last (its id); `null` when nothing is blocked («Bloqueo: ninguno»). */
  key: string | null;
  /** The block that ends last (its countdown); `null` when none or its end is unknown. */
  endsAt: number | null;
  accent: ModeAccent | null;
  /** «tu motivo», in italics on the help line. */
  reason: string | null;
  rows: BlockRow[];
  /** Rows left out («y 3 más»). */
  more: number;
  /** Help line when nothing is blocked. */
  emptyHelp: string | null;
}

/**
 * `null` hides the section: not paired and nothing cached (the pairing form is the popup's
 * only content then).
 */
export function blockSection(state: ExtensionStateSnapshot | null): BlockSection | null {
  if (state === null) return null;
  const rules = state.rules;
  if (!state.paired && (rules === null || rules.blocks.length === 0)) return null;
  const p = PAGES.popup;
  const blocks = rules?.blocks ?? [];
  const [primary, ...others] = blocks;
  if (primary === undefined) {
    return {
      title: p.blockNone,
      titles: [p.blockNone],
      key: null,
      endsAt: null,
      accent: null,
      reason: null,
      rows: allowanceRows(state).slice(0, MAX_ROWS),
      more: Math.max(0, allowanceRows(state).length - MAX_ROWS),
      emptyHelp: p.blockNoneHelp,
    };
  }
  const level = rules?.punishment?.level ?? null;
  const titles =
    primary.kind === 'punishment'
      ? [punishmentTitle(level)]
      : [2, 1].map((maxNames) =>
          p.block(blockTargets(primary, maxNames, 'inline'), modeLabel(primary.mode)),
        );
  const title = titles[0] ?? p.blockNone;
  const reason = primary.reason.trim();
  const rows: BlockRow[] = [
    ...others.map((block) => ({
      key: `block:${block.id}`,
      title:
        block.kind === 'punishment'
          ? punishmentTitle(level)
          : p.row(blockTargets(block), modeLabel(block.mode)),
      endsAt: parseIso(block.endsAt),
    })),
    ...allowanceRows(state),
  ];
  return {
    title,
    titles: [...new Set(titles)],
    key: `block:${primary.id}`,
    endsAt: parseIso(primary.endsAt),
    accent: modeAccent(primary.mode, primary.kind),
    reason: reason.length > 0 ? reason : null,
    rows: rows.slice(0, MAX_ROWS),
    more: Math.max(0, rows.length - MAX_ROWS),
    emptyHelp: null,
  };
}

/** Earned breaks («Descanso: YouTube») still running. */
function allowanceRows(state: ExtensionStateSnapshot): BlockRow[] {
  return (state.rules?.allowances ?? []).map((allowance) => ({
    key: `allowance:${allowance.serviceId}`,
    title: PAGES.popup.allowance(getService(allowance.serviceId)?.name ?? allowance.serviceId),
    endsAt: parseIso(allowance.endsAt),
  }));
}

/** The section's times at one moment. */
export interface PopupTimes {
  /**
   * The header value: «hasta 17:42» while the block runs, «Comprobando la hora…» once its
   * end has passed while the snapshot still lists it (never a clock time already past),
   * `''` without a known end.
   */
  until: string;
  /** Time left on the big countdown and its bar; `null` hides both (none, or checking). */
  countdownMs: number | null;
  /** Each row's value, in `rows` order: «quedan 12 min», «Comprobando la hora…» or `''`. */
  rowValues: string[];
  /** What the live region follows (shared/phase.ts). */
  announce: AnnounceInput;
  /** Delay until the next visible change; `null`: none (broadcasts re-render). */
  nextTickMs: number | null;
}

/**
 * The popup's times (PROMPT §10), with blocked.html's rule for an end that has passed
 * (shared/phase.ts `endPhase`): everything the snapshot lists is still enforced, so a past
 * end reads «Comprobando la hora…», never 0:00, «quedan 0 min» or «Bloqueo terminado».
 */
export function popupTimes(section: BlockSection | null, now: number): PopupTimes {
  const checking = PAGES.blocked.checking;
  let nextTickMs: number | null = null;
  const consider = (delay: number | null): void => {
    if (delay !== null && (nextTickMs === null || delay < nextTickMs)) nextTickMs = delay;
  };

  let until = '';
  let countdownMs: number | null = null;
  let announce: AnnounceInput = { kind: 'none' };
  if (section !== null && section.key === null) {
    // Nothing blocked any more: the block the region followed (if any) has gone.
    announce = { kind: 'ended' };
  } else if (section !== null && section.key !== null && section.endsAt !== null) {
    const { key, endsAt } = section;
    if (endPhase(endsAt, now, true) === 'running') {
      countdownMs = endsAt - now;
      until = formatUntil(endsAt, now);
      announce = { kind: 'counting', key, remainingMs: countdownMs };
      consider(nextTickDelay(countdownMs));
    } else {
      until = checking;
      announce = { kind: 'checking', key };
    }
  }

  const rowValues = (section?.rows ?? []).map((row) => {
    if (row.endsAt === null) return '';
    if (endPhase(row.endsAt, now, true) !== 'running') return checking;
    const remainingMs = row.endsAt - now;
    // Rows show whole minutes: the next change is the next minute (and the end).
    consider(nextMinuteDelay(remainingMs));
    return formatRemaining(remainingMs);
  });

  return { until, countdownMs, rowValues, announce, nextTickMs };
}
