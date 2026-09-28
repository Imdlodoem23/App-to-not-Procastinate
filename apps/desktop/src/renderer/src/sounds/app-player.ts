/**
 * The concentration-sound player on the renderer's real `AudioContext` (the part of
 * `loop-player.ts` that needs the DOM). The caller feeds it the bytes of `sounds:load`:
 *
 *   const player = createAppLoopPlayer(prefs.sounds.volume);
 *   const loaded = await invoke('sounds:load', { sound: 'rain' });
 *   if (loaded.ok) await player.play(loaded.value.bytes);
 *   player.setVolume(40);
 *   player.stop();
 */
import { createLoopPlayer, type LoopPlayer } from './loop-player';

export function createAppLoopPlayer(volume: number): LoopPlayer {
  // «playback»: background audio, so larger buffers and less CPU beat low latency.
  return createLoopPlayer(new AudioContext({ latencyHint: 'playback' }), { volume });
}
