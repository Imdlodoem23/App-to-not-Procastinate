/**
 * Renderer errors go to main's app log (`app:renderer-error`, scrubbed there): render errors
 * from the `ErrorBoundary`, plus `window.onerror` and `unhandledrejection`.
 */
import type { CentrateBridge } from '../../../shared/ipc';
import { errorPayload, isBenignError } from './error-payload';

export { errorPayload, isBenignError } from './error-payload';

export function reportError(
  bridge: CentrateBridge | null,
  error: unknown,
  extraStack: string | null = null,
): void {
  const payload = errorPayload(error, extraStack);
  if (isBenignError(payload.message)) return;
  try {
    bridge?.send('app:renderer-error', payload);
  } catch {
    // Reporting must never throw.
  }
}

/** `window.onerror` and `unhandledrejection` → main's log. */
export function installErrorReporting(bridge: CentrateBridge): () => void {
  const onError = (event: ErrorEvent): void => {
    if (isBenignError(event.message ?? '')) {
      event.preventDefault();
      return;
    }
    reportError(bridge, event.error ?? event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => reportError(bridge, event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
