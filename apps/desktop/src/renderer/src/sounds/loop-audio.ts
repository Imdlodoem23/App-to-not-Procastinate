/**
 * Turns a concentration loop from `resources/sounds/` (PROMPT §9, resources/sounds/README.md)
 * into samples the player loops at the audio context's own rate, with no seam and no aliasing.
 *
 * Why not let Web Audio do it:
 * - An `AudioBufferSourceNode` whose buffer rate differs from the context rate resamples by
 *   linear interpolation. The seam is clean, but it leaves spectral images above the file's
 *   Nyquist (measured in Chromium at 48 kHz: 11.3–22 kHz holds −22.8 dB of the energy of
 *   ruido-blanco, −26.4 dB of lluvia, −37.8 dB of lo-fi): hiss on a noise meant to be soft.
 * - `decodeAudioData` in a 48 kHz context resamples cleanly but treats the file as a one-shot and
 *   pads both ends with silence, which leaves a tick at the lo-fi seam.
 *
 * So the file is resampled once, here, with a band-limited (Kaiser-windowed sinc) kernel that
 * reads across the seam from the other end of the loop instead of from silence. The result has
 * exactly the loop's duration at the target rate and is played with `loop = true` at rate 1, so
 * nothing interpolates while it sounds.
 *
 * Pure module: no DOM, Node or Electron imports (tests run it in Node on the real files).
 */

/** A mono loop, samples in −1…1. */
export interface PcmLoop {
  sampleRate: number;
  samples: Float32Array;
}

// ---------------------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------------------

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Reads the 16-bit PCM mono WAV that `scripts/gen-sounds.mjs` writes (RIFF with `fmt `, an
 * optional `LIST/INFO` and `data`). Anything else throws: the files ship with the app, so a
 * different format means a broken build, not user input to adapt to.
 */
export function parseWav(bytes: Uint8Array): PcmLoop {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCc(view, 0) !== 'RIFF' || fourCc(view, 8) !== 'WAVE') {
    throw new Error('sound: not a RIFF/WAVE file');
  }
  let format: { sampleRate: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) throw new Error(`sound: chunk "${id}" is truncated`);
    if (id === 'fmt ') {
      if (size < 16) throw new Error('sound: "fmt " chunk is too short');
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (audioFormat !== 1 || channels !== 1 || bits !== 16) {
        throw new Error(
          `sound: expected 16-bit PCM mono, got format ${audioFormat}, ${channels} channel(s), ${bits} bits`,
        );
      }
      if (sampleRate < 8000 || sampleRate > 384000) {
        throw new Error(`sound: unsupported sample rate ${sampleRate}`);
      }
      format = { sampleRate };
    } else if (id === 'data') {
      data = { offset: body, length: size };
    }
    offset = body + size + (size & 1);
  }
  if (!format) throw new Error('sound: missing "fmt " chunk');
  if (!data || data.length < 2) throw new Error('sound: missing or empty "data" chunk');
  const frames = data.length >> 1;
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(data.offset + 2 * i, true) / 32768;
  return { sampleRate: format.sampleRate, samples };
}

// ---------------------------------------------------------------------------------------
// Circular band-limited resampling
// ---------------------------------------------------------------------------------------

/**
 * Kernel design. The cutoff sits at 0.45 × the lower of the two rates (0.9 × its Nyquist);
 * 48 taps with a Kaiser window (β 7.5, ≈ 77 dB stopband) put the transition at about
 * 0.40–0.50 × that rate, so the images of everything up to the file's Nyquist land in the
 * stopband. At 22.05 kHz the band is flat to ≈ 8.8 kHz and −6 dB at 9.9 kHz (Chromium's
 * linear interpolation is already −6 dB at 10 kHz); lo-fi (16 kHz) is low-passed at 6.5 kHz
 * when it is made. Measured on the three files at 44.1 and 48 kHz: ≤ −86 dB of the energy lies
 * above the file's Nyquist, and the seam is as smooth as any other sample.
 */
export const RESAMPLE_KERNEL = Object.freeze({ cutoff: 0.45, halfWidth: 24, beta: 7.5 });

/**
 * Most kernel phases kept in the table. Every rate pair the app meets (22.05 or 16 kHz into
 * 16–192 kHz) needs at most 1 280, so each output sample gets its exact phase; a stranger pair
 * falls back to the nearest of these (≤ 1/8192 sample off, far below the dither).
 */
const MAX_PHASES = 4096;

/** Output samples computed between two `yieldNow` calls in `resampleLoopAsync`. */
const CHUNK = 1 << 16;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

/** Zeroth-order modified Bessel function of the first kind (series; converges fast for β ≤ 20). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

interface Plan {
  n: number;
  m: number;
  taps: number;
  /** `phases` rows of `taps` coefficients; row p is for an output at fraction p / phases. */
  table: Float32Array;
  phases: number;
  /** Output k sits at input position k·n/m; with exact phases, its phase is (k·n mod m) / g. */
  g: number;
  exact: boolean;
  /** The input wrapped around by `taps − 1` samples: ext[e] = input[(e − (halfWidth − 1)) mod n]. */
  ext: Float32Array;
}

function plan(input: Float32Array, fromRate: number, toRate: number): Plan {
  for (const [name, rate] of [
    ['fromRate', fromRate],
    ['toRate', toRate],
  ] as const) {
    if (!Number.isInteger(rate) || rate <= 0)
      throw new RangeError(`${name} must be a positive integer`);
  }
  const n = input.length;
  if (n === 0) throw new RangeError('input is empty');
  const m = Math.max(1, Math.round((n * toRate) / fromRate));
  if (n * m > Number.MAX_SAFE_INTEGER) throw new RangeError('loop is too long');

  // Cutoff in cycles per input sample; when going down, the kernel widens with the ratio.
  const ratio = Math.min(1, toRate / fromRate);
  const fc = RESAMPLE_KERNEL.cutoff * ratio;
  const halfWidth = Math.ceil(RESAMPLE_KERNEL.halfWidth / ratio);
  // A multiple of 4 for the unrolled loop in `render`; the extra taps fall outside the window.
  const taps = 4 * Math.ceil(halfWidth / 2);

  const g = gcd(n, m);
  const exact = m / g <= MAX_PHASES;
  const phases = exact ? m / g : MAX_PHASES;

  const i0Beta = besselI0(RESAMPLE_KERNEL.beta);
  const table = new Float32Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    const row = new Float64Array(taps);
    for (let t = 0; t < taps; t++) {
      // Tap t reads input i + t − (halfWidth − 1); the output sits at i + frac.
      const x = frac + halfWidth - 1 - t;
      const r = x / halfWidth;
      const window =
        Math.abs(r) >= 1 ? 0 : besselI0(RESAMPLE_KERNEL.beta * Math.sqrt(1 - r * r)) / i0Beta;
      const arg = 2 * fc * x;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      row[t] = 2 * fc * sinc * window;
      sum += row[t] ?? 0;
    }
    // Unity gain at DC on every phase, so the phase pattern cannot modulate the level.
    for (let t = 0; t < taps; t++) table[p * taps + t] = (row[t] ?? 0) / sum;
  }

  const ext = new Float32Array(n + taps - 1);
  for (let e = 0; e < ext.length; e++) {
    ext[e] = input[(((e - (halfWidth - 1)) % n) + n) % n] ?? 0;
  }
  return { n, m, taps, table, phases, g, exact, ext };
}

function render(pl: Plan, out: Float32Array, from: number, to: number): void {
  const { n, m, taps, table, phases, g, exact, ext } = pl;
  for (let k = from; k < to; k++) {
    const pos = k * n;
    let i = Math.floor(pos / m);
    const rem = pos - i * m;
    let p: number;
    if (exact) {
      p = rem / g;
    } else {
      p = Math.round((rem * phases) / m);
      if (p === phases) {
        p = 0;
        i = i + 1 === n ? 0 : i + 1;
      }
    }
    // Four accumulators: about 1.4× faster in V8 than one. Indices stay in bounds by
    // construction (i < n, row + t < phases · taps), hence the assertions.
    const row = p * taps;
    let a0 = 0;
    let a1 = 0;
    let a2 = 0;
    let a3 = 0;
    for (let t = 0; t < taps; t += 4) {
      const e = i + t;
      const c = row + t;
      a0 += ext[e]! * table[c]!;
      a1 += ext[e + 1]! * table[c + 1]!;
      a2 += ext[e + 2]! * table[c + 2]!;
      a3 += ext[e + 3]! * table[c + 3]!;
    }
    out[k] = a0 + a1 + a2 + a3;
  }
}

/**
 * Resamples one lap of a seamless loop from `fromRate` to `toRate`. The output lasts the same
 * (`round(n · toRate / fromRate)` samples) and is itself a seamless loop: the kernel reads
 * across the seam from the other end of the loop, never from silence.
 */
export function resampleLoop(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice();
  const pl = plan(input, fromRate, toRate);
  const out = new Float32Array(pl.m);
  render(pl, out, 0, pl.m);
  return out;
}

/**
 * `resampleLoop` in slices of 65 536 output samples, awaiting `yieldNow` between them so a
 * 36 s loop (≈ 83 M multiply-adds at 48 kHz) never blocks the renderer in one go. Returns
 * `null` as soon as `cancelled()` is true (a newer sound was chosen meanwhile).
 */
export async function resampleLoopAsync(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  yieldNow: () => Promise<void>,
  cancelled: () => boolean = () => false,
): Promise<Float32Array | null> {
  if (fromRate === toRate) return input.slice();
  const pl = plan(input, fromRate, toRate);
  const out = new Float32Array(pl.m);
  for (let k = 0; k < pl.m; k += CHUNK) {
    if (cancelled()) return null;
    render(pl, out, k, Math.min(pl.m, k + CHUNK));
    if (k + CHUNK < pl.m) await yieldNow();
  }
  return cancelled() ? null : out;
}
