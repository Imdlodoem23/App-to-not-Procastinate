/**
 * The Nuclear overlay (PROMPT §10 «Nuclear», ARCHITECTURE §10.5), pure. While
 * `state.nuclearActive` holds, every display shows:
 *
 * - «Castigo · vuelves a las 18:40» (`nuclearEndsAt`, the latest Nuclear end) and the 72 px
 *   countdown to it;
 * - what caused it and what it cost, as data: «3 strikes en "mates"» · «−100 puntos»;
 * - one secondary «Salida de emergencia». Its only way out is the emergency unlock, so the
 *   button opens that flow (`nuclear:emergency-exit`, main shows Emergencia above the overlay)
 *   after an in-place «¿Seguro?» whose help line gives the price: the guardian's rule
 *   (`emergencyPenalty` of the balance) and the streak, plus the wait (30 min for a strict
 *   punishment). The Emergencia window then asks for the typed phrase and runs the wait.
 *   When an emergency is already counting or ready, the button opens it at once and the help
 *   line says where it stands (the friction was already paid).
 */
import type { IsoUtc } from '@centrate/shared/domain';
import {
  EMERGENCY_RULES,
  POINT_RULES,
  emergencyCountdownMinutes,
  emergencyPenalty,
} from '@centrate/shared/points';
import { formatClock, formatPoints } from '../../../../shared/format';
import {
  activePunishment,
  nuclearEndsAt,
  nuclearPunishment,
  type UiSnapshot,
} from '../../../../shared/ui-state';
import { NUCLEAR } from './i18n';

/** Armed id of the in-place «¿Seguro?» (`detail.armed` of this window, fixture-settable). */
export const NUCLEAR_EXIT_ARM_ID = 'nuclear-exit';

export type NuclearExit =
  /** First press arms «¿Seguro? Salida de emergencia»; the second opens the flow. */
  | { kind: 'arm'; help: string; consequence: string }
  /** An emergency is counting: the help line counts down to `readyAt` (orange). */
  | { kind: 'counting'; help: string; readyAt: IsoUtc }
  /** An emergency is ready to confirm. */
  | { kind: 'ready'; help: string };

export interface NuclearView {
  /** `false` once the guardian no longer says Nuclear (main hides the windows). */
  active: boolean;
  title: string;
  /** The countdown's end; `null` when the guardian has not given one yet. */
  endsAt: IsoUtc | null;
  /** «3 strikes en "mates"»; `null` when no punishment is known. */
  cause: string | null;
  /** «−100 puntos» (what the punishment cost). */
  points: string | null;
  exit: NuclearExit;
}

function exitView(snapshot: UiSnapshot): NuclearExit {
  const state = snapshot.state;
  const emergency = state?.emergency ?? null;
  if (emergency?.status === 'counting') {
    return { kind: 'counting', help: NUCLEAR.exit.counting, readyAt: emergency.readyAt };
  }
  if (emergency?.status === 'ready') return { kind: 'ready', help: NUCLEAR.exit.ready };

  const eligible = (state?.blocks ?? []).filter((b) => b.emergencyEligible).map((b) => b.mode);
  const minutes = emergencyCountdownMinutes(eligible) ?? EMERGENCY_RULES.countdownMinutes.strict;
  const points = state?.points;
  const penalty = emergencyPenalty(points?.balance ?? 0);
  return {
    kind: 'arm',
    help: NUCLEAR.exit.help(minutes),
    consequence: NUCLEAR.exit.consequence(formatPoints(penalty), points?.streakDays ?? 0, minutes),
  };
}

export function deriveNuclearView(snapshot: UiSnapshot): NuclearView {
  const state = snapshot.state;
  const endsAt = nuclearEndsAt(state);
  const punishment =
    nuclearPunishment(state) ?? (state?.nuclearActive ? activePunishment(state) : null);
  return {
    active: state?.nuclearActive ?? false,
    title: endsAt ? NUCLEAR.title(formatClock(Date.parse(endsAt))) : NUCLEAR.titleNoEnd,
    endsAt,
    cause: punishment ? NUCLEAR.cause(punishment.cause, punishment.task) : null,
    points: punishment ? formatPoints(-POINT_RULES.punishmentPenalty, { signed: true }) : null,
    exit: exitView(snapshot),
  };
}
