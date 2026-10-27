import { createRng, nextRandom } from "./rng";

/**
 * A stylised inflaton field: equal-amplitude octaves of plane waves (a nearly scale-invariant
 * pattern). Zooming in by one octave makes every ripple twice as large while a new, finer
 * octave fades in, so the zoom can run forever without repeating. The drawn zoom (2⁸) is
 * far smaller than the real growth (≥ e⁶⁰ ≈ 10²⁶); the readout states the real number.
 */

const WAVES_PER_OCTAVE = 7;
/** Octaves visible at once; octave n has wavenumber K0·2^(n − zoom) and fades in and out. */
export const OCTAVES = 5;
/** Wavenumber of the coarsest octave, in radians per logical pixel. */
export const K0 = (2 * Math.PI) / 1400;
/** Drawn zoom over the whole inflation chapter, in octaves. */
export const FIELD_ZOOM_OCTAVES = 8;

type Wave = { kx: number; ky: number; phase: number };

export type InflatonField = {
  seed: number;
  octaveWaves: Map<number, Wave[]>;
};

export function createInflatonField(seed: number): InflatonField {
  return { seed, octaveWaves: new Map() };
}

function wavesFor(field: InflatonField, octave: number): Wave[] {
  let waves = field.octaveWaves.get(octave);
  if (!waves) {
    const rng = createRng((field.seed * 7919 + octave * 104729) >>> 0);
    waves = [];
    for (let i = 0; i < WAVES_PER_OCTAVE; i += 1) {
      const angle = nextRandom(rng) * Math.PI * 2;
      const k = 1 + nextRandom(rng);
      waves.push({ kx: Math.cos(angle) * k, ky: Math.sin(angle) * k, phase: nextRandom(rng) * Math.PI * 2 });
    }
    field.octaveWaves.set(octave, waves);
  }
  return waves;
}

/** Octaves fade in at the fine end and out at the coarse end. */
export function octaveWeight(u: number): number {
  if (u <= 0 || u >= OCTAVES) {
    return 0;
  }
  const s = Math.sin((Math.PI * u) / OCTAVES);
  return s * s;
}

/**
 * Field value at logical (x, y) for a zoom of `zoom` octaves, roughly in [−1, 1].
 * Octave n has wavenumber K0·2^(n − zoom), so the pattern grows as the zoom increases.
 */
export function fieldValue(field: InflatonField, x: number, y: number, zoom: number): number {
  const first = Math.ceil(zoom);
  let sum = 0;
  let norm = 0;
  // Zoom about the centre of the frame.
  const px = x - 960;
  const py = y - 540;
  for (let n = first; n < first + OCTAVES; n += 1) {
    const w = octaveWeight(n - zoom);
    if (w === 0) {
      continue;
    }
    const k = K0 * 2 ** (n - zoom);
    let octaveSum = 0;
    for (const wave of wavesFor(field, n)) {
      octaveSum += Math.cos(k * (wave.kx * px + wave.ky * py) + wave.phase);
    }
    sum += w * octaveSum;
    norm += w * w * WAVES_PER_OCTAVE;
  }
  return norm > 0 ? (sum / Math.sqrt(norm)) * 0.6 : 0;
}

/** One octave alone, normalised to roughly [−1, 1], at wavenumber scale `k` (radians per pixel). */
export function octaveValue(field: InflatonField, octave: number, x: number, y: number, k: number): number {
  const px = x - 960;
  const py = y - 540;
  let sum = 0;
  for (const wave of wavesFor(field, octave)) {
    sum += Math.cos(k * (wave.kx * px + wave.ky * py) + wave.phase);
  }
  return sum / Math.sqrt(WAVES_PER_OCTAVE);
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/**
 * Expansion rate on screen (octaves per story second, up to a constant). Inflation runs at a
 * steady exponential rate, starts after the opening seed appears and dies away as it ends.
 */
export function inflationRate(story: number, inflationEnd: number): number {
  return smoothstep(0.4, 2.2, story) * (1 - smoothstep(inflationEnd - 1.4, inflationEnd + 0.8, story));
}

const ZOOM_TABLE_STEP = 0.01;
let zoomTable: { end: number; values: Float64Array } | null = null;

/** Zoom once inflation is over: the pattern frozen into the hot gas. */
export function finalFieldZoom(inflationEnd: number): number {
  return fieldZoom(inflationEnd + 5, inflationEnd);
}

/** Zoom (in octaves): the running integral of the expansion rate, scaled to FIELD_ZOOM_OCTAVES. */
export function fieldZoom(story: number, inflationEnd: number): number {
  if (!zoomTable || zoomTable.end !== inflationEnd) {
    const n = Math.ceil((inflationEnd + 1) / ZOOM_TABLE_STEP) + 1;
    const values = new Float64Array(n);
    for (let i = 1; i < n; i += 1) {
      values[i] = values[i - 1] + inflationRate((i - 0.5) * ZOOM_TABLE_STEP, inflationEnd) * ZOOM_TABLE_STEP;
    }
    const total = values[n - 1];
    for (let i = 0; i < n; i += 1) {
      values[i] = (values[i] / total) * FIELD_ZOOM_OCTAVES;
    }
    zoomTable = { end: inflationEnd, values };
  }
  const { values } = zoomTable;
  const f = Math.max(0, story) / ZOOM_TABLE_STEP;
  const i = Math.floor(f);
  if (i >= values.length - 1) {
    return values[values.length - 1];
  }
  return values[i] + (values[i + 1] - values[i]) * (f - i);
}
