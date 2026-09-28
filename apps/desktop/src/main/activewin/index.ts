/** The active-window layer (PROMPT §5 capa 4): see `layer.ts`. */
export { ActiveWindowLayer, type ActiveWindowLayerOptions } from './layer';
export {
  ACTIVE_WINDOW_POLL_MS,
  ACTIVE_WINDOW_REFRESH_MS,
  ReportThrottle,
  browserOfProcess,
  catalogPlatform,
  hasActiveBlock,
  isServiceCovered,
  serviceOfWindow,
  type ForegroundWindow,
} from './match';
export { createForegroundReader, type ForegroundRead, type ForegroundReader } from './reader';
