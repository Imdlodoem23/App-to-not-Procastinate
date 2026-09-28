/**
 * Actions of the Ajustes window. Preferences apply at once through `prefs:set` (main reacts to
 * the snapshot: theme, autostart); the pairing code, the «Copiado» feedback and the BORRAR box
 * live in the detail window's local state (fixture-settable). The guardian token and the
 * diagnostics text never reach this renderer: main writes the clipboard itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePreference } from '@centrate/shared/design/tokens';
import { newIntentId } from '../../app/push';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { GuideId } from '../../../../shared/ipc';
import type {
  AjustesLocalState,
  DefaultBlockMode,
  UiPrefsPatch,
} from '../../../../shared/ui-state';
import { AJUSTES_ES } from './i18n/es';
import { deleteWordOk, deriveAjustesView, type AjustesView } from './view';

export interface AjustesNotice {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
}

export type AjustesArea = 'general' | 'bloqueo' | 'pairing' | 'diagnostics' | 'datos';

export interface AjustesApi {
  view: AjustesView;
  deleteWord: string;
  busy: ReadonlySet<AjustesArea>;
  notices: Partial<Record<AjustesArea, AjustesNotice>>;
  setTheme(theme: ThemePreference): void;
  setAutostart(on: boolean): void;
  setDefaultMode(mode: DefaultBlockMode): void;
  newPairingCode(): void;
  copyDiagnostics(): void;
  openGuide(guide: GuideId): void;
  setDeleteWord(text: string): void;
  deleteData(): void;
}

export function useAjustes(): AjustesApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const env = useAppStore((s) => s.env);
  const detail = useAppStore((s) => s.detail);
  const hasPairing = detail.ajustes.pairing !== null;
  const nowMs = useNow(hasPairing ? 1_000 : 60_000);

  const [busy, setBusy] = useState<ReadonlySet<AjustesArea>>(() => new Set());
  const [notices, setNotices] = useState<Partial<Record<AjustesArea, AjustesNotice>>>({});
  const mounted = useRef(true);
  const deleteIntent = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const notify = useCallback((area: AjustesArea, notice: AjustesNotice | null) => {
    if (!mounted.current) return;
    setNotices((current) => {
      if (!notice && !current[area]) return current;
      const next = { ...current };
      if (notice) next[area] = notice;
      else delete next[area];
      return next;
    });
  }, []);

  const setBusyArea = useCallback((area: AjustesArea, on: boolean) => {
    if (!mounted.current) return;
    setBusy((current) => {
      if (current.has(area) === on) return current;
      const next = new Set(current);
      if (on) next.add(area);
      else next.delete(area);
      return next;
    });
  }, []);

  const updateLocal = useCallback(
    (fn: (local: AjustesLocalState) => AjustesLocalState) =>
      api.getState().updateDetail((d) => {
        const next = fn(d.ajustes);
        return next === d.ajustes ? d : { ...d, ajustes: next };
      }),
    [api],
  );

  // Settings rows of the guardian (daily goal edits, «cerrar navegadores», penalties) need a
  // settings channel main does not offer yet: the view shows what the snapshot knows.
  const view = useMemo(
    () => deriveAjustesView({ env, snapshot, main: api.getState().main, detail }, nowMs, null),
    [api, env, snapshot, detail, nowMs],
  );

  const setPrefs = useCallback(
    (area: 'general' | 'bloqueo', patch: UiPrefsPatch) => {
      notify(area, null);
      void bridge.invoke('prefs:set', patch).then(
        (result) => {
          if (!result.ok) notify(area, { text: AJUSTES_ES.saveFailed, tone: 'red' });
        },
        () => notify(area, { text: AJUSTES_ES.saveFailed, tone: 'red' }),
      );
    },
    [bridge, notify],
  );

  return {
    view,
    deleteWord: detail.ajustes.deleteWord,
    busy,
    notices,
    setTheme: (theme) => {
      if (theme !== snapshot.prefs.theme) setPrefs('general', { theme });
    },
    setAutostart: (autostart) => setPrefs('general', { autostart }),
    setDefaultMode: (defaultMode) => {
      if (defaultMode !== snapshot.prefs.defaultMode) setPrefs('bloqueo', { defaultMode });
    },
    newPairingCode: () => {
      if (busy.has('pairing')) return;
      setBusyArea('pairing', true);
      notify('pairing', null);
      void bridge.invoke('pairing:new-code', null).then(
        (result) => {
          setBusyArea('pairing', false);
          if (!result.ok) {
            notify('pairing', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          updateLocal((l) => ({ ...l, pairing: result.value }));
        },
        () => setBusyArea('pairing', false),
      );
    },
    copyDiagnostics: () => {
      if (busy.has('diagnostics')) return;
      setBusyArea('diagnostics', true);
      notify('diagnostics', null);
      void bridge.invoke('diagnostics:copy', null).then(
        (result) => {
          setBusyArea('diagnostics', false);
          if (!result.ok) {
            notify('diagnostics', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          updateLocal((l) => ({ ...l, diagnostics: result.value.source }));
        },
        () => setBusyArea('diagnostics', false),
      );
    },
    openGuide: (guide) => bridge.send('app:open-guide', { guide }),
    setDeleteWord: (text) => {
      notify('datos', null);
      updateLocal((l) => (l.deleteWord === text ? l : { ...l, deleteWord: text }));
    },
    deleteData: () => {
      const word = api.getState().detail.ajustes.deleteWord;
      if (!deleteWordOk(word) || busy.has('datos')) return;
      deleteIntent.current ??= newIntentId();
      setBusyArea('datos', true);
      notify('datos', null);
      void bridge.invoke('data:delete', { intentId: deleteIntent.current, confirm: word }).then(
        (result) => {
          setBusyArea('datos', false);
          if (!result.ok) {
            notify('datos', { text: errorCopy(result.error).text, tone: 'red' });
            return;
          }
          deleteIntent.current = null;
          updateLocal((l) => ({ ...l, deleteWord: '' }));
          const kept = result.value.keptBlockIds.length;
          notify('datos', {
            text: kept > 0 ? AJUSTES_ES.datos.deletedKept(kept) : AJUSTES_ES.datos.deleted,
            tone: 'green',
          });
        },
        () => setBusyArea('datos', false),
      );
    },
  };
}
