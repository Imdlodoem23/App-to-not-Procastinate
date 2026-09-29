import { describe, expect, it } from 'vitest';
import {
  FADE_SECONDS,
  VOLUME_RAMP_SECONDS,
  createLoopPlayer,
  volumeToGain,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
  type GainNodeLike,
} from '../../../src/renderer/src/sounds/loop-player';

type ParamEvent = ['set' | 'ramp' | 'hold', number, number?];

class FakeParam implements AudioParamLike {
  events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push(['set', value, time]);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push(['ramp', value, time]);
  }
  cancelAndHoldAtTime(time: number): void {
    this.events.push(['hold', time]);
  }
}

class FakeNode implements AudioNodeLike {
  outputs: AudioNodeLike[] = [];
  disconnected = false;
  constructor(readonly kind: string) {}
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.outputs.push(destination);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam();
  constructor() {
    super('gain');
  }
}

class FakeBuffer implements AudioBufferLike {
  data: Float32Array | null = null;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  copyToChannel(source: Float32Array, channel: number): void {
    expect(channel).toBe(0);
    this.data = source;
  }
}

class FakeSource extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor() {
    super('source');
  }
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 10;
  state = 'running';
  readonly destination = new FakeNode('destination');
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  constructor(readonly sampleRate = 48000) {}
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    expect(channels).toBe(1);
    return new FakeBuffer(length, rate);
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
}

/** 0.25 s of a 16 kHz 16-bit mono WAV (a tiny stand-in for lo-fi.wav). */
function wav(rate = 16000, seconds = 0.25): Uint8Array {
  const n = Math.round(rate * seconds);
  const bytes = new Uint8Array(44 + 2 * n);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, Math.round(8000 * Math.sin(i / 7)), true);
  return bytes;
}

function setup(sampleRate = 48000) {
  const context = new FakeContext(sampleRate);
  const released: (() => void)[] = [];
  const player = createLoopPlayer(context, {
    volume: 60,
    yieldNow: async () => {},
    later: (run) => released.push(run),
  });
  const master = context.gains[0] as FakeGain;
  return { context, player, master, released };
}

describe('volumeToGain', () => {
  it('maps the 0–100 slider to a squared gain, clamped', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(60)).toBeCloseTo(0.36);
    expect(volumeToGain(150)).toBe(1);
    expect(volumeToGain(-5)).toBe(0);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });
});

describe('loop player', () => {
  it('fades within 300–500 ms', () => {
    expect(FADE_SECONDS).toBeGreaterThanOrEqual(0.3);
    expect(FADE_SECONDS).toBeLessThanOrEqual(0.5);
  });

  it('routes the master gain to the speakers at the saved volume', () => {
    const { context, master } = setup();
    expect(master.outputs).toEqual([context.destination]);
    expect(master.gain.events).toEqual([['set', 0.36, 10]]);
  });

  it('loops the file resampled to the context rate and fades it in', async () => {
    const { context, player, master } = setup(44100);
    expect(await player.play(wav())).toBe(true);
    const [source] = context.sources;
    const fade = context.gains[1] as FakeGain;
    expect(source?.loop).toBe(true);
    const buffer = source?.buffer as FakeBuffer;
    expect(buffer.sampleRate).toBe(44100);
    expect(buffer.length).toBe(Math.round(0.25 * 44100));
    expect(buffer.data).toHaveLength(buffer.length);
    expect(source?.outputs).toEqual([fade]);
    expect(fade.outputs).toEqual([master]);
    expect(fade.gain.events).toEqual([
      ['set', 0, 10],
      ['ramp', 1, 10 + FADE_SECONDS],
    ]);
    expect(source?.startedAt).toBe(10);
    expect(player.playing).toBe(true);
  });

  it('crossfades when the sound changes', async () => {
    const { context, player } = setup();
    await player.play(wav());
    context.currentTime = 20;
    await player.play(wav(22050));
    const [first, second] = context.sources;
    const firstFade = context.gains[1] as FakeGain;
    const secondFade = context.gains[2] as FakeGain;
    expect(firstFade.gain.events.slice(2)).toEqual([
      ['hold', 20],
      ['ramp', 0, 20 + FADE_SECONDS],
    ]);
    expect(first?.stoppedAt).toBeGreaterThanOrEqual(20 + FADE_SECONDS);
    expect(secondFade.gain.events).toEqual([
      ['set', 0, 20],
      ['ramp', 1, 20 + FADE_SECONDS],
    ]);
    expect(second?.startedAt).toBe(20);
    expect(second?.stoppedAt).toBeNull();
  });

  it('fades out on stop, then releases the nodes', async () => {
    const { context, player, released } = setup();
    await player.play(wav());
    context.currentTime = 12;
    player.stop();
    const [source] = context.sources;
    const fade = context.gains[1] as FakeGain;
    expect(fade.gain.events.slice(2)).toEqual([
      ['hold', 12],
      ['ramp', 0, 12 + FADE_SECONDS],
    ]);
    expect(source?.stoppedAt).toBeGreaterThanOrEqual(12 + FADE_SECONDS);
    expect(source?.stoppedAt).toBeLessThan(12 + FADE_SECONDS + 0.1);
    expect(player.playing).toBe(false);
    expect(source?.disconnected).toBe(false);
    for (const run of released) run();
    expect(source?.disconnected).toBe(true);
    expect(fade.disconnected).toBe(true);
    player.stop(); // nothing left to stop
  });

  it('plays only the latest choice when choices overlap', async () => {
    const { context, player } = setup();
    const first = player.play(wav());
    const second = player.play(wav(22050, 0.2));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(context.sources).toHaveLength(1);
    expect((context.sources[0]?.buffer as FakeBuffer).length).toBe(0.2 * 48000);
  });

  it('cancels a sound still loading when stopped', async () => {
    const { context, player } = setup();
    const pending = player.play(wav());
    player.stop();
    expect(await pending).toBe(false);
    expect(context.sources).toHaveLength(0);
  });

  it('resumes a suspended context before starting', async () => {
    const { context, player } = setup();
    context.state = 'suspended';
    await player.play(wav());
    expect(context.state).toBe('running');
    expect(context.sources[0]?.startedAt).toBe(10);
  });

  it('glides to a new volume', () => {
    const { context, player, master } = setup();
    context.currentTime = 15;
    player.setVolume(100);
    expect(master.gain.events.slice(1)).toEqual([
      ['hold', 15],
      ['ramp', 1, 15 + VOLUME_RAMP_SECONDS],
    ]);
  });

  it('closes the context and ignores later calls', async () => {
    const { context, player } = setup();
    await player.close();
    expect(context.state).toBe('closed');
    expect(await player.play(wav())).toBe(false);
    await player.close();
  });
});
