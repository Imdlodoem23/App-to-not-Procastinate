/**
 * `sounds:load` (PROMPT §9 «Sonidos de concentración»): the WAV bytes of one of the offline
 * loops in `resources/sounds/` (`SOUND_FILES`). The file name comes from the fixed table, never
 * from the request, and the size is bounded.
 */
import { readFile, stat } from 'node:fs/promises';
import type { SoundData } from '../../shared/platform';
import type { SoundId } from '../../shared/prefs';
import { soundFilePath } from '../app/paths';

/** The loops are a few MB; anything bigger is not ours. */
export const SOUND_MAX_BYTES = 32 * 1024 * 1024;

export async function loadSound(soundsDir: string, sound: SoundId): Promise<SoundData> {
  const path = soundFilePath({ soundsDir }, sound);
  const info = await stat(path);
  if (!info.isFile() || info.size > SOUND_MAX_BYTES) throw new Error('sound file too large');
  const buffer = await readFile(path);
  // A plain Uint8Array (structured clone keeps it; a Node Buffer would arrive as one too).
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return { bytes, mime: 'audio/wav' };
}
