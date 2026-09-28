/**
 * The one reusable detail window (PROMPT §10 «Ventanas de detalle», docs/DESKTOP.md §8.5): 600
 * DIP wide, glued to the main window, showing Bloqueos, Emergencia or Ajustes (DETAILS's lazy
 * views, prefetched as soon as the window exists so a door opens instantly). Here content may
 * scroll, and only inside `.detail-shell` (styles/shell.css), whose scrollbar gutter is measured
 * here so the right margin stays 12 px whether the view scrolls or not. Esc or its X close it
 * (the Esc cascade's last step sends `window:close-detail`).
 */
import { Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Info } from 'lucide-react';
import { EmptyState } from '../components';
import { RENDERER_ES } from '../i18n/es';
import { useAppStore } from '../store/context';
import { DETAIL_NAMES } from '../../../shared/ui-state';
import { detailView, preloadDetailViews } from './slots';
import { ReadyProbe } from './useReadySignal';

/**
 * Keeps `--detail-gutter` on the shell equal to the width of its (stable) scrollbar gutter: 0
 * with overlay scrollbars, the thin scrollbar's width otherwise. A gutter that changes (a new
 * display scale) changes the content box, so the `ResizeObserver` re-measures it.
 */
function useScrollbarGutter(ref: React.RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const shell = ref.current;
    if (!shell) return undefined;
    let last = '';
    const update = (): void => {
      // The shell has no border: outer width − inner width is the gutter.
      const value = `${Math.max(0, shell.offsetWidth - shell.clientWidth)}px`;
      if (value === last) return;
      last = value;
      shell.style.setProperty('--detail-gutter', value);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [ref]);
}

export function DetailWindow(): React.JSX.Element {
  const name = useAppStore((s) => s.env.detail?.name ?? null);
  const View = name ? detailView(name) : null;
  const title = name ? RENDERER_ES.shell.detailTitles[name] : RENDERER_ES.shell.appName;
  const shellRef = useRef<HTMLDivElement>(null);
  useScrollbarGutter(shellRef);

  useEffect(() => preloadDetailViews(DETAIL_NAMES), []);

  return (
    <div ref={shellRef} className="detail-shell">
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
