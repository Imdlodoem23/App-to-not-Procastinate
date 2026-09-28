/**
 * Drives the loop player from what should sound (`desiredSound`) and the volume, with its I/O
 * injected so the rules are unit-tested without Web Audio:
 *
 * - bytes come from `sounds:load` (main reads `resources/sounds/`), once per sound per run;
 * - the player (and so the `AudioContext`) is created on the first sound that loads, never for
 *   silence, and closed on `dispose`;
 * - switching crossfades (the player's job); a newer target supersedes one still loading;
 * - a sound that fails to load or decode stays silent (`unavailable`) until the target changes,
 *   so a missing file never loops on retries;
 * - the volume glides on every change (the player's `setVolume`).
 */
import type { SoundData } from '../../../../shared/platform';
import type { SoundId } from '../../../../shared/prefs';
import type { CommandResult } from '../../../../shared/ui-state';
import type { LoopPlayer } from '../../sounds/loop-player';

export type SoundStatus = 'idle' | 'loading' | 'playing' | 'unavailable';

export interface SoundTarget {
  sound: SoundId | null;
  /** 0–100 (`SoundPrefs.volume`). */
  volume: number;
}

export interface SoundControllerDeps {
  load(sound: SoundId): Promise<CommandResult<SoundData>>;
  createPlayer(volume: number): LoopPlayer;
  /** Told on every status change (the view can say «No se ha podido cargar el sonido»). */
  onStatus?(status: SoundStatus, sound: SoundId | null): void;
}

export interface SoundController {
  apply(target: SoundTarget): void;
  readonly status: SoundStatus;
  readonly sound: SoundId | null;
  /** Stops at once and closes the audio context (window unload). */
  dispose(): Promise<void>;
}

export function createSoundController(deps: SoundControllerDeps): SoundController {
  let player: LoopPlayer | null = null;
  let current: SoundId | null = null;
  let volume: number | null = null;
  let status: SoundStatus = 'idle';
  let generation = 0;
  let disposed = false;
  const bytes = new Map<SoundId, Uint8Array>();

  const setStatus = (next: SoundStatus): void => {
    if (next === status) return;
    status = next;
    deps.onStatus?.(next, current);
  };

  const fetchBytes = async (sound: SoundId): Promise<Uint8Array | null> => {
    const cached = bytes.get(sound);
    if (cached) return cached;
    try {
      const result = await deps.load(sound);
      if (!result.ok) return null;
      bytes.set(sound, result.value.bytes);
      return result.value.bytes;
    } catch {
      return null;
    }
  };

  const start = async (sound: SoundId, mine: number): Promise<void> => {
    setStatus('loading');
    const data = await fetchBytes(sound);
    if (disposed || mine !== generation) return;
    if (!data) {
      player?.stop();
      setStatus('unavailable');
      return;
    }
    try {
      player ??= deps.createPlayer(volume ?? 0);
      const started = await player.play(data);
      if (disposed || mine !== generation) return;
      setStatus(started ? 'playing' : 'idle');
    } catch {
      if (disposed || mine !== generation) return;
      bytes.delete(sound);
      player?.stop();
      setStatus('unavailable');
    }
  };

  return {
    apply(target) {
      if (disposed) return;
      if (target.volume !== volume) {
        volume = target.volume;
        player?.setVolume(target.volume);
      }
      if (target.sound === current) return;
      current = target.sound;
      const mine = ++generation;
      if (target.sound === null) {
        player?.stop();
        setStatus('idle');
        return;
      }
      void start(target.sound, mine);
    },
    get status() {
      return status;
    },
    get sound() {
      return current;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      const p = player;
      player = null;
      await p?.close();
    },
  };
}
