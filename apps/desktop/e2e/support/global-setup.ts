/**
 * Runs once, before any worker starts: resolves the Electron binary.
 *
 * The `electron` package (44+) has no install script: its first `require('electron')`
 * downloads and unzips the binary into `node_modules/electron/dist`, then writes `path.txt`.
 * Every worker resolves it in `launchApp`, so on a fresh `npm ci` two workers raced through
 * the same download and one of them launched a binary the other was still writing
 * («Process failed to launch!» / «Electron failed to install correctly» on Windows, `spawn
 * ETXTBSY` on Linux). Resolving it here, in the runner process, leaves the workers a
 * finished install.
 */
import { electronBinary } from './app';

export default function globalSetup(): void {
  electronBinary();
}
