/** The app updater (PROMPT §12): see `updater.ts` and `model.ts`. */
export { createUpdater, type Updater, type UpdaterBackend, type UpdaterOptions } from './updater';
export {
  UPDATE_DOWNLOAD_PAGE,
  afterCheck,
  isNewerVersion,
  offeredVersion,
  updaterErrorCode,
  updaterMode,
  type UpdaterMode,
} from './model';
