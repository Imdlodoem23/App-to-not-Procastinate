import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseWav,
  resampleLoop,
  resampleLoopAsync,
} from '../../../src/renderer/src/sounds/loop-audio';
import { SOUND_FILES, type SoundId } from '../../../src/shared/prefs';

const SOUNDS = resolve(__dirname, '../../../resources/sounds');

/** A WAV file with the given format fields, samples written as 16-bit little endian. */
function wav(
  samples: ArrayLike<number>,
  opts: { rate?: number; channels?: number; bits?: number; format?: number; extra?: boolean } = {},
): Uint8Array {
  const { rate = 16000, channels = 1, bits = 16, format = 1, extra = false } = opts;
  const extraChunk = extra ? 9 + 1 : 0; // odd-sized «LIST» chunk plus its pad byte
  const data = samples.length * 2;
  const bytes = new Uint8Array(12 + 24 + (extra ? 8 + extraChunk : 0) + 8 + data);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * (bits / 8), true);
  v.setUint16(32, channels * (bits / 8), true);
  v.setUint16(34, bits, true);
  let at = 36;
  if (extra) {
    ascii(at, 'LIST');
    v.setUint32(at + 4, 9, true);
    at += 8 + extraChunk;
  }
  ascii(at, 'data');
  v.setUint32(at + 4, data, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(at + 8 + 2 * i, Math.round((samples[i] ?? 0) * 32767), true);
  }
  return bytes;
}

/** Whole-cycle tones, so the signal is itself a seamless loop of `seconds`. */
function tones(rate: number, seconds: number, freqs: readonly number[]): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / rate) / freqs.length;
    out[i] = v * 0.9;
  }
  return out;
}

/** Amplitude of the `f` Hz component of a loop (single DFT bin; `f` fits whole cycles). */
function amplitudeAt(x: Float32Array, rate: number, f: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    const a = (2 * Math.PI * f * i) / rate;
    re += (x[i] ?? 0) * Math.cos(a);
    im -= (x[i] ?? 0) * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

const db = (ratio: number): number => 20 * Math.log10(ratio);

/** Largest |second difference| across the seam over its 99.9th percentile inside the loop. */
function seamRatio(y: Float32Array): number {
  const n = y.length;
  const d2 = (i: number): number =>
    Math.abs((y[(i + 1) % n] ?? 0) - 2 * (y[i] ?? 0) + (y[(i - 1 + n) % n] ?? 0));
  const all = new Float64Array(n);
  for (let i = 0; i < n; i++) all[i] = d2(i);
  all.sort();
  return Math.max(d2(n - 1), d2(0)) / (all[Math.floor(0.999 * n)] ?? 1);
}

describe('parseWav', () => {
  const SHIPPED: Record<SoundId, { rate: number; seconds: number }> = {
    rain: { rate: 22050, seconds: 27 },
    'white-noise': { rate: 22050, seconds: 24 },
    lofi: { rate: 16000, seconds: 36 },
  };

  it('reads the three shipped loops', () => {
    for (const [id, { rate, seconds }] of Object.entries(SHIPPED) as [
      SoundId,
      { rate: number; seconds: number },
    ][]) {
      const pcm = parseWav(readFileSync(join(SOUNDS, SOUND_FILES[id])));
      expect(pcm.sampleRate, id).toBe(rate);
      expect(pcm.samples.length, id).toBe(rate * seconds);
      expect(Math.max(...pcm.samples.subarray(0, 50_000).map(Math.abs))).toBeLessThan(1);
    }
  });

  it('skips unknown chunks, odd-sized ones included', () => {
    const pcm = parseWav(wav([0, 0.5, -0.5], { rate: 22050, extra: true }));
    expect(pcm.sampleRate).toBe(22050);
    expect(Array.from(pcm.samples).map((s) => Math.round(s * 100) / 100)).toEqual([0, 0.5, -0.5]);
  });

  it('refuses anything that is not 16-bit PCM mono', () => {
    expect(() => parseWav(new TextEncoder().encode('not a wav file'))).toThrow(/RIFF/);
    expect(() => parseWav(wav([0, 0], { channels: 2 }))).toThrow(/mono/);
    expect(() => parseWav(wav([0, 0], { bits: 8 }))).toThrow(/16-bit/);
    expect(() => parseWav(wav([0, 0], { format: 3 }))).toThrow(/PCM/);
    expect(() => parseWav(wav([0], { rate: 4000 }))).toThrow(/sample rate/);
    expect(() => parseWav(wav([]))).toThrow(/data/);
    expect(() => parseWav(wav([0, 0, 0]).subarray(0, 46))).toThrow(/truncated/);
  });
});

describe('resampleLoop', () => {
  it('keeps the loop duration at every rate the app meets', () => {
    const x = new Float32Array(22050);
    expect(resampleLoop(x, 22050, 48000)).toHaveLength(48000);
    expect(resampleLoop(x, 22050, 44100)).toHaveLength(44100);
    expect(resampleLoop(x, 22050, 96000)).toHaveLength(96000);
    expect(resampleLoop(x.subarray(0, 16000), 16000, 44100)).toHaveLength(44100);
    expect(resampleLoop(x.subarray(0, 16000), 16000, 16000)).toHaveLength(16000);
    expect(() => resampleLoop(x, 0, 48000)).toThrow(RangeError);
    expect(() => resampleLoop(new Float32Array(0), 22050, 48000)).toThrow(RangeError);
  });

  it('reproduces in-band tones at the new rate, across the seam too', () => {
    const cases = [
      { from: 22050, to: 48000, freqs: [220, 1375, 5500, 8000] },
      { from: 22050, to: 44100, freqs: [100, 3000, 8500] },
      { from: 16000, to: 44100, freqs: [110, 2000, 6000] },
      { from: 16000, to: 48000, freqs: [55, 4000, 6300] },
      { from: 22050, to: 16000, freqs: [300, 2500, 6000] },
    ];
    for (const { from, to, freqs } of cases) {
      const y = resampleLoop(tones(from, 0.2, freqs), from, to);
      const ideal = tones(to, 0.2, freqs);
      let worst = 0;
      for (let i = 0; i < y.length; i++)
        worst = Math.max(worst, Math.abs((y[i] ?? 0) - (ideal[i] ?? 0)));
      expect(db(worst), `${from} → ${to}`).toBeLessThan(-60);
    }
  });

  it('stays accurate when a loop length gives more phases than the table keeps', () => {
    // 4 999 samples (prime) into 10 882: 10 882 phases, more than the 4 096 kept.
    const n = 4999;
    const cycles = [7, 130, 1500];
    const x = new Float32Array(n);
    const ideal = (pos: number): number =>
      cycles.reduce((v, c) => v + Math.sin((2 * Math.PI * c * pos) / n) / cycles.length, 0);
    for (let i = 0; i < n; i++) x[i] = ideal(i);
    const y = resampleLoop(x, 22050, 48000);
    expect(y).toHaveLength(10882);
    let worst = 0;
    for (let k = 0; k < y.length; k++) {
      worst = Math.max(worst, Math.abs((y[k] ?? 0) - ideal((k * n) / y.length)));
    }
    expect(db(worst)).toBeLessThan(-60);
  });

  it('leaves no image above the source Nyquist (Chromium linear interpolation does)', () => {
    // 9.9 kHz at 22.05 kHz: linear interpolation to 48 kHz mirrors it to 12.15 and 16.05 kHz.
    const x = tones(22050, 0.1, [9900]);
    const y = resampleLoop(x, 22050, 48000);
    const wanted = amplitudeAt(y, 48000, 9900);
    expect(db(wanted / 0.9)).toBeGreaterThan(-7); // cutoff region: −6 dB at 0.45 × 22.05 kHz
    for (const image of [22050 - 9900, 48000 - (22050 + 9900)]) {
      expect(db(amplitudeAt(y, 48000, image) / 0.9), `${image} Hz`).toBeLessThan(-75);
    }
    // Passband: an 8 kHz tone keeps its level.
    const pass = resampleLoop(tones(22050, 0.1, [8000]), 22050, 48000);
    expect(Math.abs(db(amplitudeAt(pass, 48000, 8000) / 0.9))).toBeLessThan(0.01);
  });

  it.each(Object.entries(SOUND_FILES))(
    'loops %s at 48 kHz with a seam as smooth as the file’s own',
    (_id, file) => {
      const pcm = parseWav(readFileSync(join(SOUNDS, file)));
      const y = resampleLoop(pcm.samples, pcm.sampleRate, 48000);
      expect(y.length).toBe((pcm.samples.length * 48000) / pcm.sampleRate);
      expect(seamRatio(y)).toBeLessThan(Math.max(0.5, 1.5 * seamRatio(pcm.samples)));
    },
    30_000,
  );
});

describe('resampleLoopAsync', () => {
  it('gives the same samples in slices, yielding between them', async () => {
    const x = tones(22050, 2, [440, 3000]);
    let yields = 0;
    const y = await resampleLoopAsync(x, 22050, 48000, async () => {
      yields++;
    });
    expect(yields).toBe(Math.ceil(96000 / 65536) - 1);
    expect(y).toEqual(resampleLoop(x, 22050, 48000));
  });

  it('stops as soon as it is cancelled', async () => {
    const x = tones(22050, 4, [440]);
    let calls = 0;
    const y = await resampleLoopAsync(
      x,
      22050,
      48000,
      async () => {},
      () => ++calls > 1,
    );
    expect(y).toBeNull();
    expect(calls).toBe(2);
  });
});
