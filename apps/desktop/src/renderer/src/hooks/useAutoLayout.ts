/**
 * Main window «Alto automático» (docs/DESKTOP.md §7.4, §8.3). Measures the natural height of the
 * window content (`rootRef`) in regular and, if needed, compact density, picks the layout with
 * `chooseLayout`, applies it to `<html>` (`data-density`, `data-scroll`) and sends
 * `window:layout` only when the report changed. Main clamps it to the work area and resizes
 * the window from its anchored edge.
 *
 * Measuring sets `data-density` and `data-measuring` (which lifts the fixed height and the
 * scroll clamp) on `<html>` and reads the layout synchronously, so the user never sees the
 * trial density. It runs:
 * - on mount and whenever the caller's `deps` change (snapshot, local state, height budget);
 * - on `ResizeObserver` (any content change while visible), batched per frame by the browser;
 * - synchronously from `ui:prepare-show` through `WindowServices.measure()` (a hidden window
 *   gets no `ResizeObserver` callbacks, but forced layout still works).
 */
import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';
import type { Density } from '@centrate/shared/design/tokens';
import type { LayoutReport } from '../../../shared/ui-state';
import { useServices } from '../app/services';
import { useAppStoreApi } from '../store/context';
import { chooseLayout, sameLayout } from './layout';

/** Elements whose size changes mean the content height changed. */
const OBSERVED = '[data-measure]';

export function useAutoLayout(rootRef: RefObject<HTMLElement | null>, deps: DependencyList): void {
  const api = useAppStoreApi();
  const services = useServices();
  const lastSent = useRef<LayoutReport | null>(null);
  const runRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const html = document.documentElement;

    // Attribute writes invalidate style document-wide: write only real changes.
    const setDensity = (density: Density): void => {
      if (html.dataset['density'] !== density) html.dataset['density'] = density;
    };
    const measureWith = (density: Density): number => {
      setDensity(density);
      return root.getBoundingClientRect().height;
    };

    const measure = (): LayoutReport => {
      const max = api.getState().env.layout.maxContentHeight;
      html.dataset['measuring'] = '';
      let report: LayoutReport;
      try {
        report = chooseLayout(measureWith, max);
      } finally {
        delete html.dataset['measuring'];
      }
      setDensity(report.density);
      if (report.scroll) html.dataset['scroll'] = '';
      else if ('scroll' in html.dataset) delete html.dataset['scroll'];
      api.getState().setLayout(report);
      return report;
    };

    const run = (): void => {
      const report = measure();
      if (sameLayout(report, lastSent.current)) return;
      lastSent.current = report;
      api.getState().bridge.send('window:layout', report);
    };
    runRef.current = run;

    // `ui:prepare-show` measures synchronously and answers with `window:show-ack`, which also
    // counts as the last report sent.
    services.setMeasurer(() => {
      const report = measure();
      lastSent.current = report;
      return report;
    });

    const observer = new ResizeObserver(() => run());
    for (const el of root.querySelectorAll(OBSERVED)) observer.observe(el);
    run();
    return () => {
      observer.disconnect();
      services.setMeasurer(null);
      runRef.current = () => undefined;
    };
  }, [api, services, rootRef]);

  // Re-measure on every change the caller cares about (before paint). `deps` are the caller's
  // triggers, not values this effect reads.
  useLayoutEffect(() => {
    runRef.current();
  }, deps);
}
