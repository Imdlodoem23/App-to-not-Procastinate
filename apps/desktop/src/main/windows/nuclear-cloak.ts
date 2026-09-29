/**
 * Windows: is an overlay window DWM-cloaked? Switching virtual desktop (Ctrl+Win+D, Ctrl+Win+
 * Left/Right) leaves the overlay on the old desktop, where the shell cloaks it: `isVisible()`
 * stays `true` and `isMinimized()` `false`, yet nothing covers the screen. Electron's
 * `setVisibleOnAllWorkspaces` does nothing on Windows, so the overlay asks DWM directly
 * (`DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED)`) through koffi, loaded lazily and only on
 * Windows. Any failure reads «not cloaked» (the other checks still apply).
 */
import type { BrowserWindow } from 'electron';
import type * as KoffiModule from 'koffi';

type Koffi = typeof KoffiModule;

/** `DWMWA_CLOAKED`: non-zero (`DWM_CLOAKED_APP | _SHELL | _INHERITED`) when cloaked. */
export const DWMWA_CLOAKED = 14;

/** Reads a window's cloak state; `false` when it cannot tell. */
export type CloakProbe = (win: BrowserWindow) => boolean;

/** The HWND inside `getNativeWindowHandle()` (4 bytes on 32-bit, 8 on 64-bit). */
export function hwndOf(handle: Buffer): bigint | null {
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
  return null;
}

type DwmGetWindowAttribute = (
  hwnd: bigint,
  attribute: number,
  value: number[],
  size: number,
) => number;

/** Builds the probe from a loaded koffi (tests pass a fake). */
export function createWin32CloakProbe(koffi: Koffi): CloakProbe {
  const dwmapi = koffi.load('dwmapi.dll');
  const getAttribute = dwmapi.func(
    'int32_t __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)',
  ) as unknown as DwmGetWindowAttribute;
  return (win) => {
    try {
      if (win.isDestroyed()) return false;
      const hwnd = hwndOf(win.getNativeWindowHandle());
      if (hwnd === null || hwnd === 0n) return false;
      const out: number[] = [0];
      // S_OK is 0; any HRESULT failure reads «not cloaked».
      if (getAttribute(hwnd, DWMWA_CLOAKED, out, 4) !== 0) return false;
      return (out[0] ?? 0) !== 0;
    } catch {
      return false;
    }
  };
}

async function importKoffi(): Promise<Koffi> {
  const mod = (await import('koffi')) as Koffi & { default?: Koffi };
  return mod.default ?? mod;
}

/** Loads the probe on Windows (`null` elsewhere or when koffi/dwmapi would not load). */
export async function loadCloakProbe(
  platform: string,
  load: () => Promise<Koffi> = importKoffi,
): Promise<CloakProbe | null> {
  if (platform !== 'win32') return null;
  try {
    return createWin32CloakProbe(await load());
  } catch {
    return null;
  }
}
