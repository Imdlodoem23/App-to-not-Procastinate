#!/usr/bin/env node
// Synthesizes the focus sounds of the Study Mode (PROMPT.md §9 «Sonidos de concentración»: rain,
// white noise and lo-fi, available offline) into apps/desktop/resources/sounds/:
//
//   lluvia.wav        rain: soft pink wash, dense tiny drops on surfaces, a few puddle bubbles,
//                     low roof rumble and a small room; slow gusts
//   ruido-blanco.wav  gentle noise: pink with a share of white on top, highs and sub-bass softened
//   lo-fi.wav         80 bpm, 12 bars (Gm9 C13 Fmaj9 Dm9 three times): FM electric piano, round
//                     bass, swung boom-bap drums, vibraphone melody on the 2nd and 3rd pass, tape
//                     wow and flutter, saturation, low-pass and vinyl crackle
//
// Everything is made here from fixed seeds: no samples, recordings or third-party audio. The files
// are original and dedicated to the public domain (CC0 1.0), recorded in ASSET-LICENSES.json.
//
// Seamless loops by construction, so no crossfade is needed (an equal-power crossfade dips
// correlated material and combs it at the seam):
// - every event (drop, click, note, drum hit) is written modulo the loop length, so a tail that
//   runs past the end continues at the start;
// - every filter, reverb and delay line runs two laps and keeps the second, so the state entering
//   sample 0 is exactly the state leaving the last sample;
// - every modulation (gusts, tremolo, wow, flutter) has a whole number of cycles per loop.
// The sample after the last one is therefore the one the synthesis would produce next.
//
// Format: 16-bit PCM WAV, mono, TPDF dither. There is no audio encoder in node_modules and no
// ffmpeg in CI, and each file must stay <= 1.2 MB. Rain and noise use 22.05 kHz (27 s and 24 s);
// lo-fi uses 16 kHz so its 36 s loop fits (the music is low-passed at 6.5 kHz anyway).
//
// Loudness: -20 LUFS integrated per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, absolute gate
// -70 LUFS, relative gate -10 LU), measured on the loop itself (circularly) after quantization,
// with true peak <= -1 dBTP (4x oversampling). Mono is measured as one channel (weight 1.0).
//
//   node scripts/gen-sounds.mjs            write the three files and print the loudness table
//   node scripts/gen-sounds.mjs --check    write nothing; exit 1 if a file is missing or differs
//   node scripts/gen-sounds.mjs --out DIR  write to DIR instead (previews)
//
// Playback (see the README next to the files): decode each file at its own sample rate (an
// OfflineAudioContext at 22050 or 16000 Hz) and loop it with an AudioBufferSourceNode, which
// resamples across the loop point. decodeAudioData in a 48 kHz context resamples the file as a
// one-shot and pads its ends with silence; lo-fi starts at a quiet moment to soften that case.
//
// Output is deterministic (seeded PRNG, V8's own Math functions), byte for byte on the same Node
// major; --check is meant for that.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const OUT_DIR = 'apps/desktop/resources/sounds';
/** Per-file size budget in bytes. */
const MAX_BYTES = 1_200_000;
const TARGET_LUFS = -20;
const MAX_TRUE_PEAK_DBTP = -1;
const TAU = 2 * Math.PI;

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

// ---------------------------------------------------------------------------------------------
// Randomness

/**
 * Seeded PRNG (mulberry32) with the distributions the synths need.
 * @param {number} seed
 */
function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = NaN;
  return {
    next,
    /** @param {number} lo @param {number} hi */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** Log-uniform in [lo, hi). @param {number} lo @param {number} hi */
    logRange: (lo, hi) => lo * Math.pow(hi / lo, next()),
    /** Standard normal (Box-Muller). */
    gauss() {
      if (!Number.isNaN(spare)) {
        const v = spare;
        spare = NaN;
        return v;
      }
      const r = Math.sqrt(-2 * Math.log(1 - next()));
      const a = TAU * next();
      spare = r * Math.sin(a);
      return r * Math.cos(a);
    },
    /** An independent stream, so adding draws to one part does not reshuffle the others. */
    fork: () => makeRng(Math.floor(next() * 4294967296)),
  };
}

/** @typedef {ReturnType<typeof makeRng>} Rng */

/** @param {Rng} rng @param {number} n */
function gaussianNoise(rng, n) {
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = rng.gauss();
  return b;
}

// ---------------------------------------------------------------------------------------------
// Filters. A processor is a stateful (x: number) => number.

/** @typedef {(x: number) => number} Proc */

/**
 * Biquad coefficients from the RBJ Audio EQ Cookbook, normalized: [b0, b1, b2, a1, a2].
 * `bandpass` has 0 dB gain at the centre.
 * @param {'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'highshelf'} type
 * @param {number} fs @param {number} f0 @param {number} q @param {number} [gainDb]
 */
function biquadCoefs(type, fs, f0, q, gainDb = 0) {
  const w = (TAU * f0) / fs;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      [b0, b1, b2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'highpass':
      [b0, b1, b2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'bandpass':
      [b0, b1, b2] = [alpha, 0, -alpha];
      [a0, a1, a2] = [1 + alpha, -2 * cw, 1 - alpha];
      break;
    case 'peaking':
      [b0, b1, b2] = [1 + alpha * A, -2 * cw, 1 - alpha * A];
      [a0, a1, a2] = [1 + alpha / A, -2 * cw, 1 - alpha / A];
      break;
    case 'highshelf': {
      const sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cw);
      b2 = A * (A + 1 + (A - 1) * cw - sq);
      a0 = A + 1 - (A - 1) * cw + sq;
      a1 = 2 * (A - 1 - (A + 1) * cw);
      a2 = A + 1 - (A - 1) * cw - sq;
      break;
    }
    default:
      throw new Error(`unknown biquad type ${type}`);
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/**
 * Biquad processor (transposed direct form II).
 * @param {number[]} c normalized coefficients
 * @returns {Proc}
 */
function biquadProc([b0, b1, b2, a1, a2]) {
  let z1 = 0;
  let z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  };
}

/** @param {Parameters<typeof biquadCoefs>} a */
const bq = (...a) => biquadProc(biquadCoefs(...a));

/**
 * Pink (-3 dB/octave) filter valid at any sample rate: one first-order low shelf per octave from
 * 10 Hz up, pole at f and zero at f·√2, so each octave adds a 3 dB step.
 * @param {number} fs
 */
function pinkSections(fs) {
  const secs = [];
  for (let f = 10; f * Math.SQRT2 < fs / 2; f *= 2) {
    secs.push({ p: Math.exp((-TAU * f) / fs), z: Math.exp((-TAU * f * Math.SQRT2) / fs) });
  }
  return secs;
}

/** @param {number} fs @returns {Proc} */
function pinkProc(fs) {
  const secs = pinkSections(fs).map((s) => ({ ...s, x1: 0, y1: 0 }));
  return (x) => {
    for (const s of secs) {
      const y = x - s.z * s.x1 + s.p * s.y1;
      s.x1 = x;
      s.y1 = y;
      x = y;
    }
    return x;
  };
}

/** Magnitude of the pink filter at `f` Hz. @param {number} fs @param {number} f */
function pinkGain(fs, f) {
  const w = (TAU * f) / fs;
  let g = 1;
  for (const { p, z } of pinkSections(fs)) {
    g *= Math.sqrt((1 - 2 * z * Math.cos(w) + z * z) / (1 - 2 * p * Math.cos(w) + p * p));
  }
  return g;
}

/**
 * Small mono room in the Freeverb layout (parallel damped combs into series all-passes).
 * @param {number} fs
 * @param {{ size?: number, feedback?: number, damp?: number }} [o]
 * @returns {Proc}
 */
function roomProc(fs, { size = 1, feedback = 0.78, damp = 0.3 } = {}) {
  const at = (/** @type {number} */ n) => Math.max(1, Math.round((n * fs) / 44100));
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((n) => ({
    buf: new Float64Array(at(n * size)),
    i: 0,
    lp: 0,
  }));
  const passes = [556, 441, 341].map((n) => ({ buf: new Float64Array(at(n)), i: 0 }));
  return (x) => {
    let out = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.lp = y * (1 - damp) + c.lp * damp;
      c.buf[c.i] = x + c.lp * feedback;
      if (++c.i === c.buf.length) c.i = 0;
      out += y;
    }
    out /= combs.length;
    for (const a of passes) {
      const b = a.buf[a.i];
      a.buf[a.i] = out + b * 0.5;
      if (++a.i === a.buf.length) a.i = 0;
      out = b - out;
    }
    return out;
  };
}

/** @param {Proc[]} procs @returns {Proc} */
function chain(procs) {
  return (x) => {
    for (const p of procs) x = p(x);
    return x;
  };
}

/**
 * Filters a loop circularly: runs the chain over it twice and keeps the second lap, so the state
 * that enters sample 0 is the state that leaves the last one and the output is periodic.
 * @param {Float64Array} buf @param {...Proc} procs
 */
function loopFilter(buf, ...procs) {
  const run = chain(procs);
  for (let i = 0; i < buf.length; i++) run(buf[i]);
  const out = new Float64Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = run(buf[i]);
  return out;
}

/** Filters a one-shot sound in place (it starts and ends in silence). */
function shotFilter(/** @type {Float64Array} */ buf, /** @type {Proc[]} */ ...procs) {
  const run = chain(procs);
  for (let i = 0; i < buf.length; i++) buf[i] = run(buf[i]);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// Loop building blocks

/**
 * Mixes `sig` into the loop `bus` from sample `start`, wrapping past the end.
 * @param {Float64Array} bus @param {ArrayLike<number>} sig @param {number} start @param {number} [gain]
 */
function addWrapped(bus, sig, start, gain = 1) {
  const n = bus.length;
  let j = ((Math.round(start) % n) + n) % n;
  for (let i = 0; i < sig.length; i++) {
    bus[j] += sig[i] * gain;
    if (++j === n) j = 0;
  }
}

/**
 * Slow modulation with whole cycles per loop: 1 + Σ depth·sin(2π·cycles·i/n + random phase).
 * @param {number} n @param {Rng} rng @param {[number, number][]} parts [cycles per loop, depth]
 */
function loopLfo(n, rng, parts) {
  const ps = parts.map(([c, d]) => ({ w: (TAU * c) / n, d, ph: rng.range(0, TAU) }));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 1;
    for (const p of ps) v += p.d * Math.sin(p.w * i + p.ph);
    out[i] = v;
  }
  return out;
}

/**
 * Poisson events over the loop with density rate·shape[i]^power per second (thinning).
 * @param {Rng} rng @param {number} fs @param {number} rate @param {Float64Array} shape
 * @param {number} power @param {(i: number) => void} emit
 */
function poissonLoop(rng, fs, rate, shape, power, emit) {
  let peak = 0;
  for (const v of shape) peak = Math.max(peak, v);
  const lmax = rate * Math.pow(peak, power);
  const end = shape.length / fs;
  for (let t = -Math.log(1 - rng.next()) / lmax; t < end; t += -Math.log(1 - rng.next()) / lmax) {
    const i = Math.floor(t * fs);
    if (rng.next() * lmax <= rate * Math.pow(shape[i], power)) emit(i);
  }
}

/** Largest absolute sample. @param {ArrayLike<number>} x */
function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/**
 * Rotates a loop so it starts at the quietest sample between `from` and `to` seconds from its
 * start (negative: before it, from the end), judged by the energy of the signal and of its slope
 * over ±2 ms. The loop is unchanged; the seam just lands where a player that resamples the file
 * as a one-shot (Web Audio's decodeAudioData pads it with silence) has least to smooth over.
 * @param {Float64Array} x @param {number} fs @param {number} from @param {number} to
 */
function startAtQuietest(x, fs, from, to) {
  const n = x.length;
  const at = (/** @type {number} */ i) => x[((i % n) + n) % n];
  const r = Math.round(0.002 * fs);
  let best = 0;
  let bestCost = Infinity;
  for (let i = Math.round(from * fs); i <= Math.round(to * fs); i++) {
    let cost = 0;
    for (let k = -r; k <= r; k++) {
      const v = at(i + k);
      const slope = (v - at(i + k - 1)) * 4;
      cost += v * v + slope * slope;
    }
    if (cost < bestCost) [best, bestCost] = [i, cost];
  }
  return Float64Array.from({ length: n }, (_, i) => at(i + best));
}

/** Sums loops of equal length. @param {...Float64Array} bufs */
function mix(...bufs) {
  const out = new Float64Array(bufs[0].length);
  for (const b of bufs) for (let i = 0; i < out.length; i++) out[i] += b[i];
  return out;
}

/** @param {Float64Array} buf @param {number} g */
function scale(buf, g) {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/**
 * Scales a bus in place so its integrated loudness is `lufs` (mixing by K-weighted loudness).
 * @param {Float64Array} buf @param {number} fs @param {number} lufs
 */
function atLoudness(buf, fs, lufs) {
  return scale(buf, Math.pow(10, (lufs - integratedLoudness(buf, fs)) / 20));
}

// ---------------------------------------------------------------------------------------------
// Measurement (ITU-R BS.1770-4), on loops: filters and blocks wrap around.

/**
 * K-weighting (pre-filter shelf and RLB high-pass) for any sample rate, from the analog
 * prototype used by libebur128; at 48 kHz it gives the coefficients printed in BS.1770.
 * @param {number} fs @returns {Proc[]}
 */
function kWeighting(fs) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  const shelf = [
    (Vh + (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q + K * K) / a0,
  ];
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  const d = 1 + K / Q + K * K;
  const highpass = [1, -2, 1, (2 * (K * K - 1)) / d, (1 - K / Q + K * K) / d];
  return [biquadProc(shelf), biquadProc(highpass)];
}

/**
 * Integrated loudness in LUFS of a mono loop.
 * @param {ArrayLike<number>} x @param {number} fs
 */
function integratedLoudness(x, fs) {
  const k = loopFilter(Float64Array.from(x), ...kWeighting(fs));
  const n = k.length;
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  const cum = new Float64Array(n + block + 1);
  for (let i = 0; i < n + block; i++) cum[i + 1] = cum[i] + k[i % n] * k[i % n];
  const z = [];
  for (let s = 0; s < n; s += step) z.push((cum[s + block] - cum[s]) / block);
  const lk = (/** @type {number} */ v) => -0.691 + 10 * Math.log10(v);
  const mean = (/** @type {number[]} */ a) => a.reduce((p, v) => p + v, 0) / a.length;
  const abs = z.filter((v) => lk(v) > -70);
  if (abs.length === 0) return -Infinity;
  const rel = lk(mean(abs)) - 10;
  return lk(mean(abs.filter((v) => lk(v) > rel)));
}

/** True peak (linear) by 4x windowed-sinc oversampling of the loop. @param {ArrayLike<number>} x */
function truePeak(x) {
  const n = x.length;
  const M = 12;
  const phases = [0.25, 0.5, 0.75].map((frac) => {
    const h = [];
    for (let m = -M + 1; m <= M; m++) {
      const t = frac - m;
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
      h.push(sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / M)));
    }
    return h;
  });
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(x[i]));
    for (const h of phases) {
      let v = 0;
      for (let m = -M + 1, j = 0; m <= M; m++, j++) v += x[(i + m + n) % n] * h[j];
      peak = Math.max(peak, Math.abs(v));
    }
  }
  return peak;
}

/** @param {ArrayLike<number>} x */
function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

const dB = (/** @type {number} */ v) => 20 * Math.log10(v);

// ---------------------------------------------------------------------------------------------
// Lluvia (rain)

/** @param {number} fs @param {number} seconds @param {number} seed */
function rain(fs, seconds, seed) {
  const n = Math.round(fs * seconds);
  const rng = makeRng(seed);
  // Gusts: slow swells of a couple of dB, with 2, 3, 7 and 13 cycles per loop.
  const gust = loopLfo(n, rng.fork(), [
    [2, 0.1],
    [3, 0.07],
    [7, 0.04],
    [13, 0.02],
  ]);

  // Distant rain: pink noise shaped into a soft «shhh».
  const wash = loopFilter(
    gaussianNoise(rng.fork(), n),
    pinkProc(fs),
    bq('highpass', fs, 380, 0.6),
    bq('lowpass', fs, 7800, 0.6),
    bq('peaking', fs, 2800, 0.8, 2.5),
    bq('highshelf', fs, 6500, 0.7, -2),
  );
  for (let i = 0; i < n; i++) wash[i] *= Math.pow(gust[i], 1.3);

  // Rain on a roof, felt more than heard.
  const rumble = loopFilter(
    gaussianNoise(rng.fork(), n),
    bq('lowpass', fs, 170, 0.7),
    bq('lowpass', fs, 170, 0.7),
    bq('highpass', fs, 35, 0.7),
  );
  for (let i = 0; i < n; i++) rumble[i] *= gust[i];

  // Close drops on leaves and sills: noise ticks through a random surface resonance, each scaled
  // to its own peak so none sticks out. Many quiet ones, some louder; denser in the gusts.
  const ticks = new Float64Array(n);
  const tr = rng.fork();
  poissonLoop(tr, fs, 120, gust, 2, (at) => {
    const tau = tr.logRange(0.0006, 0.004);
    const s = new Float64Array(Math.ceil((tau * 7 + 0.012) * fs));
    for (let k = 0; k < s.length; k++) {
      const t = k / fs;
      s[k] = tr.gauss() * (1 - Math.exp(-t / 0.00015)) * Math.exp(-t / tau);
    }
    shotFilter(s, bq('bandpass', fs, tr.logRange(900, 7200), tr.range(1.2, 4.5)));
    addWrapped(ticks, s, at, (0.12 + 0.88 * Math.pow(tr.next(), 3)) / peakOf(s));
  });

  // Drops on a puddle: a bubble whose pitch rises as it decays (van den Doel's model, damping
  // d = 0.043·f + 0.0014·f^1.5). Kept sparse and low so they never turn into a melody.
  const bubbles = new Float64Array(n);
  const br = rng.fork();
  poissonLoop(br, fs, 5, gust, 1, (at) => {
    const f0 = br.logRange(1300, 3800);
    const d = 0.043 * f0 + 0.0014 * Math.pow(f0, 1.5);
    const rise = br.range(0.05, 0.2) * d;
    const s = new Float64Array(Math.ceil((6 / d) * fs));
    let ph = 0;
    for (let k = 0; k < s.length; k++) {
      const t = k / fs;
      s[k] = Math.sin(ph) * Math.exp(-d * t) * (1 - Math.exp(-t / 0.0003));
      ph += (TAU * f0 * (1 + rise * t)) / fs;
    }
    addWrapped(bubbles, s, at, 0.15 + 0.85 * Math.pow(br.next(), 2));
  });

  atLoudness(wash, fs, -20);
  atLoudness(rumble, fs, -31);
  atLoudness(ticks, fs, -24.5);
  atLoudness(bubbles, fs, -33);
  const drops = mix(ticks, bubbles);
  const room = loopFilter(
    drops,
    roomProc(fs, { size: 0.7, feedback: 0.7, damp: 0.45 }),
    bq('lowpass', fs, 4500, 0.7),
  );
  atLoudness(room, fs, -29);
  return loopFilter(
    mix(wash, rumble, drops, room),
    bq('highpass', fs, 28, 0.7),
    bq('lowpass', fs, 9800, 0.5),
  );
}

// ---------------------------------------------------------------------------------------------
// Ruido blanco (gentle white noise)

/** @param {number} fs @param {number} seconds @param {number} seed */
function whiteNoise(fs, seconds, seed) {
  const n = Math.round(fs * seconds);
  const white = gaussianNoise(makeRng(seed), n);
  // Pink carries the body; white (-7 dB at 1 kHz) adds air above ~4 kHz, where it overtakes it.
  const pink = scale(loopFilter(white, pinkProc(fs)), 1 / pinkGain(fs, 1000));
  const blend = mix(pink, scale(Float64Array.from(white), 0.45));
  return loopFilter(
    blend,
    bq('highpass', fs, 25, 0.7),
    bq('highshelf', fs, 5000, 0.6, -3.5),
    bq('lowpass', fs, 9500, 0.55),
  );
}

// ---------------------------------------------------------------------------------------------
// Lo-fi

const midiHz = (/** @type {number} */ m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Electric piano: 1:1 FM whose index falls from a bright bark to an almost pure tone.
 * @param {number} fs @param {number} freq @param {number} vel @param {number} dur seconds held
 * @param {Rng} rng
 */
function epiano(fs, freq, vel, dur, rng) {
  const f = freq * Math.pow(2, rng.range(-3, 3) / 1200);
  const tau = 1.8 * Math.pow(261.63 / f, 0.35);
  const index0 = 0.8 + 1.4 * vel;
  const s = new Float64Array(Math.ceil((dur + 0.6) * fs));
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    const env =
      Math.min(1, t / 0.003) * Math.exp(-t / tau) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.09));
    const index = index0 * Math.exp(-t / 0.18) + 0.25;
    const bell = 0.06 * vel * Math.exp(-t / 0.12) * Math.sin(TAU * 4 * f * t);
    s[k] = vel * env * (Math.sin(TAU * f * t + index * Math.sin(TAU * f * t)) + bell);
  }
  return s;
}

/** Round bass: sine with a little 2nd and a plucked 3rd harmonic, softly saturated. */
function bass(
  /** @type {number} */ fs,
  /** @type {number} */ freq,
  /** @type {number} */ vel,
  /** @type {number} */ dur,
) {
  const s = new Float64Array(Math.ceil((dur + 0.25) * fs));
  const norm = Math.tanh(1.6);
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    const ph = TAU * freq * t;
    const env =
      Math.min(1, t / 0.008) * Math.exp(-t / 1.5) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.05));
    const y =
      Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.25 * Math.exp(-t / 0.04) * Math.sin(3 * ph);
    s[k] = (vel * env * Math.tanh(1.6 * y)) / norm;
  }
  return s;
}

/** Soft, round kick: falling sine plus a dull click. */
function kick(/** @type {number} */ fs, /** @type {number} */ vel, /** @type {Rng} */ rng) {
  const s = new Float64Array(Math.ceil(0.5 * fs));
  const click = new Float64Array(Math.ceil(0.02 * fs));
  for (let k = 0; k < click.length; k++) click[k] = rng.gauss() * Math.exp(-k / fs / 0.002);
  shotFilter(click, bq('lowpass', fs, 2500, 0.7));
  let ph = 0;
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    ph += (TAU * (50 + 85 * Math.exp(-t / 0.03))) / fs;
    const y = Math.sin(ph) * Math.exp(-t / 0.16) * Math.min(1, t / 0.001);
    s[k] = vel * Math.tanh(1.4 * (y + 0.15 * (click[k] ?? 0)));
  }
  return s;
}

/** Dusty snare: band-passed noise over a short tuned body. */
function snare(/** @type {number} */ fs, /** @type {number} */ vel, /** @type {Rng} */ rng) {
  const s = new Float64Array(Math.ceil(0.35 * fs));
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    s[k] = rng.gauss() * Math.min(1, t / 0.0015) * Math.exp(-t / 0.07);
  }
  shotFilter(s, bq('bandpass', fs, 1900, 0.8), bq('highpass', fs, 700, 0.7));
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    const body =
      0.55 * Math.sin(TAU * 180 * t) * Math.exp(-t / 0.045) +
      0.25 * Math.sin(TAU * 320 * t) * Math.exp(-t / 0.03);
    s[k] = vel * (1.6 * s[k] + body * Math.min(1, t / 0.001));
  }
  return shotFilter(s, bq('lowpass', fs, 5000, 0.7));
}

/** Hi-hat: high-passed noise, closed or open. */
function hat(
  /** @type {number} */ fs,
  /** @type {number} */ vel,
  /** @type {boolean} */ open,
  /** @type {Rng} */ rng,
) {
  const tau = open ? 0.15 : 0.03;
  const s = new Float64Array(Math.ceil((tau * 6 + 0.01) * fs));
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    s[k] = vel * rng.gauss() * Math.min(1, t / 0.0005) * Math.exp(-t / tau);
  }
  return shotFilter(s, bq('highpass', fs, 4500, 0.7), bq('highpass', fs, 3500, 0.7));
}

/** Vibraphone-like mallet: fundamental, the 4th partial of a tuned bar, a short strike. */
function vibe(
  /** @type {number} */ fs,
  /** @type {number} */ freq,
  /** @type {number} */ vel,
  /** @type {number} */ dur,
) {
  const s = new Float64Array(Math.ceil((dur + 1.2) * fs));
  const nyq = fs / 2 - 1000;
  for (let k = 0; k < s.length; k++) {
    const t = k / fs;
    const env =
      Math.min(1, t / 0.002) * Math.exp(-t / 1.4) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.2));
    let y = Math.sin(TAU * freq * t);
    if (4 * freq < nyq) y += 0.22 * Math.exp(-t / 0.3) * Math.sin(TAU * 4 * freq * t);
    if (9.9 * freq < nyq) y += 0.05 * Math.exp(-t / 0.03) * Math.sin(TAU * 9.9 * freq * t);
    s[k] = vel * env * y;
  }
  return s;
}

/**
 * The harmony: rootless voicings (Bill Evans A/B forms) that move by step, and a bass line whose
 * last note leads into the next root. Bass notes are [step, midi, length in steps, velocity].
 */
const PROGRESSION = [
  // Gm9 → C
  {
    keys: [58, 62, 65, 69],
    bass: [
      [0, 43, 6, 1],
      [7, 43, 2, 0.5],
      [10, 50, 3, 0.8],
      [14, 46, 2, 0.65],
    ],
  },
  // C13 → F
  {
    keys: [58, 62, 64, 69],
    bass: [
      [0, 48, 6, 1],
      [7, 48, 2, 0.5],
      [10, 43, 3, 0.8],
      [14, 40, 2, 0.65],
    ],
  },
  // Fmaj9 → Dm
  {
    keys: [57, 60, 64, 67],
    bass: [
      [0, 41, 6, 1],
      [7, 41, 2, 0.5],
      [10, 48, 3, 0.8],
      [14, 40, 2, 0.65],
    ],
  },
  // Dm9 → Gm (and back to the top of the loop)
  {
    keys: [57, 60, 64, 65],
    bass: [
      [0, 38, 6, 1],
      [7, 38, 2, 0.5],
      [10, 45, 3, 0.8],
      [14, 41, 2, 0.65],
    ],
  },
];

/** Keys rhythm per pass of the progression: [from step, to step, velocity]. */
const KEYS_RHYTHM = [
  [
    [0, 10, 0.78],
    [10, 16, 0.5],
  ],
  [
    [0, 10, 0.72],
    [10, 16, 0.48],
  ],
  [
    [0, 6, 0.74],
    [6, 10, 0.42],
    [10, 16, 0.5],
  ],
];

/**
 * Melody (F major pentatonic plus E) on the 2nd and 3rd pass, by bar: [step, midi, length, vel].
 * The last note rings over the loop point into bar 1, where it belongs to Gm9.
 * @type {Record<number, number[][]>}
 */
const MELODY = {
  4: [
    [2, 74, 2, 0.7],
    [4, 77, 2, 0.75],
    [6, 81, 6, 0.85],
    [14, 79, 2, 0.6],
  ],
  5: [
    [0, 76, 4, 0.8],
    [6, 74, 2, 0.65],
    [8, 72, 6, 0.75],
  ],
  6: [
    [2, 76, 2, 0.7],
    [4, 79, 4, 0.8],
    [10, 81, 2, 0.7],
    [12, 79, 4, 0.7],
  ],
  7: [
    [0, 77, 6, 0.8],
    [8, 76, 3, 0.65],
    [12, 72, 4, 0.7],
  ],
  8: [
    [2, 74, 2, 0.7],
    [4, 77, 2, 0.72],
    [6, 79, 2, 0.75],
    [8, 81, 4, 0.85],
    [14, 77, 2, 0.6],
  ],
  9: [
    [0, 79, 4, 0.8],
    [6, 76, 2, 0.65],
    [8, 74, 8, 0.75],
  ],
  10: [
    [2, 72, 2, 0.65],
    [4, 76, 2, 0.7],
    [6, 79, 2, 0.75],
    [8, 76, 8, 0.8],
  ],
  11: [
    [0, 77, 4, 0.8],
    [6, 76, 2, 0.65],
    [8, 74, 8, 0.75],
  ],
};

/**
 * Wow and flutter: a delay line read at a gently moving point (Hermite interpolation), whole
 * cycles per loop. Peak pitch deviation is `depth` (0.0012 = 0.12 %).
 * @param {Float64Array} x @param {Rng} rng @param {[number, number][]} mods [cycles, depth]
 */
function tape(x, rng, mods) {
  const n = x.length;
  const ms = mods.map(([c, depth]) => {
    const w = (TAU * c) / n;
    return { w, amp: depth / w, ph: rng.range(0, TAU) };
  });
  const out = new Float64Array(n);
  const at = (/** @type {number} */ i) => x[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    let d = 32; // fixed offset, larger than the wow and flutter swing
    for (const m of ms) d += m.amp * Math.sin(m.w * i + m.ph);
    const pos = i - d;
    const i0 = Math.floor(pos);
    const fr = pos - i0;
    const [xm1, x0, x1, x2] = [at(i0 - 1), at(i0), at(i0 + 1), at(i0 + 2)];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[i] = ((c3 * fr + c2) * fr + c1) * fr + x0;
  }
  return out;
}

/** @param {number} fs @param {number} seed */
function lofi(fs, seed) {
  const bpm = 80;
  const bars = 12;
  const beat = (60 / bpm) * fs;
  const n = Math.round(bars * 4 * beat);
  const rng = makeRng(seed);
  const swing = 0.58; // the off-beat 8th lands at 58 % of the beat (straight 50, triplet 67)
  /** Sample position of a 16th step in a bar, on the swung grid. */
  const at = (/** @type {number} */ bar, /** @type {number} */ step) => {
    const b = Math.floor(step / 4);
    const within = [0, swing / 2, swing, swing + (1 - swing) / 2][step - 4 * b];
    return (bar * 4 + b + within) * beat;
  };
  const ms = (/** @type {number} */ v) => (v * fs) / 1000;

  const keys = new Float64Array(n);
  let bassBus = new Float64Array(n);
  const melody = new Float64Array(n);
  const kicks = new Float64Array(n);
  const snares = new Float64Array(n);
  const hats = new Float64Array(n);
  const duck = new Float64Array(n).fill(1);
  const kr = rng.fork();
  const br = rng.fork();
  const mr = rng.fork();
  const dr = rng.fork();

  for (let bar = 0; bar < bars; bar++) {
    const pass = Math.floor(bar / 4);
    const pos = bar % 4;
    const last = bar === bars - 1;
    const chord = PROGRESSION[pos];

    // Keys: a slightly strummed, upward chord, the top voice a touch louder.
    for (const [from, to, vel] of KEYS_RHYTHM[pass]) {
      const start = at(bar, from) + kr.range(-1, 1) * ms(8);
      const dur = (at(bar, to) - at(bar, from)) / fs - 0.03;
      chord.keys.forEach((m, v) => {
        const strum = v * ms(12) * kr.range(0.7, 1.3);
        const vv = vel * kr.range(0.9, 1.05) * (v === chord.keys.length - 1 ? 1.12 : 1);
        addWrapped(keys, epiano(fs, midiHz(m), vv, dur - strum / fs, kr), start + strum);
      });
    }

    for (const [step, m, len, vel] of chord.bass) {
      const dur = (at(bar, step + len) - at(bar, step)) / fs - 0.02;
      const start = at(bar, step) + br.range(-1, 1) * ms(4);
      addWrapped(bassBus, bass(fs, midiHz(m), vel * br.range(0.92, 1.04), dur), start);
    }

    for (const [step, m, len, vel] of MELODY[bar] ?? []) {
      const dur = (at(bar, step + len) - at(bar, step)) / fs - 0.02;
      const start = at(bar, step) + mr.range(-1, 1) * ms(10);
      addWrapped(melody, vibe(fs, midiHz(m), vel * mr.range(0.9, 1.05), dur), start);
    }

    // Drums: boom bap with a lazy snare; bar 4 of each pass adds a pickup kick and an open hat,
    // the last bar leaves beat 3 empty and rolls ghost snares back into the top.
    /** @type {Record<number, number>} */
    const kickPattern = last
      ? { 0: 0.95, 7: 0.5 }
      : pos === 3
        ? { 0: 0.95, 7: 0.5, 10: 0.8, 15: 0.4 }
        : { 0: 0.95, 7: 0.55, 10: 0.85 };
    /** @type {Record<number, number>} */
    const snarePattern = { 4: 0.85, 12: 0.9 };
    if (pos === 1) snarePattern[15] = 0.16;
    if (pos === 2) snarePattern[9] = 0.14;
    if (last) Object.assign(snarePattern, { 13: 0.18, 14: 0.26, 15: 0.34 });
    const hatVel = [0.62, 0.4, 0.52, 0.4, 0.6, 0.4, 0.52, 0.42];

    for (const [step, vel] of Object.entries(kickPattern)) {
      const start = at(bar, Number(step)) + dr.range(-1, 1) * ms(3);
      const v = vel * dr.range(0.93, 1.03);
      addWrapped(kicks, kick(fs, v, dr), start);
      // Side-chain: the keys, bass and melody dip under each kick.
      for (let k = 0; k < ms(400); k++) {
        const i = (((Math.round(start) + k) % n) + n) % n;
        duck[i] *= 1 - 0.22 * v * (1 - Math.exp(-k / ms(4))) * Math.exp(-k / ms(110));
      }
    }
    for (const [step, vel] of Object.entries(snarePattern)) {
      const late = vel > 0.5 ? ms(10) : ms(4);
      const start = at(bar, Number(step)) + late + dr.range(-1, 1) * ms(3);
      addWrapped(snares, snare(fs, vel * dr.range(0.93, 1.03), dr), start);
    }
    for (let step = 0; step < 16; step += 2) {
      const open = step === 14 && pos === 3 && !last;
      const vel = hatVel[step / 2] * dr.range(0.85, 1.1) * (open ? 0.8 : 1);
      addWrapped(hats, hat(fs, vel, open, dr), at(bar, step) + dr.range(-1, 1) * ms(5));
    }
    const ghost = pos % 2 === 0 ? 11 : 7;
    addWrapped(hats, hat(fs, 0.22 * dr.range(0.8, 1.1), false, dr), at(bar, ghost));
  }

  // Suitcase tremolo on the keys (4.5 Hz) and motor vibrato on the vibes (5 Hz), whole cycles.
  const seconds = n / fs;
  for (let i = 0; i < n; i++) {
    keys[i] *= 1 - 0.1 * (0.5 + 0.5 * Math.sin((TAU * Math.round(4.5 * seconds) * i) / n));
    melody[i] *= 1 - 0.18 * (0.5 + 0.5 * Math.sin((TAU * Math.round(5 * seconds) * i) / n));
  }

  bassBus = loopFilter(bassBus, bq('lowpass', fs, 900, 0.7));
  // Balance by K-weighted loudness; the bass sits higher because K-weighting overstates lows.
  atLoudness(keys, fs, -21);
  atLoudness(bassBus, fs, -21.5);
  atLoudness(melody, fs, -21.5);
  atLoudness(kicks, fs, -21.5);
  atLoudness(snares, fs, -24.5);
  atLoudness(hats, fs, -34);

  const tonal = mix(keys, bassBus, melody);
  for (let i = 0; i < n; i++) tonal[i] *= duck[i];
  const send = mix(
    scale(keys.slice(), 0.22),
    scale(melody.slice(), 0.3),
    scale(snares.slice(), 0.35),
    scale(hats.slice(), 0.1),
  );
  const room = atLoudness(
    loopFilter(
      send,
      roomProc(fs, { size: 0.9, feedback: 0.78, damp: 0.35 }),
      bq('lowpass', fs, 4000, 0.7),
    ),
    fs,
    -28,
  );

  // Tape: wow (0.5 Hz) and flutter (6 Hz), gentle saturation, then the warm low-pass.
  let music = tape(mix(tonal, kicks, snares, hats, room), rng.fork(), [
    [Math.round(0.5 * seconds), 0.0012],
    [Math.round(6 * seconds), 0.00025],
  ]);
  atLoudness(music, fs, -17);
  const drive = 1.25;
  for (let i = 0; i < n; i++) music[i] = Math.tanh(drive * music[i]) / drive;
  music = loopFilter(music, bq('lowpass', fs, 6500, 0.6), bq('highpass', fs, 30, 0.7));

  // Vinyl: faint hiss, sparse crackle and the odd pop, each click scaled to its own peak. Pops
  // peak 27 dB under the music and crackle 4 to 16 dB under the pops: present, never a distraction.
  const vr = rng.fork();
  const hiss = atLoudness(
    loopFilter(gaussianNoise(vr, n), bq('highpass', fs, 1000, 0.7), bq('lowpass', fs, 5000, 0.7)),
    fs,
    -52,
  );
  const crackle = new Float64Array(n);
  const flat = new Float64Array(n).fill(1);
  const popPeak = peakOf(music) * Math.pow(10, -27 / 20);
  /** A click band-passed between `lo` and `hi` Hz, `amp` relative to a pop. */
  const click =
    (/** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ amp) =>
    (/** @type {number} */ i) => {
      const s = new Float64Array(Math.ceil(0.006 * fs));
      s[0] = 1;
      shotFilter(s, bq('bandpass', fs, vr.logRange(lo, hi), 0.9));
      addWrapped(crackle, s, i, ((vr.next() < 0.5 ? -1 : 1) * amp * popPeak) / peakOf(s));
    };
  poissonLoop(vr, fs, 8, flat, 1, (i) =>
    click(1500, 5000, 0.15 + 0.45 * Math.pow(vr.next(), 3))(i),
  );
  poissonLoop(vr, fs, 0.35, flat, 1, (i) => click(300, 1200, 1)(i));

  // Start the file just before the downbeat, at its quietest moment rather than on the kick.
  return startAtQuietest(mix(music, hiss, crackle), fs, -0.1, -0.015);
}

// ---------------------------------------------------------------------------------------------
// Output

/**
 * 16-bit PCM with TPDF dither.
 * @param {ArrayLike<number>} x @param {number} seed
 */
function quantize(x, seed) {
  const rng = makeRng(seed);
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * 32767 + rng.next() - rng.next());
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

/**
 * RIFF WAVE: fmt (PCM, mono), LIST/INFO (ASCII metadata), data.
 * @param {Int16Array} pcm @param {number} fs @param {Record<string, string>} info
 */
function wavFile(pcm, fs, info) {
  const entries = Object.entries(info).map(([id, text]) => {
    const body = Buffer.from(`${text}\0`, 'latin1');
    return { id, body, padded: body.length + (body.length % 2) };
  });
  const listSize = 4 + entries.reduce((s, e) => s + 8 + e.padded, 0);
  const dataSize = pcm.length * 2;
  const buf = Buffer.alloc(12 + 24 + 8 + listSize + 8 + dataSize);
  let o = 0;
  const str = (/** @type {string} */ s) => (o += buf.write(s, o, 'latin1'));
  const u32 = (/** @type {number} */ v) => (o = buf.writeUInt32LE(v, o));
  const u16 = (/** @type {number} */ v) => (o = buf.writeUInt16LE(v, o));
  str('RIFF');
  u32(buf.length - 8);
  str('WAVE');
  str('fmt ');
  u32(16);
  u16(1); // PCM
  u16(1); // mono
  u32(fs);
  u32(fs * 2);
  u16(2);
  u16(16);
  str('LIST');
  u32(listSize);
  str('INFO');
  for (const e of entries) {
    str(e.id);
    u32(e.padded);
    e.body.copy(buf, o);
    o += e.padded;
  }
  str('data');
  u32(dataSize);
  for (let i = 0; i < pcm.length; i++) o = buf.writeInt16LE(pcm[i], o);
  return buf;
}

/**
 * Normalizes a float loop to the target loudness, quantizes it and measures the result as
 * written.
 * @param {Float64Array} x @param {number} fs @param {number} seed
 */
function master(x, fs, seed) {
  const y = scale(
    Float64Array.from(x),
    Math.pow(10, (TARGET_LUFS - integratedLoudness(x, fs)) / 20),
  );
  const pcm = quantize(y, seed);
  const f = Float64Array.from(pcm, (v) => v / 32767);
  return {
    pcm,
    lufs: integratedLoudness(f, fs),
    truePeak: dB(truePeak(f)),
    samplePeak: dB(f.reduce((m, v) => Math.max(m, Math.abs(v)), 0)),
    rms: dB(rms(f)),
  };
}

const SOUNDS = [
  {
    file: 'lluvia.wav',
    title: 'Lluvia',
    fs: 22050,
    render: (/** @type {number} */ fs) => rain(fs, 27, 0x6c6c7576),
  },
  {
    file: 'ruido-blanco.wav',
    title: 'Ruido blanco',
    fs: 22050,
    render: (/** @type {number} */ fs) => whiteNoise(fs, 24, 0x72756964),
  },
  {
    file: 'lo-fi.wav',
    title: 'Lo-fi',
    fs: 16000,
    render: (/** @type {number} */ fs) => lofi(fs, 0x6c6f6669),
  },
];

const outDir = resolve(root, args.out ?? OUT_DIR);
const rows = [];
let stale = 0;
for (const sound of SOUNDS) {
  const x = sound.render(sound.fs);
  const m = master(x, sound.fs, 0x64697468 ^ x.length);
  const bytes = wavFile(m.pcm, sound.fs, {
    INAM: `Centrate - ${sound.title} (seamless loop)`,
    IART: 'Centrate contributors',
    ICOP: 'CC0 1.0 Universal (public domain dedication)',
    ICMT: `Procedurally synthesized, no samples. ${TARGET_LUFS} LUFS integrated (BS.1770-4).`,
    ISFT: 'scripts/gen-sounds.mjs',
  });
  if (bytes.length > MAX_BYTES) {
    throw new Error(`${sound.file}: ${bytes.length} bytes, over the ${MAX_BYTES} byte budget`);
  }
  if (m.truePeak > MAX_TRUE_PEAK_DBTP) {
    throw new Error(
      `${sound.file}: true peak ${m.truePeak.toFixed(2)} dBTP, over ${MAX_TRUE_PEAK_DBTP}`,
    );
  }
  const path = join(outDir, sound.file);
  if (args.check) {
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
      console.error(`stale: ${relative(root, path)} (run node scripts/gen-sounds.mjs)`);
      stale++;
    }
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path, bytes);
  }
  rows.push({
    file: sound.file,
    fs: sound.fs,
    seconds: m.pcm.length / sound.fs,
    bytes: bytes.length,
    ...m,
  });
}

const num = (/** @type {number} */ v, /** @type {number} */ d) =>
  v.toFixed(d).replace('-', '−').replace('.', ',');
console.log(
  '| Archivo | Muestreo | Bucle | Tamaño | Sonoridad integrada | Pico real | Pico de muestra | RMS |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(
    `| \`${r.file}\` | ${num(r.fs / 1000, 2)} kHz | ${num(r.seconds, 1)} s | ${num(r.bytes / 1e6, 2)} MB | ${num(r.lufs, 1)} LUFS | ${num(r.truePeak, 1)} dBTP | ${num(r.samplePeak, 1)} dBFS | ${num(r.rms, 1)} dBFS |`,
  );
}
if (args.check && stale > 0) process.exit(1);
