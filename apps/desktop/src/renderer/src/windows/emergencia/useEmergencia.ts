/**
 * State and actions of the Emergencia window. The phrase and the confirmed result live in the
 * detail window's local state (fixture-settable); the guardian's preview is fetched whenever the
 * window is shown or the blocks change. Every write goes through main (`emergency:*`), which
 * patches the snapshot, so the counting and ready stages come from `state.emergency`.
 *
 * Screen readers: the help lines are not live regions (a stage mounts them with their text
 * already in them). The window's one polite region (`announcement`) says each new stage with
 * the result that caused it («Cancelada: no has perdido nada. Emergencia: YouTube, espera de
 * 10 min»), the phrase turning right or wrong, a refused paste and failures; in the ready stage
 * the row's own region says failures and the armed «¿Seguro?».
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EmergencyPreviewResponse } from '@centrate/shared/guardian-api';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { newIntentId } from '../../app/push';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { EmergenciaLocalState } from '../../../../shared/ui-state';
import { useAnnouncer, type Announcement } from '../bloqueos/announcer';
import { EMERGENCIA } from './i18n';
import {
  deriveEmergenciaView,
  stageAnnouncement,
  type EmergenciaStage,
  type EmergenciaView,
} from './view';

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
  /** The window's polite region. */
  announcement: Announcement | null;
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
  const { announcement, announce } = useAnnouncer();
  const mounted = useRef(true);
  /** A result that changes the stage, said with the stage it leads to. */
  const pendingNotice = useRef<string | null>(null);
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

  // Read by the callbacks below, which resolve after later renders.
  const stage = useRef<EmergenciaStage>(view.stage);
  stage.current = view.stage;

  // A new stage speaks (not the first one: the window's title says it as it opens).
  const spokenStage = useRef<EmergenciaStage>(view.stage);
  useEffect(() => {
    if (spokenStage.current === view.stage) return;
    spokenStage.current = view.stage;
    announce(stageAnnouncement(view, pendingNotice.current));
    pendingNotice.current = null;
    // Only a stage change speaks; `view` is read with it.
  }, [view.stage, announce]);

  // The phrase turning right or wrong (not every keystroke, not the stage showing).
  const phraseNow = view.phrase?.status ?? null;
  const spokenPhrase = useRef(phraseNow);
  useEffect(() => {
    const before = spokenPhrase.current;
    spokenPhrase.current = phraseNow;
    if (before === null || before === phraseNow) return;
    if (phraseNow === 'ok') announce(EMERGENCIA.announce.phraseOk);
    else if (phraseNow === 'mismatch') announce(EMERGENCIA.announce.phraseMismatch);
  }, [phraseNow, announce]);

  const fail = useCallback(
    (text: string) => {
      if (!mounted.current) return;
      setNotice({ text, tone: 'red' });
      // The ready row's own region says it there.
      if (stage.current !== 'ready') announce(text);
    },
    [announce],
  );

  return {
    view,
    phrase: detail.emergencia.phrase,
    busy,
    loading,
    notice,
    announcement,
    setPhrase: (text) => {
      requestIntent.current = null;
      setNotice(null);
      updateLocal((l) => ({ ...l, phrase: text }));
    },
    refusePaste: () => {
      setNotice({ text: EMERGENCIA.phrase.pasted, tone: 'orange' });
      announce(EMERGENCIA.announce.pasted);
    },
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
          setNotice({ text: EMERGENCIA.cancelled, tone: 'green' });
          // Said with the stage it leads to, or now if that stage is already showing.
          if (stage.current === 'counting' || stage.current === 'ready') {
            pendingNotice.current = EMERGENCIA.cancelled;
          } else {
            announce(EMERGENCIA.cancelled);
          }
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
