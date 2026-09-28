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
import { useLayoutEffect, useRef } from 'react';
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
