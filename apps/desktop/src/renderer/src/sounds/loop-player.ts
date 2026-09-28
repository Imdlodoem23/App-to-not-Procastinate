/**
 * Plays the concentration loops (PROMPT §9 «Sonidos de concentración», resources/sounds/README.md)
 * from the WAV bytes `sounds:load` returns: offline, gap-free and without aliasing.
 *
 * - Each file is resampled once to the context rate by `loop-audio.ts` (band-limited, reading
 *   across the seam) and looped by an `AudioBufferSourceNode` at rate 1, so Chromium never
 *   interpolates while it plays.
 * - Every start, stop and switch goes through a `FADE_SECONDS` gain ramp: lo-fi's first kick
 *   lands 20–60 ms after sample 0, and a loop cut mid-wave clicks.
 * - Volume changes glide over `VOLUME_RAMP_SECONDS` so dragging the slider does not zip.
 *
 * Graph: source (loop) → voice gain (fade) → master gain (volume) → destination. Switching
 * sounds crossfades two voices.
 *
 * The Web Audio surface is typed structurally (`AudioContextLike`…) so a real `AudioContext`
 * fits and the unit tests can drive a fake one in Node.
 */
import { parseWav, resampleLoopAsync } from './loop-audio';

/** Fade in on start, out on stop, crossfade on switch (kept within 300–500 ms). */
export const FADE_SECONDS = 0.4;
/** Glide of the master gain after a volume change. */
export const VOLUME_RAMP_SECONDS = 0.05;
/** Extra time after a fade before the source stops and the nodes are released. */
const RELEASE_MARGIN_SECONDS = 0.05;

/** App volume (0–100, `SoundPrefs.volume`) to gain: squared, so the slider feels even. */
export function volumeToGain(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  const v = Math.min(100, Math.max(0, volume)) / 100;
  return v * v;
}

// ---------------------------------------------------------------------------------------
// Structural Web Audio subset
// ---------------------------------------------------------------------------------------

export interface AudioParamLike {
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelAndHoldAtTime(cancelTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  copyToChannel(source: Float32Array, channelNumber: number): void;
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------

export interface LoopPlayerOptions {
  /** Initial app volume, 0–100. */
  volume: number;
  /** Lets the renderer breathe between resampling slices (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  /** Timer used to release faded-out nodes (default: `setTimeout`). */
  later?: (run: () => void, ms: number) => void;
}

export interface LoopPlayer {
  /**
   * Prepares `wav` and fades it in, fading out whatever was playing. Resolves `false` when a
   * newer `play` or `stop` superseded it before it started (nothing is played then).
   */
  play(wav: Uint8Array): Promise<boolean>;
  /** Fades out and stops; also cancels a `play` still preparing. */
  stop(): void;
  /** Sets the app volume (0–100) with a short glide. */
  setVolume(volume: number): void;
  /** Whether a loop is playing (or fading in). */
  readonly playing: boolean;
  /** Stops at once and closes the context. */
  close(): Promise<void>;
}

interface Voice {
  source: AudioBufferSourceNodeLike;
  fade: GainNodeLike;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function createLoopPlayer(
  context: AudioContextLike,
  options: LoopPlayerOptions,
): LoopPlayer {
  const yieldNow = options.yieldNow ?? macrotask;
  const later = options.later ?? ((run, ms) => void setTimeout(run, ms));
  const master = context.createGain();
  master.gain.setValueAtTime(volumeToGain(options.volume), context.currentTime);
  master.connect(context.destination);

  let voice: Voice | null = null;
  /** Bumped by every `play` and `stop`; a preparation that sees it change gives up. */
  let generation = 0;
  let closed = false;

  function fadeOut(v: Voice): void {
    const now = context.currentTime;
    v.fade.gain.cancelAndHoldAtTime(now);
    v.fade.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
    v.source.stop(now + FADE_SECONDS + RELEASE_MARGIN_SECONDS);
    later(
      () => {
        v.source.disconnect();
        v.fade.disconnect();
      },
      Math.ceil((FADE_SECONDS + 2 * RELEASE_MARGIN_SECONDS) * 1000),
    );
  }

  return {
    async play(wav) {
      if (closed) return false;
      const mine = ++generation;
      const superseded = (): boolean => closed || mine !== generation;
      const pcm = parseWav(wav);
      const samples = await resampleLoopAsync(
        pcm.samples,
        pcm.sampleRate,
        context.sampleRate,
        yieldNow,
        superseded,
      );
      if (!samples || superseded()) return false;
      if (context.state === 'suspended') await context.resume();
      if (superseded()) return false;

      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const fade = context.createGain();
      source.connect(fade);
      fade.connect(master);

      if (voice) fadeOut(voice);
      const now = context.currentTime;
      fade.gain.setValueAtTime(0, now);
      fade.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
      source.start(now);
      voice = { source, fade };
      return true;
    },

    stop() {
      generation++;
      if (!voice) return;
      fadeOut(voice);
      voice = null;
    },

    setVolume(volume) {
      const now = context.currentTime;
      master.gain.cancelAndHoldAtTime(now);
      master.gain.linearRampToValueAtTime(volumeToGain(volume), now + VOLUME_RAMP_SECONDS);
    },

    get playing() {
      return voice !== null;
    },

    async close() {
      if (closed) return;
      closed = true;
      generation++;
      voice = null;
      await context.close();
    },
  };
}
