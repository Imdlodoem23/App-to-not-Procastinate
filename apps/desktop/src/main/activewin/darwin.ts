/**
 * macOS foreground window through koffi and CoreGraphics: `CGWindowListCopyWindowInfo` lists
 * the on-screen windows front to back; the first one on layer 0 (normal windows, not the menu
 * bar or the Dock) is in front. Its owner (`kCGWindowOwnerName`, «Google Chrome») is always
 * readable; its title (`kCGWindowName`) only with the Screen Recording permission, which
 * `CGPreflightScreenCaptureAccess` reports and `CGRequestScreenCaptureAccess` asks for (macOS
 * 10.15+; older systems need none). Without it the layer is off and Ajustes says why.
 */
import type * as KoffiModule from 'koffi';
import type { ForegroundWindow } from './match';

type Koffi = typeof KoffiModule;

const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
const CORE_GRAPHICS = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics';

/** `kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements`. */
const LIST_OPTIONS = (1 << 0) | (1 << 4);
const K_CG_NULL_WINDOW_ID = 0;
const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
const K_CF_NUMBER_SINT32_TYPE = 3;
const MAX_STRING_BYTES = 4_096;
/** Enough windows to find the front one past floating panels. */
const MAX_WINDOWS = 64;

export interface DarwinForeground {
  read(): ForegroundWindow | null;
  /** Screen Recording granted (always `true` before macOS 10.15). */
  permitted(): boolean;
  /** Shows the system prompt (once per app) and answers whether it is granted now. */
  requestPermission(): boolean;
}

export function createDarwinForeground(koffi: Koffi): DarwinForeground {
  const cf = koffi.load(CORE_FOUNDATION);
  const cg = koffi.load(CORE_GRAPHICS);

  const CFArrayGetCount = cf.func('long CFArrayGetCount(void *theArray)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *theArray, long idx)');
  const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *theDict, void *key)');
  const CFStringCreateWithCString = cf.func(
    'void *CFStringCreateWithCString(void *alloc, const char *cStr, uint32_t encoding)',
  );
  const CFStringGetCString = cf.func(
    'bool CFStringGetCString(void *theString, void *buffer, long bufferSize, uint32_t encoding)',
  );
  const CFNumberGetValue = cf.func(
    'bool CFNumberGetValue(void *number, int theType, _Out_ int32_t *valuePtr)',
  );
  const CFRelease = cf.func('void CFRelease(void *cf)');
  const CGWindowListCopyWindowInfo = cg.func(
    'void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)',
  );

  const optional = (definition: string): ((...args: unknown[]) => unknown) | null => {
    try {
      return cg.func(definition) as (...args: unknown[]) => unknown;
    } catch {
      return null;
    }
  };
  const CGPreflightScreenCaptureAccess = optional('bool CGPreflightScreenCaptureAccess()');
  const CGRequestScreenCaptureAccess = optional('bool CGRequestScreenCaptureAccess()');

  const key = (name: string): unknown =>
    CFStringCreateWithCString(null, name, K_CF_STRING_ENCODING_UTF8);
  // Created once for the life of the app (CFDictionary compares keys by value).
  const LAYER = key('kCGWindowLayer');
  const OWNER = key('kCGWindowOwnerName');
  const NAME = key('kCGWindowName');

  const text = (value: unknown): string | null => {
    if (!value) return null;
    const buffer = Buffer.alloc(MAX_STRING_BYTES);
    if (!CFStringGetCString(value, buffer, MAX_STRING_BYTES, K_CF_STRING_ENCODING_UTF8))
      return null;
    const end = buffer.indexOf(0);
    return buffer.toString('utf8', 0, end < 0 ? buffer.length : end);
  };

  const int = (value: unknown): number | null => {
    if (!value) return null;
    const out: number[] = [0];
    return CFNumberGetValue(value, K_CF_NUMBER_SINT32_TYPE, out) ? (out[0] ?? null) : null;
  };

  return {
    read(): ForegroundWindow | null {
      const list: unknown = CGWindowListCopyWindowInfo(LIST_OPTIONS, K_CG_NULL_WINDOW_ID);
      if (!list) return null;
      try {
        const count = Math.min(MAX_WINDOWS, Number(CFArrayGetCount(list)));
        for (let i = 0; i < count; i += 1) {
          const info: unknown = CFArrayGetValueAtIndex(list, i);
          if (!info || int(CFDictionaryGetValue(info, LAYER)) !== 0) continue;
          const owner = text(CFDictionaryGetValue(info, OWNER));
          const title = text(CFDictionaryGetValue(info, NAME)) ?? '';
          return { title, process: owner };
        }
        return null;
      } finally {
        CFRelease(list);
      }
    },
    permitted(): boolean {
      return CGPreflightScreenCaptureAccess ? Boolean(CGPreflightScreenCaptureAccess()) : true;
    },
    requestPermission(): boolean {
      return CGRequestScreenCaptureAccess ? Boolean(CGRequestScreenCaptureAccess()) : true;
    },
  };
}
