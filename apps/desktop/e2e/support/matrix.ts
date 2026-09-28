/**
 * The state × display matrix of PROMPT §10 «Capturas con Playwright», shared by the layout
 * spec, the axe spec and the screenshot capture.
 *
 * `E2E_STATES=idle,one-block` narrows every matrix to those fixtures (local iteration).
 */
import {
  DISPLAY_PRESETS,
  DISPLAY_PRESET_IDS,
  HARNESS_STATE_IDS,
  harnessFixture,
  isHarnessStateId,
  type DisplayPresetId,
  type HarnessFixture,
  type HarnessStateId,
} from '../../src/shared/fixtures';

export const THEMES = ['light', 'dark'] as const;
export type CaptureTheme = (typeof THEMES)[number];

export function selectedStates(): readonly HarnessStateId[] {
  const filter = process.env['E2E_STATES']?.trim();
  if (!filter) return HARNESS_STATE_IDS;
  const wanted = filter.split(',').map((s) => s.trim());
  const unknown = wanted.filter((s) => !isHarnessStateId(s));
  if (unknown.length > 0) throw new Error(`E2E_STATES: unknown state(s) ${unknown.join(', ')}`);
  return HARNESS_STATE_IDS.filter((id) => wanted.includes(id));
}

export function selectedFixtures(): HarnessFixture[] {
  return selectedStates().map((id) => harnessFixture(id));
}

/** The presets grouped by device scale factor: one app launch per group. */
export function presetsByScale(
  presets: readonly DisplayPresetId[] = DISPLAY_PRESET_IDS,
): { scaleFactor: number; presets: DisplayPresetId[] }[] {
  const groups = new Map<number, DisplayPresetId[]>();
  for (const id of presets) {
    const scale = DISPLAY_PRESETS[id].scaleFactor;
    groups.set(scale, [...(groups.get(scale) ?? []), id]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([scaleFactor, ids]) => ({ scaleFactor, presets: ids }));
}

/** «1366x768@125» → «1366×768 al 125 %». */
export function presetLabel(id: DisplayPresetId): string {
  return DISPLAY_PRESETS[id].label;
}
