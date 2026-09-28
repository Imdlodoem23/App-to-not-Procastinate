/**
 * What a renderer error becomes in main's app log (`app:renderer-error`), pure: trimmed to the
 * send guard's limits. The «ResizeObserver loop» notice is benign (the auto-height measure can
 * resize what it observes within one frame) and never reported.
 */

const MAX_MESSAGE = 2_000;
const MAX_STACK = 20_000;

export function isBenignError(message: string): boolean {
  return message.startsWith('ResizeObserver loop');
}

export function errorPayload(
  error: unknown,
  extraStack: string | null = null,
): { message: string; stack: string | null } {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown error');
  const stack = [error instanceof Error ? (error.stack ?? '') : '', extraStack ?? '']
    .filter((part) => part !== '')
    .join('\n');
  return {
    message: message.slice(0, MAX_MESSAGE),
    stack: stack === '' ? null : stack.slice(0, MAX_STACK),
  };
}
