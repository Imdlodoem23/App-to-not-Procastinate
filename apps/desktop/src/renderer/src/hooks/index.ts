/** Renderer hooks (docs/DESKTOP.md §7.4). */
export { useNow, useClockNow, useFrozenNow, useTick } from './useNow';
export { useHelp, type HelpApi } from './useHelp';
export { useArmed, type ArmedApi } from './useArmed';
export { useAutoLayout } from './useAutoLayout';
export { chooseLayout, sameLayout } from './layout';
export { useRepair, type RepairApi } from './useRepair';
export {
  useEscape,
  useKeyBinding,
  useChord,
  useMnemonic,
  useKeyListener,
  isTextTarget,
} from './useKeys';
export {
  ESC_PRIORITY,
  CHORD_WINDOW_MS,
  KeyRegistry,
  matchCombo,
  mnemonicFromCode,
  type Binding,
  type Chord,
  type Combo,
  type KeyInput,
} from './keys';
export { alignedDelay, armRemainingMs } from './time';
export {
  useFocusTarget,
  useServices,
  type FocusTargetName,
  type WindowServices,
} from '../app/services';
