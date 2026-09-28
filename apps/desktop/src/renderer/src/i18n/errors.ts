/**
 * Guardian errors as Spanish copy with one action (docs/DESKTOP.md §7.5). Every renderer shows
 * a `UiError` through `errorCopy`: clear, short, with a way forward, never blaming.
 *
 * Transport kinds (`timeout`, `unreachable`, `not_installed`, `unauthorized`, `incompatible`,
 * `read_only`) are decided by `kind`; guardian rejections by `code`; anything else reads
 * «Algo ha fallado en el guardián» with «Detalles…». Pure.
 */
import type { UiError } from '../../../shared/ui-state';
import { RENDERER_ES } from './es';

export type ErrorAction = 'retry' | 'repair' | 'details' | 'edit' | null;

export interface ErrorCopy {
  text: string;
  /** The one action the copy offers (`null`: nothing to do). */
  action: ErrorAction;
  /** «Reintentar · Reparar»: the guardian did not answer, so «Reparar» joins «Reintentar». */
  repair: boolean;
}

const E = RENDERER_ES.errors;

/** Copy of guardian rejections (`kind: 'rejected'`), by error code. */
const BY_CODE: Readonly<Record<string, { text: string; action: ErrorAction }>> = {
  extension_exceeds_max: { text: E.extensionExceedsMax, action: 'edit' },
  block_not_active: { text: E.blockNotActive, action: null },
  not_extendable: { text: E.notExtendable, action: null },
  duration_out_of_range: { text: E.durationOutOfRange, action: 'edit' },
  too_many_targets: { text: E.tooManyTargets, action: 'edit' },
  protected_target: { text: E.protectedTarget, action: 'edit' },
  unknown_id: { text: E.unknownId, action: 'repair' },
  phrase_mismatch: { text: E.phraseMismatch, action: 'edit' },
  confirm_word_mismatch: { text: E.confirmWordMismatch, action: 'edit' },
  emergency_not_ready: { text: E.emergencyNotReady, action: null },
  emergency_expired: { text: E.emergencyExpired, action: null },
  emergency_in_progress: { text: E.emergencyInProgress, action: null },
  emergency_not_available: { text: E.emergencyNotAvailable, action: null },
  emergency_moot: { text: E.emergencyMoot, action: null },
  rate_limited: { text: E.rateLimited, action: 'retry' },
};

function copy(text: string, action: ErrorAction, repair = false): ErrorCopy {
  return { text, action, repair };
}

export function errorCopy(error: UiError): ErrorCopy {
  switch (error.kind) {
    case 'timeout':
    case 'unreachable':
      return copy(E.unresponsive, 'retry', true);
    case 'not_installed':
      return copy(E.notInstalled, 'repair');
    case 'unauthorized':
    case 'incompatible':
      return copy(E.outdated, 'repair');
    case 'read_only':
      return copy(E.readOnly, 'details');
    default:
      break;
  }
  if (error.code === 'data_delete_blocked') {
    const reason = error.details?.['reason'];
    const why = typeof reason === 'string' ? E.dataDeleteReasons[reason] : undefined;
    return copy(why ? E.withReason(E.dataDeleteBlocked, why) : E.dataDeleteBlocked, null);
  }
  if (error.kind === 'rejected') {
    const known = BY_CODE[error.code];
    if (known) return copy(known.text, known.action);
  }
  return copy(E.generic, 'details');
}

/** Label of an error action button («Reintentar», «Reparar», «Detalles…», «Editar…»). */
export function errorActionLabel(action: Exclude<ErrorAction, null>): string {
  return E.actions[action];
}
