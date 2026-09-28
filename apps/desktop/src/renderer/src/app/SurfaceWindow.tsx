/**
 * The renderer of a Phase 5 surface window (docs/DESKTOP.md §15): the mini timer, the OSD pill
 * or the Nuclear overlay. PLATFORM creates the `BrowserWindow` (`?window=mini-timer|osd|nuclear`);
 * SURFACES's lazy view (`windows/<kind>/index.tsx`) draws everything inside it, from the
 * snapshot. Readiness is reported after the view, like the detail window.
 */
import { Suspense } from 'react';
import type { SurfaceKind } from '../../../shared/ui-state';
import { surfaceView } from './slots';
import { ReadyProbe } from './useReadySignal';

export function SurfaceWindow(props: { kind: SurfaceKind }): React.JSX.Element {
  const View = surfaceView(props.kind);
  return (
    <Suspense fallback={null}>
      {View ? <View /> : null}
      <ReadyProbe />
    </Suspense>
  );
}
