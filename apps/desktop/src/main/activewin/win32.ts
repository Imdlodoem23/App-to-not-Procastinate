/**
 * Windows foreground window through koffi (no native rebuild): `GetForegroundWindow`,
 * `GetWindowTextW` and the owning process's image through `QueryFullProcessImageNameW`
 * (`PROCESS_QUERY_LIMITED_INFORMATION`, which works for other users' processes too). Nothing
 * needs a permission. Loaded only on Windows.
 */
import { win32 } from 'node:path';
import type * as KoffiModule from 'koffi';
import type { ForegroundWindow } from './match';

type Koffi = typeof KoffiModule;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** Titles longer than this are cut (no service name sits past it). */
const MAX_TITLE = 1_024;
const MAX_PATH = 32_768;

export interface Win32Foreground {
  read(): ForegroundWindow | null;
}

export function createWin32Foreground(koffi: Koffi): Win32Foreground {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  koffi.pointer('CENTRATE_HWND', koffi.opaque());
  koffi.pointer('CENTRATE_HANDLE', koffi.opaque());

  const GetForegroundWindow = user32.func('CENTRATE_HWND __stdcall GetForegroundWindow()');
  const GetWindowTextLengthW = user32.func(
    'int __stdcall GetWindowTextLengthW(CENTRATE_HWND hWnd)',
  );
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(CENTRATE_HWND hWnd, void *lpString, int nMaxCount)',
  );
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(CENTRATE_HWND hWnd, _Out_ uint32_t *lpdwProcessId)',
  );
  const OpenProcess = kernel32.func(
    'CENTRATE_HANDLE __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)',
  );
  const QueryFullProcessImageNameW = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(CENTRATE_HANDLE hProcess, uint32_t dwFlags, void *lpExeName, _Inout_ uint32_t *lpdwSize)',
  );
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(CENTRATE_HANDLE hObject)');

  const processOf = (hwnd: unknown): string | null => {
    const pid: number[] = [0];
    GetWindowThreadProcessId(hwnd, pid);
    const id = pid[0] ?? 0;
    if (id <= 4) return null;
    const handle: unknown = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, id);
    if (!handle) return null;
    try {
      const buffer = Buffer.alloc(MAX_PATH * 2);
      const size: number[] = [MAX_PATH];
      if (!QueryFullProcessImageNameW(handle, 0, buffer, size)) return null;
      const path = buffer.toString('utf16le', 0, (size[0] ?? 0) * 2);
      return win32.basename(path) || null;
    } finally {
      CloseHandle(handle);
    }
  };

  return {
    read(): ForegroundWindow | null {
      const hwnd: unknown = GetForegroundWindow();
      if (!hwnd) return null;
      const length = Math.min(MAX_TITLE, Math.max(0, Number(GetWindowTextLengthW(hwnd))));
      let title = '';
      if (length > 0) {
        const buffer = Buffer.alloc((length + 1) * 2);
        const copied = Math.max(0, Number(GetWindowTextW(hwnd, buffer, length + 1)));
        title = buffer.toString('utf16le', 0, copied * 2);
      }
      if (title === '') return null;
      return { title, process: processOf(hwnd) };
    },
  };
}
