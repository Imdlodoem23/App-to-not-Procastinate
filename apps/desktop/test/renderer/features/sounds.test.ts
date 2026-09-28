/**
 * Concentration sounds (PROMPT §9, §10): the «Sonido» cycle Nada → Lluvia → Ruido blanco → Lo-fi,
 * when something should sound (study, autoplay with a block, the user's own pick; never in the
 * harness), and the controller that loads each file once, plays, switches, stops, follows the
 * volume and stays silent when a file cannot be loaded.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SoundData } from '../../../src/shared/platform';
import type { SoundId } from '../../../src/shared/prefs';
import { withLocale } from '../../../src/shared/i18n/locale';
import { fail, ok, uiError, type CommandResult } from '../../../src/shared/ui-state';
import type { LoopPlayer } from '../../../src/renderer/src/sounds/loop-player';
import {
  SOUND_CYCLE,
  ambientName,
  desiredSound,
  manualAfterChange,
  nextAmbient,
  soundTileHelp,
  soundTileLabel,
  type SoundPlanInput,
} from '../../../src/renderer/src/features/sounds/cycle';
import {
  createSoundController,
  type SoundStatus,
} from '../../../src/renderer/src/features/sounds/controller';

describe('«Sonido» cycle', () => {
  it('goes Nada → Lluvia → Ruido blanco → Lo-fi → Nada', () => {
    expect(SOUND_CYCLE).toEqual(['none', 'rain', 'white-noise', 'lofi']);
    expect(nextAmbient('none')).toBe('rain');
    expect(nextAmbient('rain')).toBe('white-noise');
    expect(nextAmbient('white-noise')).toBe('lofi');
    expect(nextAmbient('lofi')).toBe('none');
  });

  it('says what sounds and what the next click plays', () => {
    expect(soundTileLabel('rain')).toBe('Sonido: Lluvia');
    expect(soundTileLabel('none')).toBe('Sonido: Nada');
    expect(soundTileHelp('white-noise')).toBe('Un clic pasa a Lo-fi; suena sin internet');
    withLocale('en', () => {
      expect(soundTileLabel('white-noise')).toBe('Sound: White noise');
      expect(ambientName('none')).toBe('None');
    });
  });
});

describe('what should sound', () => {
  const base: SoundPlanInput = {
    enabled: true,
    prefs: { ambient: 'rain', autoplay: false },
    blockActive: false,
    studyActive: false,
    manual: false,
    harness: false,
  };

  it('plays a study session, a block with autoplay, and the user’s own pick', () => {
    expect(desiredSound(base)).toBeNull();
    expect(desiredSound({ ...base, studyActive: true })).toBe('rain');
    expect(desiredSound({ ...base, blockActive: true })).toBeNull();
    expect(
      desiredSound({ ...base, blockActive: true, prefs: { ambient: 'lofi', autoplay: true } }),
    ).toBe('lofi');
    expect(desiredSound({ ...base, manual: true })).toBe('rain');
  });

  it('is silent for «Nada», with the flag off and in the harness', () => {
    const playing = { ...base, studyActive: true, manual: true };
    expect(desiredSound({ ...playing, prefs: { ambient: 'none', autoplay: true } })).toBeNull();
    expect(desiredSound({ ...playing, enabled: false })).toBeNull();
    expect(desiredSound({ ...playing, harness: true })).toBeNull();
  });

  it('counts a pick as starting by hand and «Nada» as stopping', () => {
    expect(manualAfterChange('none', 'rain', false)).toBe(true);
    expect(manualAfterChange('rain', 'lofi', true)).toBe(true);
    expect(manualAfterChange('lofi', 'none', true)).toBe(false);
    expect(manualAfterChange('rain', 'rain', false)).toBe(false);
    expect(manualAfterChange('rain', 'rain', true)).toBe(true);
  });
});

/** A player that records what it was asked. */
function fakePlayer(): LoopPlayer & { log: string[] } {
  const log: string[] = [];
  let playing = false;
  return {
    log,
    play: vi.fn(async (wav: Uint8Array) => {
      log.push(`play ${wav[0] ?? '?'}`);
      playing = true;
      return true;
    }),
    stop: vi.fn(() => {
      log.push('stop');
      playing = false;
    }),
    setVolume: vi.fn((v: number) => {
      log.push(`volume ${v}`);
    }),
    get playing() {
      return playing;
    },
    close: vi.fn(async () => {
      log.push('close');
    }),
  };
}

const BYTE: Readonly<Record<SoundId, number>> = { rain: 1, 'white-noise': 2, lofi: 3 };

function loader(failing: readonly SoundId[] = []) {
  return vi.fn(async (sound: SoundId): Promise<CommandResult<SoundData>> => {
    if (failing.includes(sound)) return fail(uiError('internal', 'sound_unavailable', 500));
    return ok({ bytes: new Uint8Array([BYTE[sound]]), mime: 'audio/wav' });
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('sound controller', () => {
  it('makes no audio context for silence, then loads each file once', async () => {
    const player = fakePlayer();
    const createPlayer = vi.fn(() => player);
    const load = loader();
    const statuses: SoundStatus[] = [];
    const c = createSoundController({ load, createPlayer, onStatus: (s) => statuses.push(s) });
    c.apply({ sound: null, volume: 60 });
    expect(createPlayer).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();

    c.apply({ sound: 'rain', volume: 60 });
    await flush();
    expect(createPlayer).toHaveBeenCalledWith(60);
    expect(c.status).toBe('playing');
    c.apply({ sound: 'lofi', volume: 60 });
    await flush();
    c.apply({ sound: 'rain', volume: 60 });
    await flush();
    expect(load.mock.calls.map(([s]) => s)).toEqual(['rain', 'lofi']);
    expect(player.log).toEqual(['play 1', 'play 3', 'play 1']);
    expect(statuses).toEqual(['loading', 'playing', 'loading', 'playing', 'loading', 'playing']);

    c.apply({ sound: null, volume: 60 });
    expect(player.log.at(-1)).toBe('stop');
    expect(c.status).toBe('idle');
    await c.dispose();
    expect(player.log.at(-1)).toBe('close');
    c.apply({ sound: 'rain', volume: 60 });
    await flush();
    expect(player.log.at(-1)).toBe('close');
  });

  it('follows the volume without restarting the loop', async () => {
    const player = fakePlayer();
    const c = createSoundController({ load: loader(), createPlayer: () => player });
    c.apply({ sound: 'rain', volume: 60 });
    await flush();
    c.apply({ sound: 'rain', volume: 30 });
    c.apply({ sound: 'rain', volume: 30 });
    expect(player.log).toEqual(['play 1', 'volume 30']);
  });

  it('lets a newer choice win over one still loading', async () => {
    const player = fakePlayer();
    let release: (() => void) | null = null;
    const slow = vi.fn(
      (sound: SoundId) =>
        new Promise<CommandResult<SoundData>>((resolve) => {
          const answer = ok<SoundData>({ bytes: new Uint8Array([BYTE[sound]]), mime: 'audio/wav' });
          if (sound === 'rain') release = () => resolve(answer);
          else resolve(answer);
        }),
    );
    const c = createSoundController({ load: slow, createPlayer: () => player });
    c.apply({ sound: 'rain', volume: 50 });
    c.apply({ sound: 'white-noise', volume: 50 });
    await flush();
    (release as (() => void) | null)?.();
    await flush();
    expect(player.log).toEqual(['play 2']);
    expect(c.sound).toBe('white-noise');
  });

  it('stays silent when a file cannot be loaded, and tries again on the next choice', async () => {
    const player = fakePlayer();
    const load = loader(['lofi']);
    const c = createSoundController({ load, createPlayer: () => player });
    c.apply({ sound: 'rain', volume: 50 });
    await flush();
    c.apply({ sound: 'lofi', volume: 50 });
    await flush();
    expect(c.status).toBe('unavailable');
    expect(player.log).toEqual(['play 1', 'stop']);
    // The same target does not hammer main with retries.
    c.apply({ sound: 'lofi', volume: 50 });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    c.apply({ sound: 'rain', volume: 50 });
    await flush();
    c.apply({ sound: 'lofi', volume: 50 });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('survives a player that cannot decode or cannot start', async () => {
    const broken: LoopPlayer = {
      play: () => Promise.reject(new Error('sound: not a RIFF/WAVE file')),
      stop: () => undefined,
      setVolume: () => undefined,
      playing: false,
      close: () => Promise.resolve(),
    };
    const c = createSoundController({ load: loader(), createPlayer: () => broken });
    c.apply({ sound: 'rain', volume: 50 });
    await flush();
    expect(c.status).toBe('unavailable');
    const noContext = createSoundController({
      load: loader(),
      createPlayer: () => {
        throw new Error('AudioContext is not available');
      },
    });
    noContext.apply({ sound: 'rain', volume: 50 });
    await flush();
    expect(noContext.status).toBe('unavailable');
  });
});
