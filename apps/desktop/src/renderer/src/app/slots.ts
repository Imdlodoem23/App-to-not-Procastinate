/**
 * The entry points other renderer owners provide (docs/DESKTOP.md §3.2), resolved at build
 * time with `import.meta.glob`:
 * - BLOQUEO: `BloqueoSection` (no props) from `src/renderer/src/sections/bloqueo/index.ts`,
 *   bundled statically (eager) into the main window;
 * - DETAILS: a default component (no props) from `src/renderer/src/windows/<name>/index.tsx`
 *   for `bloqueos`, `emergencia` and `ajustes`, each its own lazy chunk.
 *
 * Phase 5 (docs/DESKTOP.md §15):
 * - DETAIL views `estadisticas` (STATS), `recompensas` and `logros` (REWARDS) come from the same
 *   `windows/<name>/index.tsx` glob;
 * - SURFACES: a default component from `windows/{mini-timer,osd,nuclear}/index.tsx`, the whole
 *   renderer of that window (lazy);
 * - SETUP: a default component from `windows/onboarding/index.tsx`, shown by the main window in
 *   place of its sections while `onboardingActive(snapshot)` (lazy);
 * - PLANNER: `features/<name>/index.ts(x)` may export `MainWindowFeature` (no props, renders
 *   nothing visible), mounted once in the main window: the sound player, the Pomodoro clock…
 *
 * A glob instead of plain imports keeps the shell building while those owners work in
 * parallel: a missing module resolves to `null` and the shell shows a stand-in. Once every
 * module exists this behaves exactly like `import` / `React.lazy(() => import(...))`.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { DetailName, SurfaceKind } from '../../../shared/ui-state';

type SectionModule = { BloqueoSection?: ComponentType };
type WindowModule = { default?: ComponentType };
type FeatureModule = { MainWindowFeature?: ComponentType };

const bloqueoModules = import.meta.glob<SectionModule>('../sections/bloqueo/index.{ts,tsx}', {
  eager: true,
});

const windowLoaders = import.meta.glob<WindowModule>('../windows/*/index.{ts,tsx}');

const featureModules = import.meta.glob<FeatureModule>('../features/*/index.{ts,tsx}', {
  eager: true,
});

function resolveBloqueo(): ComponentType | null {
  for (const mod of Object.values(bloqueoModules)) {
    if (typeof mod.BloqueoSection === 'function') return mod.BloqueoSection;
    console.error('sections/bloqueo/index.ts must export `BloqueoSection` (a component).');
  }
  return null;
}

/** Section 2 «Bloqueo», or `null` while BLOQUEO's module does not exist. */
export const BloqueoSection: ComponentType | null = resolveBloqueo();

function loaderFor(
  name: DetailName | SurfaceKind | 'onboarding',
): (() => Promise<WindowModule>) | null {
  return (
    windowLoaders[`../windows/${name}/index.tsx`] ??
    windowLoaders[`../windows/${name}/index.ts`] ??
    null
  );
}

type ViewName = DetailName | SurfaceKind | 'onboarding';

const lazyViews = new Map<ViewName, LazyExoticComponent<ComponentType> | null>();

/** The lazy detail view for `name`, or `null` while its owner's module does not exist. */
export function detailView(name: DetailName): LazyExoticComponent<ComponentType> | null {
  return lazyView(name);
}

/** The whole renderer of a Phase 5 surface window, or `null` while SURFACES's module is missing. */
export function surfaceView(kind: SurfaceKind): LazyExoticComponent<ComponentType> | null {
  return lazyView(kind);
}

/** The onboarding (main window, first run), or `null` while SETUP's module is missing. */
export function onboardingView(): LazyExoticComponent<ComponentType> | null {
  return lazyView('onboarding');
}

/** Every `MainWindowFeature` of `features/*` (mounted once by the main window). */
export const mainWindowFeatures: readonly ComponentType[] = Object.entries(featureModules)
  .sort(([a], [b]) => a.localeCompare(b))
  .flatMap(([, mod]) =>
    typeof mod.MainWindowFeature === 'function' ? [mod.MainWindowFeature] : [],
  );

function lazyView(name: ViewName): LazyExoticComponent<ComponentType> | null {
  if (lazyViews.has(name)) return lazyViews.get(name) ?? null;
  const load = loaderFor(name);
  const view = load
    ? lazy(async () => {
        const mod = await load();
        if (typeof mod.default !== 'function') {
          throw new Error(`windows/${name}/index.tsx must default-export a component`);
        }
        return { default: mod.default };
      })
    : null;
  lazyViews.set(name, view);
  return view;
}

/** Fetch every detail chunk ahead of time (the pre-warmed window opens views instantly). */
export function preloadDetailViews(names: readonly DetailName[]): void {
  for (const name of names) void loaderFor(name)?.().catch(() => undefined);
}
