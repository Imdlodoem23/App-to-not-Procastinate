/**
 * Concentration sounds (PROMPT §9: lluvia, ruido blanco, lo-fi, offline; §10: «Sonido» cycles
 * Nada → Lluvia → Ruido blanco → Lo-fi on each click). `MainWindowFeature` is the player the main
 * window mounts once (docs/DESKTOP.md §15.2); `SoundTile` / `useCycleSound` are the control for
 * Study Mode and Ajustes; the rules are pure (`cycle.ts`, `controller.ts`).
 */
export { SoundPlayer as MainWindowFeature } from './SoundPlayer';
export { SoundTile, useCycleSound } from './SoundTile';
export * from './cycle';
export {
  createSoundController,
  type SoundController,
  type SoundStatus,
  type SoundTarget,
} from './controller';
export { SOUNDS, SOUNDS_EN, SOUNDS_ES, type SoundsMessages } from './i18n';
