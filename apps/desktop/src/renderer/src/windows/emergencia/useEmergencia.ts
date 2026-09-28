/**
 * State and actions of the Emergencia window. The phrase and the confirmed result live in the
 * detail window's local state (fixture-settable); the guardian's preview is fetched whenever the
 * window is shown or the blocks change. Every write goes through main (`emergency:*`), which
 * patches the snapshot, so the counting and ready stages come from `state.emergency`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyPreviewResponse } from '@centrate/shared/guardian-api';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { newIntentId } from '../../app/push';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { EmergenciaLocalState } from '../../../../shared/ui-state';
import { EMERGENCIA_ES } from './i18n/es';
import { deriveEmergenciaView, type EmergenciaView } from './view';

export interface EmergenciaNotice {
  text: string;
  tone: 'muted' | 'red' | 'orange' | 'green';
}

export interface EmergenciaApi {
  view: EmergenciaView;
  phrase: string;
  busy: 'request' | 'cancel' | 'confirm' | null;
  /** The guardian's preview is on its way (the harness waits for it before a screenshot). */
  loading: boolean;
  notice: EmergenciaNotice | null;
  setPhrase(text: string): void;
  refusePaste(): void;
  request(): void;
  cancel(): void;
  confirm(): void;
  close(): void;
}

export function useEmergencia(): EmergenciaApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const env = useAppStore((s) => s.env);
  const detail = useAppStore((s) => s.detail);
  const nowMs = useNow(1_000);

  const [preview, setPreview] = useState<EmergencyPreviewResponse | null>(null);
  const [loading, setLoading] = useState(() => {
    const s = api.getState();
    return s.env.visible && s.snapshot.state !== null;
  });
  const [busy, setBusy] = useState<EmergenciaApi['busy']>(null);
  const [notice, setNotice] = useState<EmergenciaNotice | null>(null);
  const mounted = useRef(true);
  /** Reused while the same request is retried (the guardian replays, never duplicates). */
  const requestIntent = useRef<string | null>(null);
  const confirmIntent = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const blockIds = detail.emergencia.blockIds;
  const state = snapshot.state;
  const blocksKey = state
    ? state.blocks.map((b) => `${b.id}:${b.emergencyEligible}`).join('|')
    : '';
  const emergencyKey = state?.emergency ? `${state.emergency.id}:${state.emergency.status}` : '';

  // The guardian's price, whenever the window shows or what it would cancel changes.
  useEffect(() => {
    if (!env.visible || state === null) return;
    let live = true;
    setLoading(true);
    void bridge.invoke('emergency:preview', { blockIds }).then(
      (result) => {
        if (!live || !mounted.current) return;
        setPreview(result.ok ? result.value : null);
        setLoading(false);
      },
      () => {
        if (live && mounted.current) setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // `state` itself changes on every poll; the keys say when the price can change.
  }, [bridge, env.visible, env.detail, blockIds, blocksKey, emergencyKey, state === null]);

  // A new door (`ui:detail`) starts clean: no old result or notice.
  const firstDetail = useRef(true);
  useEffect(() => {
    if (firstDetail.current) {
      firstDetail.current = false;
      return;
    }
    setNotice(null);
    api
      .getState()
      .updateDetail((d) =>
        d.emergencia.result ? { ...d, emergencia: { ...d.emergencia, result: null } } : d,
      );
  }, [api, env.detail]);

  const view = useMemo(
    () =>
      deriveEmergenciaView({ env, snapshot, main: api.getState().main, detail }, nowMs, preview),
    [api, env, snapshot, detail, nowMs, preview],
  );

  const updateLocal = useCallback(
    (fn: (local: EmergenciaLocalState) => EmergenciaLocalState) =>
      api.getState().updateDetail((d) => ({ ...d, emergencia: fn(d.emergencia) })),
    [api],
  );

  const fail = useCallback((text: string) => {
    if (mounted.current) setNotice({ text, tone: 'red' });
  }, []);

  return {
    view,
    phrase: detail.emergencia.phrase,
    busy,
    loading,
    notice,
    setPhrase: (text) => {
      requestIntent.current = null;
      setNotice(null);
      updateLocal((l) => ({ ...l, phrase: text }));
    },
    refusePaste: () => setNotice({ text: EMERGENCIA_ES.phrase.pasted, tone: 'orange' }),
    request: () => {
      const req = view.request;
      if (!req || req.disabledReason || busy) return;
      requestIntent.current ??= newIntentId();
      setBusy('request');
      setNotice(null);
      void bridge
        .invoke('emergency:request', {
          intentId: requestIntent.current,
          blockIds: req.blockIds,
          phrase: detail.emergencia.phrase,
        })
        .then(
          (result) => {
            if (!mounted.current) return;
            setBusy(null);
            if (!result.ok) {
              fail(errorCopy(result.error).text);
              return;
            }
            requestIntent.current = null;
            updateLocal((l) => ({ ...l, phrase: '' }));
          },
          () => {
            if (mounted.current) setBusy(null);
          },
        );
    },
    cancel: () => {
      const emergency = view.emergency;
      if (!emergency || busy) return;
      setBusy('cancel');
      void bridge.invoke('emergency:cancel', { id: emergency.id }).then(
        (result) => {
          if (!mounted.current) return;
          setBusy(null);
          if (!result.ok) {
            fail(errorCopy(result.error).text);
            return;
          }
          setNotice({ text: EMERGENCIA_ES.cancelled, tone: 'green' });
        },
        () => {
          if (mounted.current) setBusy(null);
        },
      );
    },
    confirm: () => {
      const emergency = view.emergency;
      if (!emergency || busy) return;
      confirmIntent.current ??= newIntentId();
      setBusy('confirm');
      void bridge
        .invoke('emergency:confirm', { intentId: confirmIntent.current, id: emergency.id })
        .then(
          (result) => {
            if (!mounted.current) return;
            setBusy(null);
            if (!result.ok) {
              fail(errorCopy(result.error).text);
              return;
            }
            confirmIntent.current = null;
            setNotice(null);
            updateLocal((l) => ({ ...l, result: result.value, phrase: '' }));
          },
          () => {
            if (mounted.current) setBusy(null);
          },
        );
    },
    close: () => {
      setNotice(null);
      updateLocal((l) => ({ ...l, result: null, phrase: '' }));
      bridge.send('window:close-detail', null);
    },
  };
}
