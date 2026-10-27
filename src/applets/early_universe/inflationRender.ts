import { INFLATION_END_STORY } from "./clock";
import { fieldZoom, inflationRate, InflatonField, K0, OCTAVES, octaveValue, octaveWeight } from "./field";
import { LIGHT_END, LIGHT_START, SCENE_H, SCENE_W } from "./sim";

/**
 * Inflation and the end of inflation, drawn onto the additive light layer (so it gets bloom).
 *
 * - Opening: a seed of light swells exponentially until the patch fills the frame.
 * - The field: equal-strength octaves of ripples. Each octave is baked once into a texture at its
 *   finest scale and then cropped and enlarged as space stretches; fine octaves fizz with quantum
 *   jitter, older (larger) ones are frozen in place, as fluctuations freeze once stretched beyond
 *   the horizon.
 * - Warp streaks: every point recedes from every other one; drawn as streaks rushing out of the centre.
 * - After inflation: the expansion coasts to a stop and the field dissolves as its energy turns
 *   into light.
 */

const TEX_W = 384;
const TEX_H = 216;
/** One fiery hue for the whole field: deep red-orange glow, hot gold filaments. */
const EMBER: [number, number, number] = [255, 72, 18];
const FILAMENT: [number, number, number] = [255, 196, 120];
const textures = new Map<string, HTMLCanvasElement>();

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/** Deterministic pseudo-random number in [0, 1) for an index (no state, so frames replay exactly). */
function hash(i: number, salt: number): number {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * Octave `n` at its finest appearance (wavenumber K0·2^OCTAVES across the frame): a soft coloured
 * glow where the field is high plus thin bright filaments along its zero crossings.
 */
function octaveTexture(field: InflatonField, n: number): HTMLCanvasElement {
  const key = `${field.seed}:${n}`;
  let tex = textures.get(key);
  if (tex) {
    return tex;
  }
  tex = document.createElement("canvas");
  tex.width = TEX_W;
  tex.height = TEX_H;
  const g = tex.getContext("2d") as CanvasRenderingContext2D;
  const img = g.createImageData(TEX_W, TEX_H);
  const [cr, cg, cb] = EMBER;
  const k = K0 * 2 ** OCTAVES;
  for (let j = 0; j < TEX_H; j += 1) {
    for (let i = 0; i < TEX_W; i += 1) {
      const v = octaveValue(field, n, ((i + 0.5) / TEX_W) * SCENE_W, ((j + 0.5) / TEX_H) * SCENE_H, k);
      // Deep colour only where the field is clearly high; filaments are thin lines at zero crossings.
      const glow = Math.max(0, v - 0.1) ** 2 * 0.85;
      const ridge = Math.max(0, 1 - Math.abs(v) * 6) ** 2.5 * 0.9;
      const a = Math.min(1, glow + ridge);
      const q = (j * TEX_W + i) * 4;
      if (a > 1e-3) {
        img.data[q] = Math.min(255, (cr * glow + FILAMENT[0] * ridge) / a);
        img.data[q + 1] = Math.min(255, (cg * glow + FILAMENT[1] * ridge) / a);
        img.data[q + 2] = Math.min(255, (cb * glow + FILAMENT[2] * ridge) / a);
      }
      img.data[q + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  textures.set(key, tex);
  // Old octaves never come back; keep the cache small.
  if (textures.size > 24) {
    const oldest = textures.keys().next().value;
    if (oldest !== undefined) {
      textures.delete(oldest);
    }
  }
  return tex;
}

const MOTES = 260;
const MOTE_R_MIN = 6;
const MOTE_R_MAX = 1300;

/** Streaks rushing outward: positions are fixed in log-radius and slide out as space stretches. */
function drawWarp(ctx: CanvasRenderingContext2D, zoom: number, strength: number): void {
  const span = Math.log(MOTE_R_MAX / MOTE_R_MIN);
  const buckets: Path2D[] = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  for (let i = 0; i < MOTES; i += 1) {
    const theta = hash(i, 1) * Math.PI * 2;
    const cycle = hash(i, 2) + zoom * 0.55;
    const frac = cycle - Math.floor(cycle);
    const r = MOTE_R_MIN * Math.exp(frac * span);
    const tail = r * (1 - 0.28 * strength);
    const fade = smoothstep(MOTE_R_MIN, 220, r) * (0.3 + 0.7 * hash(i, 3));
    const b = Math.min(3, Math.floor(fade * 4));
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    buckets[b].moveTo(SCENE_W / 2 + c * tail, SCENE_H / 2 + s * tail);
    buckets[b].lineTo(SCENE_W / 2 + c * r, SCENE_H / 2 + s * r);
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgb(255, 214, 170)";
  buckets.forEach((path, b) => {
    ctx.globalAlpha = ((b + 0.5) / 4) * 0.75 * strength;
    ctx.lineWidth = 1 + b * 0.5;
    ctx.stroke(path);
  });
}

let sparkSprite: HTMLCanvasElement | null = null;

function sparkle(): HTMLCanvasElement {
  if (!sparkSprite) {
    sparkSprite = document.createElement("canvas");
    sparkSprite.width = 32;
    sparkSprite.height = 32;
    const g = sparkSprite.getContext("2d") as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255, 250, 235, 1)");
    grad.addColorStop(0.25, "rgba(255, 170, 90, 0.8)");
    grad.addColorStop(1, "rgba(255, 80, 20, 0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return sparkSprite;
}

/** Quantum fizz: brief twinkles at the smallest scales, popping in and out. */
function drawSparkles(ctx: CanvasRenderingContext2D, story: number, strength: number): void {
  const rate = 14;
  const tick = Math.floor(story * rate);
  const phase = story * rate - tick;
  for (let k = 0; k < 2; k += 1) {
    const frame = tick - k;
    const life = phase + k;
    const alpha = Math.sin((Math.PI * life) / 2) * strength;
    for (let i = 0; i < 45; i += 1) {
      const seed = frame * 131 + i;
      const size = 3 + 6 * hash(seed, 3);
      ctx.globalAlpha = alpha * (0.3 + 0.7 * hash(seed, 4));
      ctx.drawImage(sparkle(), hash(seed, 1) * SCENE_W - size, hash(seed, 2) * SCENE_H - size, size * 2, size * 2);
    }
  }
}

/** The opening: a point of light that swells exponentially until it is the whole frame. */
function patchRadius(story: number): number {
  return 5 * Math.exp(2.1 * story);
}

function drawOpening(ctx: CanvasRenderingContext2D, story: number): void {
  const r = patchRadius(story);
  const cx = SCENE_W / 2;
  const cy = SCENE_H / 2;
  if (r < SCENE_W) {
    // Keep only the inside of the growing patch.
    const mask = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    mask.addColorStop(0, "rgba(0, 0, 0, 1)");
    mask.addColorStop(0.72, "rgba(0, 0, 0, 1)");
    mask.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.globalAlpha = 1;
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
    ctx.globalCompositeOperation = "lighter";
  }
  const core = 1 - smoothstep(1.4, 3.4, story);
  if (core <= 0) {
    return;
  }
  const glowR = 40 + r * 0.35;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glow.addColorStop(0, "rgba(255, 252, 240, 1)");
  glow.addColorStop(0.2, "rgba(255, 170, 90, 0.75)");
  glow.addColorStop(1, "rgba(255, 60, 10, 0)");
  ctx.globalAlpha = core;
  ctx.fillStyle = glow;
  ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
  // An anamorphic flare through the seed.
  const half = 260 + r * 1.2;
  const flare = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  flare.addColorStop(0, "rgba(255, 90, 30, 0)");
  flare.addColorStop(0.5, "rgba(255, 236, 210, 1)");
  flare.addColorStop(1, "rgba(255, 90, 30, 0)");
  ctx.globalAlpha = core * 0.8;
  ctx.fillStyle = flare;
  ctx.fillRect(cx - half, cy - 1.5, half * 2, 3);
  ctx.globalAlpha = core * 0.25;
  ctx.fillRect(cx - half * 0.7, cy - 6, half * 1.4, 12);
}

/** Draws inflation and the field fading into light afterwards, while it is visible. */
export function drawInflation(ctx: CanvasRenderingContext2D, field: InflatonField, story: number, gentle: boolean): void {
  // The field fades as its energy becomes light.
  const fade = 1 - smoothstep(LIGHT_START, LIGHT_END + 0.5, story);
  if (fade <= 0) {
    return;
  }
  const zoom = fieldZoom(story, INFLATION_END_STORY);
  const rate = inflationRate(story, INFLATION_END_STORY);
  const open = smoothstep(0, 1.6, story);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const first = Math.ceil(zoom);
  for (let n = first; n < first + OCTAVES; n += 1) {
    const u = n - zoom;
    const w = octaveWeight(u);
    if (w < 0.002) {
      continue;
    }
    const tex = octaveTexture(field, n);
    const f = 2 ** (OCTAVES - u);
    const sw = TEX_W / f;
    const sh = TEX_H / f;
    // Fine octaves shimmer (quantum jitter); stretched ones are frozen.
    const fizz = gentle || rate < 0.05 ? 0 : Math.max(0, u - 3.3) * 3 * rate;
    const dx = fizz * Math.sin(story * 29 + n * 1.7);
    const dy = fizz * Math.cos(story * 23 + n * 2.3);
    ctx.globalAlpha = Math.min(1, w * 0.8 * fade * open);
    ctx.drawImage(tex, (TEX_W - sw) / 2, (TEX_H - sh) / 2, sw, sh, dx, dy, SCENE_W, SCENE_H);
  }
  // Bake the next octave ahead of time so it never stalls a frame when it fades in.
  if (rate > 0) {
    octaveTexture(field, first + OCTAVES);
  }

  if (rate > 0.01) {
    drawWarp(ctx, zoom, rate * open);
    if (!gentle) {
      drawSparkles(ctx, story, 0.7 * rate * open);
    }
  }
  if (story < 3.6) {
    drawOpening(ctx, story);
  }
  ctx.restore();
}
