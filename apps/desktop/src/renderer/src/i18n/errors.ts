/**
 * Guardian errors as Spanish copy with one action (docs/DESKTOP.md §7.5). Every renderer shows
 * a `UiError` through `errorCopy`: clear, short, with a way forward, never blaming.
 *
 * Transport kinds (`timeout`, `unreachable`, `not_installed`, `unauthorized`, `incompatible`,
 * `read_only`) are decided by `kind`; guardian rejections by `code`; anything else reads
 * «Algo ha fallado en el guardián» with «Detalles…». Pure.
 */
import type { UiError } from '../../../shared/ui-state';
import { RENDERER, type RendererMessages } from './messages';

export type ErrorAction = 'retry' | 'repair' | 'details' | 'edit' | null;

export interface ErrorCopy {
  text: string;
  /** The one action the copy offers (`null`: nothing to do). */
  action: ErrorAction;
  /** «Reintentar · Reparar»: the guardian did not answer, so «Reparar» joins «Reintentar». */
  repair: boolean;
}

const E = RENDERER.errors;

type RejectionKey = {
  [K in keyof RendererMessages['errors']]: RendererMessages['errors'][K] extends string ? K : never;
}[keyof RendererMessages['errors']];

/** Copy of guardian rejections (`kind: 'rejected'`), by error code (read at call time). */
const BY_CODE: Readonly<Record<string, { text: RejectionKey; action: ErrorAction }>> = {
  extension_exceeds_max: { text: 'extensionExceedsMax', action: 'edit' },
  block_not_active: { text: 'blockNotActive', action: null },
  not_extendable: { text: 'notExtendable', action: null },
  duration_out_of_range: { text: 'durationOutOfRange', action: 'edit' },
  too_many_targets: { text: 'tooManyTargets', action: 'edit' },
  protected_target: { text: 'protectedTarget', action: 'edit' },
  unknown_id: { text: 'unknownId', action: 'repair' },
  phrase_mismatch: { text: 'phraseMismatch', action: 'edit' },
  confirm_word_mismatch: { text: 'confirmWordMismatch', action: 'edit' },
  emergency_not_ready: { text: 'emergencyNotReady', action: null },
  emergency_expired: { text: 'emergencyExpired', action: null },
  emergency_in_progress: { text: 'emergencyInProgress', action: null },
  emergency_not_available: { text: 'emergencyNotAvailable', action: null },
  emergency_moot: { text: 'emergencyMoot', action: null },
  rate_limited: { text: 'rateLimited', action: 'retry' },
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
    if (known) return copy(E[known.text], known.action);
  }
  return copy(E.generic, 'details');
}

/** Label of an error action button («Reintentar», «Reparar», «Detalles…», «Editar…»). */
export function errorActionLabel(action: Exclude<ErrorAction, null>): string {
  return E.actions[action];
}
