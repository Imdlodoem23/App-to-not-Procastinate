/**
 * The main window (PROMPT §10 «Ventana principal»): 440 DIP wide, as tall as its content, the
 * sections stacked from top to bottom with 12 px side margins and 12 px between them and no
 * separators: 1 «Aviso de protección» (only when something fails), 2 «Bloqueo», (3 «Study Mode»
 * with its flag), 4 «Progreso», then the footer, which never scrolls.
 *
 * `useAutoLayout` measures the content and reports it to main (`window:layout`); the landmarks
 * are `<main>` (the sections, with a hidden `<h1>`) and `<footer>`.
 */
import { Lock } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { HelpLine, Section } from '../components';
import { useAutoLayout } from '../hooks/useAutoLayout';
import { RENDERER_ES } from '../i18n/es';
import { Footer } from '../sections/footer/Footer';
import { ProgresoSection } from '../sections/progreso/ProgresoSection';
import { ProtectionWarning } from '../sections/protection/ProtectionWarning';
import { useAppStore, useAppStoreApi } from '../store/context';
import { useServices } from './services';
import { BloqueoSection } from './slots';
import { useReadySignal } from './useReadySignal';

/** Development stand-in while BLOQUEO's module is not in the bundle. */
function BloqueoStandIn(): React.JSX.Element {
  return (
    <Section id="bloqueo" icon={Lock} title={RENDERER_ES.shell.bloqueoTitle}>
      <HelpLine>{RENDERER_ES.shell.bloqueoUnavailable}</HelpLine>
    </Section>
  );
}

export function MainWindow(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const rev = useAppStore((s) => s.snapshot.rev);
  const local = useAppStore((s) => s.main);
  const budget = useAppStore((s) => s.env.layout);
  const seq = useAppStore((s) => s.harnessSeq);
  useAutoLayout(rootRef, [rev, local, budget, seq]);
  useReadySignal();

  // A show that happened before the first render (launch) could not focus the field yet.
  const api = useAppStoreApi();
  const services = useServices();
  useLayoutEffect(() => {
    if (api.getState().env.visible && document.hasFocus()) services.focusField();
  }, [api, services]);

  // Safety net: a focused control that unmounts («Reparar» when the warning goes away on the
  // next good poll, the footer's «Reparar» when it flips to «Guardián activo», …) must not
  // leave the keyboard on <body>. Sections restore their own focus first (their layout effects
  // run before this one); whatever is still lost goes to the field (else the Bloqueo root).
  const lastFocused = useRef<Element | null>(null);
  const recoverFocus = useRef<() => void>(() => undefined);
  recoverFocus.current = () => {
    const last = lastFocused.current;
    if (!last || last.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    lastFocused.current = null;
    if (api.getState().env.visible && document.hasFocus()) services.focusField();
  };
  useLayoutEffect(() => {
    recoverFocus.current();
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (event: FocusEvent): void => {
      lastFocused.current = event.target instanceof Element ? event.target : null;
    };
    // Chromium may fire `focusout` when the focused node is removed; check once it is gone.
    const onFocusOut = (): void => queueMicrotask(() => recoverFocus.current());
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return (
    <div ref={rootRef} className="main-shell">
      <main className="main-column" aria-labelledby="app-title" data-scroll-root="">
        <h1 id="app-title" className="sr-only">
          {RENDERER_ES.shell.appName}
        </h1>
        <div className="main-sections" data-measure="">
          <ProtectionWarning />
          {BloqueoSection ? <BloqueoSection /> : <BloqueoStandIn />}
          <ProgresoSection />
        </div>
      </main>
      <Footer />
    </div>
  );
}
