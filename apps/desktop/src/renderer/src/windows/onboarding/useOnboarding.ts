/**
 * Actions of the onboarding (main window, first run):
 *
 * - navigation, «Omitir» and finishing are `prefs:set { onboarding }` (main persists the step,
 *   so a restart resumes where it was);
 * - «Instalar» is `onboarding:install-guardian` (the same elevation as «Reparar»), with
 *   «Instalando…» in `main.onboarding.installing` meanwhile;
 * - step 3 asks the guardian for a pairing code once when it shows without a valid one
 *   (`main.onboarding.pairing`); «Nuevo código» asks again;
 * - step 5 types «no veo YouTube en 25 minutos» into `main.composer` (the Bloqueo field's own
 *   text) when it shows with the field empty; «Crear bloqueo» or Enter goes through section 2's
 *   own Enter (`enterBloqueo`): the card opens with the phrase and the onboarding ends, so the
 *   next Enter creates the block (write + 2 Enter, PROMPT §10).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingStep } from '../../../../shared/prefs';
import type { GuideId } from '../../../../shared/ipc';
import { newIntentId } from '../../app/push';
import { useServices } from '../../app/services';
import { useNow } from '../../hooks/useNow';
import { errorCopy } from '../../i18n/errors';
import { enterBloqueo } from '../../sections/bloqueo/reducer';
import { useAppStore, useAppStoreApi } from '../../store/context';
import type { OnboardingLocalState } from '../../../../shared/ui-state';
import { ONBOARDING } from './i18n';
import {
  deriveOnboardingView,
  firstBlockPhrase,
  nextStep,
  type OnboardingAction,
  type OnboardingResult,
  type OnboardingView,
} from './view';

export interface OnboardingApi {
  view: OnboardingView;
  composerText: string;
  setComposerText(text: string): void;
  press(action: OnboardingAction): void;
  newPairingCode(): void;
  /** `true` once the onboarding asked main to finish (the main window's sections come next). */
  finishing: boolean;
}

export function useOnboarding(): OnboardingApi {
  const api = useAppStoreApi();
  const bridge = useAppStore((s) => s.bridge);
  const snapshot = useAppStore((s) => s.snapshot);
  const local = useAppStore((s) => s.main.onboarding);
  const composerText = useAppStore((s) => s.main.composer.text);
  const step = snapshot.prefs.onboarding.step;
  const nowMs = useNow(local.pairing ? 1_000 : 60_000);
  const services = useServices();

  /** The last answer, with the step it belongs to (a new step starts with a clean line). */
  const [answer, setAnswer] = useState<{ step: OnboardingStep; result: OnboardingResult } | null>(
    null,
  );
  const result = answer?.step === step ? answer.result : null;
  const [finishing, setFinishing] = useState(false);
  const mounted = useRef(true);
  const pairingAsked = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const updateLocal = useCallback(
    (fn: (l: OnboardingLocalState) => OnboardingLocalState) =>
      api.getState().updateMain((m) => {
        const next = fn(m.onboarding);
        return next === m.onboarding ? m : { ...m, onboarding: next };
      }),
    [api],
  );

  const show = useCallback(
    (next: OnboardingResult | null) => {
      if (mounted.current) setAnswer(next ? { step, result: next } : null);
    },
    [step],
  );

  const savePrefs = useCallback(
    (patch: { step?: OnboardingStep; done?: boolean }): Promise<boolean> =>
      bridge.invoke('prefs:set', { onboarding: patch }).then(
        (r) => {
          if (!r.ok) show({ text: ONBOARDING.saveFailed, tone: 'red' });
          return r.ok;
        },
        () => {
          show({ text: ONBOARDING.saveFailed, tone: 'red' });
          return false;
        },
      ),
    [bridge, show],
  );

  const goTo = useCallback(
    (next: OnboardingStep | null) => {
      if (next === null) {
        setFinishing(true);
        void savePrefs({ done: true }).then((ok) => {
          if (!ok && mounted.current) setFinishing(false);
        });
        return;
      }
      void savePrefs({ step: next });
    },
    [savePrefs],
  );

  const requestPairing = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    void bridge.invoke('pairing:new-code', null).then(
      (r) => {
        busy.current = false;
        if (!r.ok) {
          show({ text: errorCopy(r.error).text, tone: 'red' });
          return;
        }
        updateLocal((l) => ({ ...l, pairing: r.value }));
      },
      () => {
        busy.current = false;
      },
    );
  }, [bridge, show, updateLocal]);

  const view = useMemo(
    () => deriveOnboardingView({ snapshot, local, nowMs, result }),
    [snapshot, local, nowMs, result],
  );

  // Step 3: one code as soon as the guardian can give it (the fixture may bring its own).
  const wantsCode = view.pairing !== null && view.pairing.kind === 'none' && !view.pairing.expired;
  useEffect(() => {
    if (!wantsCode || pairingAsked.current) return;
    pairingAsked.current = true;
    requestPairing();
  }, [wantsCode, requestPairing]);

  // Step 5: the first block, already typed (PROMPT §10), unless something is there already.
  useEffect(() => {
    if (step !== 'first-block') return;
    const s = api.getState();
    if (s.main.composer.text !== '') return;
    s.updateMain((m) => ({ ...m, composer: { ...m.composer, text: firstBlockPhrase() } }));
  }, [api, step]);

  const create = useCallback(() => {
    const s = api.getState();
    const out = enterBloqueo(s.snapshot, s.main, nowMs, newIntentId);
    const card = out.kind === 'update' ? out.main.card : null;
    // The card first, so the sections appear with it open; undone if main refuses to finish.
    if (card) s.updateMain(() => out.main);
    setFinishing(true);
    void savePrefs({ done: true }).then((ok) => {
      if (!ok) {
        if (mounted.current) setFinishing(false);
        if (card) {
          api
            .getState()
            .updateMain((m) => (m.card?.intentId === card.intentId ? { ...m, card: null } : m));
        }
        return;
      }
      if (out.kind === 'open-detail') bridge.send('window:open-detail', out.request);
    });
  }, [api, bridge, nowMs, savePrefs]);

  const install = useCallback(() => {
    if (api.getState().main.onboarding.installing) return;
    updateLocal((l) => ({ ...l, installing: true }));
    show(null);
    void bridge.invoke('onboarding:install-guardian', null).then(
      (r) => {
        updateLocal((l) => ({ ...l, installing: false }));
        if (!r.ok) {
          show({ text: errorCopy(r.error).text, tone: 'red' });
          return;
        }
        const outcome = r.value.outcome;
        const ok = outcome === 'installed' || outcome === 'already-installed';
        show({ text: ONBOARDING.install[outcome], tone: ok ? 'green' : 'red' });
      },
      () => updateLocal((l) => ({ ...l, installing: false })),
    );
  }, [api, bridge, show, updateLocal]);

  const openGuide = useCallback(
    (guide: GuideId) => bridge.send('app:open-guide', { guide }),
    [bridge],
  );

  const press = useCallback(
    (action: OnboardingAction) => {
      switch (action) {
        case 'start':
        case 'continue':
          goTo(nextStep(step));
          return;
        case 'skip':
          goTo(step === 'welcome' ? null : nextStep(step));
          return;
        case 'install':
          install();
          return;
        case 'guide-chromium':
          openGuide('extension-chromium');
          return;
        case 'guide-firefox':
          openGuide('extension-firefox');
          return;
        case 'camera':
          void bridge.invoke('onboarding:test-camera', null).then((r) => {
            if (r.ok) show({ text: ONBOARDING.cameraUnavailable, tone: 'muted' });
            else show({ text: errorCopy(r.error).text, tone: 'red' });
          });
          return;
        case 'create':
          create();
          return;
      }
    },
    [bridge, create, goTo, install, openGuide, show, step],
  );

  // When the onboarding gives way to the sections, the keyboard lands on what comes next: the
  // card's confirm button (Enter creates the block), else «¿Qué quieres hacer?».
  const finishingRef = useRef(false);
  useLayoutEffect(() => {
    finishingRef.current = finishing;
  });
  useEffect(
    () => () => {
      if (!finishingRef.current) return;
      queueMicrotask(() => {
        if (!services.focus('confirm')) services.focusField();
      });
    },
    [services],
  );

  return {
    view,
    composerText,
    setComposerText: (text) =>
      api
        .getState()
        .updateMain((m) =>
          m.composer.text === text ? m : { ...m, composer: { ...m.composer, text } },
        ),
    press,
    newPairingCode: requestPairing,
    finishing,
  };
}
