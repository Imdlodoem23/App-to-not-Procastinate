/**
 * The active-window layer's decisions (PROMPT §5 capa 4, ARCHITECTURE §10.8). Pure.
 *
 * Every ~2 s while a block is active, main reads the foreground window's title and process. A
 * title that names a catalog service the active blocks cover («… - YouTube - Google Chrome»)
 * is reported to the guardian as an attempt (`layer: "window"`, `target: {type: "service"}`:
 * the only thing the app token may report). The guardian decides whether it counts, merges a
 * detection of the same service within 30 s (the window slides) and charges the points.
 *
 * Privacy: only a covered service's catalog id ever leaves this module; titles of anything
 * else (and every title of a protected process, such as a file manager folder called «Steam»)
 * are dropped here and never logged.
 */
import {
  findBrowsersByProcessName,
  findServiceByWindowTitle,
  getService,
  isProtectedProcessName,
  type CatalogPlatform,
} from '@centrate/shared/catalog';
import type { BrowserFamily } from '@centrate/shared/domain';
import type { GuardianStateResponse } from '@centrate/shared/guardian-api';
import type { Platform } from '../../shared/ui-state';

/** Poll interval while a block is active (PROMPT: «cada ~2 s»). */
export const ACTIVE_WINDOW_POLL_MS = 2_000;
/**
 * While the same covered service stays in front, it is reported again this often, well inside
 * the guardian's 30 s dedupe window: staying on the page stays one attempt, and coming back
 * within 30 s of the last sighting merges too («reaparece en menos de 30 s»).
 */
export const ACTIVE_WINDOW_REFRESH_MS = 10_000;
/** After a failed read, wait this long before the next one. */
export const ACTIVE_WINDOW_ERROR_BACKOFF_MS = 10_000;
/** macOS without Screen Recording: check the permission again this often. */
export const ACTIVE_WINDOW_PERMISSION_RECHECK_MS = 30_000;

/** What the OS says is in front. */
export interface ForegroundWindow {
  title: string;
  /** Executable base name («chrome.exe», «Google Chrome», «firefox»); `null` when unknown. */
  process: string | null;
}

export function catalogPlatform(platform: Platform): CatalogPlatform {
  return platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
}

/**
 * The catalog service a foreground window shows, if any. Titles of protected processes (file
 * managers, terminals, the system…) never count, whatever they say.
 */
export function serviceOfWindow(win: ForegroundWindow): string | null {
  const title = win.title.trim();
  if (title === '' || title.length > 1_024) return null;
  if (win.process !== null && isProtectedProcessName(win.process)) return null;
  return findServiceByWindowTitle(title)?.id ?? null;
}

/** Whether any block is active (the layer watches only then). */
export function hasActiveBlock(state: GuardianStateResponse | null): boolean {
  return (state?.blocks.length ?? 0) > 0;
}

/**
 * Whether the active blocks cover `serviceId` right now: a block lists it or one of its
 * categories, or a whitelist block is active (a catalog service is never on a whitelist), and
 * no redeemed allowance has opened it. The guardian checks again; this only keeps the app
 * from reporting what nothing blocks.
 */
export function isServiceCovered(state: GuardianStateResponse | null, serviceId: string): boolean {
  if (!state) return false;
  const service = getService(serviceId);
  if (!service) return false;
  if (state.allowances.some((a) => a.serviceId === serviceId && a.status === 'active'))
    return false;
  return state.blocks.some(
    (b) =>
      b.whitelistOnly ||
      b.targets.serviceIds.includes(serviceId) ||
      b.targets.categoryIds.some((c) => service.categories.includes(c)),
  );
}

/** The extension family of a browser process (the guardian keeps it with the attempt). */
export function browserOfProcess(process: string | null, platform: Platform): BrowserFamily | null {
  if (process === null) return null;
  return findBrowsersByProcessName(process, catalogPlatform(platform))[0]?.extensionFamily ?? null;
}

/**
 * When to report: a covered service that just came to the front, or the same one again after
 * `ACTIVE_WINDOW_REFRESH_MS`. Anything else (nothing covered in front) resets it.
 */
export class ReportThrottle {
  private current: string | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly refreshMs: number = ACTIVE_WINDOW_REFRESH_MS) {}

  /** `serviceId`: the covered service in front now (`null`: none). */
  shouldReport(serviceId: string | null, now: number): boolean {
    if (serviceId === null) {
      this.current = null;
      return false;
    }
    if (serviceId !== this.current || now - this.lastAt >= this.refreshMs) {
      this.current = serviceId;
      this.lastAt = now;
      return true;
    }
    return false;
  }

  reset(): void {
    this.current = null;
    this.lastAt = Number.NEGATIVE_INFINITY;
  }
}
