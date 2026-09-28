/**
 * The pages' side of the background message API (background/state.ts): the snapshot, its
 * broadcasts, pairing, the guide and the host permission. Every call fails soft (`null`):
 * a page must still render when the background is starting or was just updated.
 */
import type {
  BackgroundFailure,
  ExtensionStateSnapshot,
  GuideSection,
  PairResult,
} from '../../background/state';
import { MESSAGE_TYPES, onStateChanged, sendToBackground } from '../../background/state';

/** The host permission every redirect rule needs (same as background/heartbeat.ts). */
export const ALL_URLS_ORIGINS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/** True inside an extension page (false when a page is opened some other way). */
export function extensionAvailable(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime?.id === 'string' &&
    typeof chrome.runtime.sendMessage === 'function'
  );
}

function stateOf(response: unknown): ExtensionStateSnapshot | null {
  const r = response as { ok?: unknown; state?: unknown } | null | undefined;
  if (r?.ok !== true || typeof r.state !== 'object' || r.state === null) return null;
  const state = r.state as Partial<ExtensionStateSnapshot>;
  return state.v === 1 ? (state as ExtensionStateSnapshot) : null;
}

/** The current snapshot, or `null` if the background did not answer. */
export async function getState(): Promise<ExtensionStateSnapshot | null> {
  if (!extensionAvailable()) return null;
  try {
    return stateOf(await sendToBackground({ type: MESSAGE_TYPES.getState }));
  } catch {
    return null;
  }
}

/** Asks the background to sync and send a heartbeat now; returns the snapshot. */
export async function refreshState(): Promise<ExtensionStateSnapshot | null> {
  if (!extensionAvailable()) return null;
  try {
    return stateOf(await sendToBackground({ type: MESSAGE_TYPES.refresh }));
  } catch {
    return null;
  }
}

/** Calls `listener` with every snapshot the background broadcasts; returns the unsubscribe. */
export function watchState(listener: (state: ExtensionStateSnapshot) => void): () => void {
  if (!extensionAvailable()) return () => undefined;
  return onStateChanged((state) => {
    if (state.v === 1) listener(state);
  });
}

export type PairAnswer = PairResult | BackgroundFailure | null;

/** Claims a token with the 6-digit code (and the port when the app shows one). */
export async function pair(code: string, port?: number): Promise<PairAnswer> {
  if (!extensionAvailable()) return null;
  try {
    const request =
      port === undefined
        ? { type: MESSAGE_TYPES.pair, code }
        : { type: MESSAGE_TYPES.pair, code, port };
    const answer = (await sendToBackground(request)) as PairAnswer | undefined;
    return answer ?? null;
  } catch {
    return null;
  }
}

/** Opens the guide (options page) in a tab, at `section`. */
export async function openGuide(section?: GuideSection): Promise<void> {
  if (!extensionAvailable()) return;
  try {
    const answer = await sendToBackground(
      section === undefined
        ? { type: MESSAGE_TYPES.openGuide }
        : { type: MESSAGE_TYPES.openGuide, section },
    );
    if (answer?.ok === true) return;
  } catch {
    // Fall through: the background may be restarting.
  }
  await chrome.runtime.openOptionsPage().catch(() => undefined);
}

/**
 * Asks for `<all_urls>` (must run inside a click handler). Resolves `true` when granted.
 * The background hears `permissions.onAdded` and re-sends its heartbeat by itself.
 */
export async function requestHostPermission(): Promise<boolean> {
  if (!extensionAvailable()) return false;
  const granted = await chrome.permissions.request(ALL_URLS_ORIGINS);
  if (granted) void refreshState();
  return granted;
}
