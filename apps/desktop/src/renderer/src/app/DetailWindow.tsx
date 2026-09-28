/**
 * The one reusable detail window (PROMPT §10 «Ventanas de detalle», docs/DESKTOP.md §8.5): 600
 * DIP wide, glued to the main window, showing Bloqueos, Emergencia or Ajustes (DETAILS's lazy
 * views, prefetched as soon as the window exists so a door opens instantly). Here content may
 * scroll. Esc or its X close it (the Esc cascade's last step sends `window:close-detail`).
 */
import { Suspense, useEffect } from 'react';
import { Info } from 'lucide-react';
import { EmptyState } from '../components';
import { RENDERER_ES } from '../i18n/es';
import { useAppStore } from '../store/context';
import { DETAIL_NAMES } from '../../../shared/ui-state';
import { detailView, preloadDetailViews } from './slots';
import { ReadyProbe } from './useReadySignal';

export function DetailWindow(): React.JSX.Element {
  const name = useAppStore((s) => s.env.detail?.name ?? null);
  const View = name ? detailView(name) : null;
  const title = name ? RENDERER_ES.shell.detailTitles[name] : RENDERER_ES.shell.appName;

  useEffect(() => preloadDetailViews(DETAIL_NAMES), []);

  return (
    <div className="detail-shell">
      <main className="detail-main" aria-labelledby="detail-title">
        <h1 id="detail-title" className="sr-only">
          {title}
        </h1>
        <Suspense fallback={null}>
          {View ? (
            <View key={name} />
          ) : name ? (
            <EmptyState icon={Info} text={RENDERER_ES.shell.bloqueoUnavailable} />
          ) : null}
          <ReadyProbe />
        </Suspense>
      </main>
    </div>
  );
}
