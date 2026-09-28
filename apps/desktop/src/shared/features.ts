/**
 * Feature flags of the desktop app. Phase 1 ships with every flag off; later phases flip
 * them here (one line each) once their feature is complete.
 *
 * Rules (docs/DESKTOP.md §9):
 * - Flags travel inside `UiSnapshot.features`. Renderers and pure view code read them from
 *   the snapshot, never by importing `FEATURES`, so tests and harness fixtures can turn a
 *   flag on without rebuilding.
 * - A disabled feature is **hidden**, never greyed out (PROMPT §10 «Oculta lo que no aplica»).
 * - Overrides are honoured only in harness mode (unpackaged app with a harness state), so a
 *   release build always runs with exactly `FEATURES`.
 *
 * Pure module: no DOM, Node or Electron imports (main, preload and renderers share it).
 */
import type { GuardianCapability } from '@centrate/shared/guardian-api';

export const FEATURE_NAMES = [
  /** Section 3 «Study Mode», its detail window, tray «Study Mode ▸», Ctrl+Shift+S. */
  'study',
  /** «Estadísticas…» tile in Progreso and its detail window (Recharts, lazy). */
  'stats',
  /** «Recompensas…» tile and window (reward shop, mascot). */
  'rewards',
  /** «Logros…» tile and window. */
  'achievements',
  /** Footer «Mini temporizador» button, tray checkbox and the 180×44 window. */
  'miniTimer',
  /** Big OSD notice (G-Helper `ToastForm`) for tray and global-shortcut actions. */
  'osd',
  /** First-run onboarding (5 steps). */
  'onboarding',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureFlags = Readonly<Record<FeatureName, boolean>>;

/** The shipped flags. Phase 1: everything off. */
export const FEATURES: FeatureFlags = Object.freeze({
  study: false,
  stats: false,
  rewards: false,
  achievements: false,
  miniTimer: false,
  osd: false,
  onboarding: false,
});

/**
 * Guardian capability a feature also needs (`health.capabilities`). A feature whose
 * capability the guardian does not report stays hidden even when its flag is on.
 */
export const FEATURE_CAPABILITIES: Readonly<Partial<Record<FeatureName, GuardianCapability>>> =
  Object.freeze({
    study: 'study',
    rewards: 'rewards',
  });

export function isFeatureName(value: unknown): value is FeatureName {
  return typeof value === 'string' && (FEATURE_NAMES as readonly string[]).includes(value);
}

/**
 * `FEATURES` with `overrides` applied. Main calls it with overrides only in harness mode;
 * unknown keys and non-boolean values are ignored.
 */
export function resolveFeatures(
  overrides?: Readonly<Record<string, unknown>> | null,
): FeatureFlags {
  const out: Record<FeatureName, boolean> = { ...FEATURES };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (isFeatureName(key) && typeof value === 'boolean') out[key] = value;
    }
  }
  return Object.freeze(out);
}

/**
 * Whether a feature is shown: its flag is on and, when it maps to a guardian capability and
 * `capabilities` is known (not `null`), the guardian reports it.
 */
export function featureEnabled(
  flags: FeatureFlags,
  name: FeatureName,
  capabilities: readonly string[] | null = null,
): boolean {
  if (!flags[name]) return false;
  const needed = FEATURE_CAPABILITIES[name];
  return needed === undefined || capabilities === null || capabilities.includes(needed);
}
