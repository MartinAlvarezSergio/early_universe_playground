import { setLogicalTransform } from "../../core/canvasScale";
import { CAN_FILTER, drawBloom, drawGrain, drawVignette, layersFor } from "../../core/cinematicPost";
import { drawGlow, drawSphere, ring } from "../../core/glowSprites";
import {
  CHAPTERS,
  clockAt,
  ClockState,
  formatCosmicTime,
  formatEnergy,
  formatScientific,
  formatTemperature,
  INFLATION_EFOLDS,
  INFLATION_END_STORY,
  STORY_DURATION,
  superscript
} from "./clock";
import { fieldValue, finalFieldZoom, InflatonField } from "./field";
import { drawInflation } from "./inflationRender";
import {
  DEUTERON_BINDING_EV,
  ELECTRON_MASS_EV,
  HYDROGEN_BINDING_EV,
  log10PlanckTail,
  NUCLEON_MASS_EV
} from "./physics";
import { census, LIGHT_END, LIGHT_START, PAIRS_END, reactionProgress, SCENE_H, SCENE_W } from "./sim";
import type { Census, Fx, Particle, Reaction, SimSettings, SimState } from "./types";

export type SceneOptions = {
  captions: boolean;
  clock: boolean;
  legend: boolean;
  labels: boolean;
  timeline: boolean;
  /** Softer flashes, no camera drift or grain, for viewers who prefer reduced motion. */
  gentle: boolean;
  /** Cinematic mode: nothing over the film except time and temperature. */
  minimal: boolean;
};

type SceneInput = {
  state: SimState;
  field: InflatonField;
  settings: SimSettings;
};

const TEXT = "rgba(236, 233, 224, 0.95)";
const TEXT_MUTED = "rgba(214, 208, 196, 0.72)";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Quark colours (red, green, blue) and the matching anticolours (cyan, magenta, yellow) for antiquarks. */
const QUARK_COLORS = ["#ff5a5a", "#58f08e", "#5c96ff"];
/**
 * Antimatter always looks the same: hollow (a target of two rings) and magenta, a colour nothing
 * else uses, so it never blends in with matter, which is drawn solid. Antiquarks really carry
 * anticolour charges too; those are not drawn.
 */
const ANTI = "#ff3fd0";
const ELECTRON_COLOR = "#a6dcff";
const PROTON_COLOR = "#ffcf8f";
const NEUTRON_COLOR = "#b9c6dc";
const HELIUM_COLOR = "#ffe3a3";
const ORBIT_COLOR = "rgba(166, 220, 255, 0.32)";
/** Drawing scale of the simple particles (quarks, electrons) in logical pixels. */
const R = 1.4;

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/** Nucleons, nuclei and atoms grow as they take over the story, so they read well on a projector. */
const NUCLEI_START = CHAPTERS.find((c) => c.id === "nuclei")?.start ?? 70;

function compositeScale(story: number): number {
  return 1.5 + 0.95 * smoothstep(NUCLEI_START - 10, NUCLEI_START + 2, story);
}

/**
 * Pull-back after the antimatter is gone, so the frame fills with nuclei and atoms instead of
 * emptying out: [story s, scale]. Log-interpolated with an ease, so the camera glides.
 */
const ZOOM_KEYS: [number, number][] = [
  [56, 1],
  [70, 0.78],
  [84, 0.56],
  [102, 0.42],
  [112, 0.34],
  [134, 0.21]
];

export function zoomOut(story: number): number {
  if (story <= ZOOM_KEYS[0][0]) {
    return 1;
  }
  for (let i = 1; i < ZOOM_KEYS.length; i += 1) {
    const [s1, z1] = ZOOM_KEYS[i];
    if (story <= s1) {
      const [s0, z0] = ZOOM_KEYS[i - 1];
      const f = (story - s0) / (s1 - s0);
      const e = i === 1 ? f * f * (3 - 2 * f) : f;
      return z0 * (z1 / z0) ** e;
    }
  }
  return ZOOM_KEYS[ZOOM_KEYS.length - 1][1];
}

/**
 * Space is the same everywhere on large scales, so zooming out shows neighbouring copies of the
 * periodic simulation box. Each copy is wrapped round by its own random shift and mirrored or
 * flipped, so neighbours never line up and the repetition is hard to spot. Because the box is
 * periodic, the shift adds no seam inside a copy. The central box is the original.
 */
type Tile = { i: number; j: number; fx: number; fy: number; dx: number; dy: number };

function tileHash(i: number, j: number, salt: number): number {
  const v = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function tilesFor(cam: Camera): Tile[] {
  if (cam.s >= 0.999) {
    return [{ i: 0, j: 0, fx: 1, fy: 1, dx: 0, dy: 0 }];
  }
  const halfW = SCENE_W / 2 / cam.s + Math.abs(cam.ox) / cam.s;
  const halfH = SCENE_H / 2 / cam.s + Math.abs(cam.oy) / cam.s;
  const ni = Math.ceil(halfW / SCENE_W - 0.5) + 1;
  const nj = Math.ceil(halfH / SCENE_H - 0.5) + 1;
  const tiles: Tile[] = [];
  for (let j = -nj; j <= nj; j += 1) {
    for (let i = -ni; i <= ni; i += 1) {
      const base = i === 0 && j === 0;
      const v = base ? 0 : Math.floor(tileHash(i, j, 1) * 4);
      tiles.push({
        i,
        j,
        fx: v === 1 || v === 3 ? -1 : 1,
        fy: v === 2 || v === 3 ? -1 : 1,
        dx: base ? 0 : tileHash(i, j, 3) * SCENE_W,
        dy: base ? 0 : tileHash(i, j, 4) * SCENE_H
      });
    }
  }
  return tiles;
}

/** The box wrapped round by (dx, dy): same particles, shifted with periodic wrap. */
function shiftedState(state: SimState, dx: number, dy: number): SimState {
  return {
    ...state,
    particles: state.particles.map((p) => ({
      ...p,
      x: (p.x + dx) % SCENE_W,
      y: (p.y + dy) % SCENE_H
    }))
  };
}

function applyTile(ctx: CanvasRenderingContext2D, t: Tile): void {
  ctx.translate(t.i * SCENE_W + SCENE_W / 2, t.j * SCENE_H + SCENE_H / 2);
  ctx.scale(t.fx, t.fy);
  ctx.translate(-SCENE_W / 2, -SCENE_H / 2);
}

/** Rare atoms shown in some copies of the box (far more often than in reality). */
type Trace = "deuterium" | "helium3" | "lithium" | null;

function traceFor(t: Tile, p: Particle, story: number): Trace {
  if ((t.i === 0 && t.j === 0) || story < NUCLEI_START + 2) {
    return null;
  }
  const h = tileHash(t.i, t.j, 2);
  const pick = (p.id * 2654435761) % 997;
  if (p.kind === "helium" && h < 0.18 && pick % 2 === 0) {
    return "helium3";
  }
  if (p.kind === "nucleon" && !p.neutron) {
    if (h > 0.55 && pick % 13 === 0) {
      return "deuterium";
    }
    if (t.i === 2 && t.j === -1 && pick % 7 === 0) {
      return "lithium";
    }
  }
  return null;
}

// ---------- Sprites ----------

function drawAnti(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, width = 2): void {
  drawGlow(ctx, ANTI, x, y, r * 2.2, alpha * 0.4, 0.5);
  ring(ctx, ANTI, x, y, r, alpha, width);
  ring(ctx, ANTI, x, y, r * 0.45, alpha * 0.7, Math.max(1, width * 0.6));
}


// ---------- Colours ----------

/** Approximate sRGB colour of a blackbody (Tanner Helland's fit, valid ~1000–40000 K). */
export function blackbodyColor(tempK: number): [number, number, number] {
  const t = Math.min(40000, Math.max(1000, tempK)) / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const clamp = (v: number): number => Math.round(Math.min(255, Math.max(0, v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/** Visible-light colour for a wavelength in nm (380–750), as [r, g, b] in 0..255. */
function wavelengthColor(nm: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  if (nm < 440) {
    r = (440 - nm) / 60;
    b = 1;
  } else if (nm < 490) {
    g = (nm - 440) / 50;
    b = 1;
  } else if (nm < 510) {
    g = 1;
    b = (510 - nm) / 20;
  } else if (nm < 580) {
    r = (nm - 510) / 70;
    g = 1;
  } else if (nm < 645) {
    r = 1;
    g = (645 - nm) / 65;
  } else {
    r = 1;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

type PhotonStyle = { color: string; alpha: number };

/**
 * Photon streak colour from its energy in eV: above visible light (UV, X- and gamma rays) a cool
 * white; visible photons in their own colour; infrared ever dimmer red, so the afterglow fades
 * out of sight as it redshifts toward microwaves.
 */
export function photonStyle(energyEV: number): PhotonStyle {
  if (energyEV >= UV_EDGE_EV) {
    return { color: "rgb(222, 232, 255)", alpha: 0.78 };
  }
  if (energyEV >= 1.65) {
    const [r, g, b] = wavelengthColor(1240 / energyEV);
    return { color: `rgb(${r}, ${g}, ${b})`, alpha: 0.85 };
  }
  const f = Math.max(0, Math.min(1, Math.log(energyEV / 0.03) / Math.log(1.65 / 0.03)));
  return { color: `rgb(${Math.round(150 + 105 * f)}, ${Math.round(30 + 40 * f)}, ${Math.round(20 + 20 * f)})`, alpha: 0.05 + 0.6 * f * f };
}

/** Log-spaced buckets from the infrared to the violet edge, plus one for everything more energetic. */
const SPECTRAL_BUCKETS = 40;
const PHOTON_BUCKETS = SPECTRAL_BUCKETS + 1;
const UV_EDGE_EV = 3.26;
const BUCKET_LO = Math.log10(0.02);
const BUCKET_HI = Math.log10(UV_EDGE_EV);

/** Bucket index, so streaks can be drawn in a few batched paths. */
function photonBucket(energyEV: number): number {
  if (energyEV >= UV_EDGE_EV) {
    return SPECTRAL_BUCKETS;
  }
  const f = (Math.log10(Math.max(energyEV, 1e-6)) - BUCKET_LO) / (BUCKET_HI - BUCKET_LO);
  return Math.max(0, Math.min(SPECTRAL_BUCKETS - 1, Math.floor(f * SPECTRAL_BUCKETS)));
}

function bucketEnergy(bucket: number): number {
  if (bucket >= SPECTRAL_BUCKETS) {
    return UV_EDGE_EV * 10;
  }
  return 10 ** (BUCKET_LO + ((bucket + 0.5) / SPECTRAL_BUCKETS) * (BUCKET_HI - BUCKET_LO));
}

// ---------- Scene ----------

type Camera = { s: number; ox: number; oy: number };

/** A slow, breathing drift. Zoomed in slightly so the periodic box's edges never show. */
function cameraAt(story: number, gentle: boolean, rumble: number): Camera {
  if (gentle) {
    return { s: 1, ox: 0, oy: 0 };
  }
  const s = 1.06 + 0.02 * Math.sin(story * 0.09);
  const room = (s - 1) * 0.6;
  // A short rumble while big annihilations go off (at most a few pixels, inside the zoom margin).
  const shake = Math.min(7, rumble * 0.6);
  return {
    s,
    ox: room * (SCENE_W / 2) * Math.sin(story * 0.061) + shake * Math.sin(story * 71),
    oy: room * (SCENE_H / 2) * Math.cos(story * 0.047) + shake * Math.cos(story * 53)
  };
}

/** How much big annihilation energy is being released right now (sum over live big flashes). */
function blastEnergy(state: SimState): number {
  let e = 0;
  for (const f of state.fx) {
    if (f.kind === "flash" && f.size >= 30) {
      const t = (state.story - f.start) / f.duration;
      if (t >= 0 && t <= 1) {
        e += (1 - t) ** 2;
      }
    }
  }
  return e;
}

function applyCamera(ctx: CanvasRenderingContext2D, cam: Camera): void {
  ctx.translate(SCENE_W / 2 + cam.ox, SCENE_H / 2 + cam.oy);
  ctx.scale(cam.s, cam.s);
  ctx.translate(-SCENE_W / 2, -SCENE_H / 2);
}

function toScreen(cam: Camera, x: number, y: number): [number, number] {
  return [(x - SCENE_W / 2) * cam.s + SCENE_W / 2 + cam.ox, (y - SCENE_H / 2) * cam.s + SCENE_H / 2 + cam.oy];
}

export function renderScene(ctx: CanvasRenderingContext2D, input: SceneInput, opts: SceneOptions): void {
  const { state } = input;
  const clock = clockAt(state.story);
  const counts = census(state);
  const blast = blastEnergy(state);
  const cam = cameraAt(state.story, opts.gentle, blast);
  setLogicalTransform(ctx, SCENE_W);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  const glow = plasmaGlow(clock, counts);
  // No hot gas until the field's energy has turned into light: its glow arrives with the light.
  if (glow) {
    glow.alpha *= smoothstep(LIGHT_START - 1, LIGHT_END, state.story);
  }
  drawBackground(ctx, clock, glow);
  ctx.save();
  applyCamera(ctx, cam);
  if (glow && state.story >= LIGHT_START) {
    drawRipples(ctx, input.field, glow, smoothstep(LIGHT_START, PAIRS_END, state.story));
  }
  ctx.restore();

  // Everything that emits light goes on its own layer, which also feeds the bloom.
  const layers = layersFor(ctx.canvas);
  const lctx = layers.glow.getContext("2d") as CanvasRenderingContext2D;
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = "source-over";
  lctx.clearRect(0, 0, layers.glow.width, layers.glow.height);
  setLogicalTransform(lctx, SCENE_W);
  applyCamera(lctx, cam);
  lctx.globalCompositeOperation = "lighter";
  drawInflation(lctx, input.field, state.story, opts.gentle);
  const zoom = zoomOut(state.story);
  const tiles = tilesFor({ ...cam, s: cam.s * zoom });
  // Atoms shrink more slowly than the spacing between them, so they stay readable when zoomed out.
  const boost = zoom ** -0.55;
  // Keep about the same number of drawn photons on screen however far we zoom out.
  const photonShare = Math.min(1, zoom * zoom * 1.6);
  lctx.save();
  if (zoom < 1) {
    lctx.translate(SCENE_W / 2, SCENE_H / 2);
    lctx.scale(zoom, zoom);
    lctx.translate(-SCENE_W / 2, -SCENE_H / 2);
  }
  for (const t of tiles) {
    const base = t.i === 0 && t.j === 0;
    const view = base ? state : shiftedState(state, t.dx, t.dy);
    lctx.save();
    applyTile(lctx, t);
    drawPhotons(lctx, view, clock, photonShare);
    drawParticles(lctx, view, boost, (p) => traceFor(t, p, state.story));
    // Reaction strings and flashes only in the original box, so the copies do not flash in step.
    if (base) {
      drawReactionStrings(lctx, state);
      drawFx(lctx, state, opts, blast);
    }
    lctx.restore();
  }
  lctx.restore();
  lctx.globalCompositeOperation = "source-over";
  lctx.globalAlpha = 1;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layers.glow, 0, 0);
  drawBloom(ctx, layers, opts.gentle);
  setLogicalTransform(ctx, SCENE_W);
  // Matter–antimatter bursts light up the whole Universe for a moment.
  if (blast > 0) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(0.14, 0.012 * blast) * (opts.gentle ? 0.4 : 1);
    ctx.fillStyle = "rgb(255, 226, 190)";
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }
  drawVignette(ctx, SCENE_W, SCENE_H);
  if (!opts.gentle) {
    drawGrain(ctx, state.stepIndex, SCENE_W, SCENE_H);
  }

  if (opts.minimal) {
    drawCinemaClock(ctx, clock);
    return;
  }
  drawScrims(ctx, opts);
  if (opts.labels) {
    drawLabels(ctx, state, { ...cam, s: cam.s * zoomOut(state.story) });
  }
  if (opts.clock) {
    drawClock(ctx, clock);
  }
  const closing = CHAPTERS[clock.chapterIndex].id === "composition";
  if (closing && (opts.legend || opts.captions)) {
    drawComposition(ctx, clock, opts.clock);
  } else if (opts.legend) {
    drawLegend(ctx, counts, opts.clock);
  }
  if (opts.captions) {
    drawCaption(ctx, clock, input.settings, opts.timeline);
  }
  if (opts.timeline) {
    drawTimeline(ctx, clock);
  }
}

type Glow = { rgb: [number, number, number]; alpha: number };

/**
 * Colour and strength of the glow of the hot gas. Opaque plasma glows with the colour of its
 * temperature; after recombination the glow is the free-streaming afterglow, dimming as it cools
 * (brightness ∝ T⁴, softened here to stay visible).
 */
function plasmaGlow(clock: ClockState, counts: Census): Glow | null {
  if (clock.tempK === null) {
    return null;
  }
  const totalElectrons = counts.electrons + counts.positrons;
  const freeShare = totalElectrons > 0 ? (counts.freeElectrons + counts.positrons) / totalElectrons : 1;
  const rgb: [number, number, number] = clock.tempK > 40000 ? [205, 218, 255] : blackbodyColor(clock.tempK);
  const fog = 0.18 + 0.12 * freeShare;
  const dim = clock.tempK > 3000 ? 1 : (clock.tempK / 3000) ** 2.5;
  // Extra glow for the hottest eras, fading as the Universe cools from ~10²⁵ K toward ~10⁵ K.
  const heat = Math.max(0, Math.min(1, (Math.log10(clock.tempK) - 5) / 18));
  return { rgb, alpha: fog * dim + 0.22 * heat };
}

const RIPPLE_W = 192;
const RIPPLE_H = 108;
let rippleCache: { field: InflatonField; values: Float32Array } | null = null;
let rippleCanvas: HTMLCanvasElement | null = null;
let rippleSoft: HTMLCanvasElement | null = null;
let rippleImage: ImageData | null = null;

/**
 * The ripples frozen in at the end of inflation stay in the hot gas as slightly denser, brighter
 * patches; after recombination they are the hot and cold spots of the CMB. Drawn hugely
 * exaggerated (really about 1 part in 100,000).
 */
function drawRipples(ctx: CanvasRenderingContext2D, field: InflatonField, glow: Glow, fadeIn: number): void {
  if (!rippleCache || rippleCache.field !== field) {
    const zoom = finalFieldZoom(INFLATION_END_STORY);
    const values = new Float32Array(RIPPLE_W * RIPPLE_H);
    for (let j = 0; j < RIPPLE_H; j += 1) {
      for (let i = 0; i < RIPPLE_W; i += 1) {
        values[j * RIPPLE_W + i] = fieldValue(field, ((i + 0.5) / RIPPLE_W) * SCENE_W, ((j + 0.5) / RIPPLE_H) * SCENE_H, zoom);
      }
    }
    rippleCache = { field, values };
  }
  if (!rippleCanvas) {
    rippleCanvas = document.createElement("canvas");
    rippleCanvas.width = RIPPLE_W;
    rippleCanvas.height = RIPPLE_H;
  }
  const rctx = rippleCanvas.getContext("2d") as CanvasRenderingContext2D;
  if (!rippleImage) {
    rippleImage = rctx.createImageData(RIPPLE_W, RIPPLE_H);
  }
  const data = rippleImage.data;
  const [r, g, b] = glow.rgb;
  const values = rippleCache.values;
  for (let k = 0; k < values.length; k += 1) {
    data[k * 4] = r;
    data[k * 4 + 1] = g;
    data[k * 4 + 2] = b;
    data[k * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 0.5 + 0.8 * values[k])));
  }
  rctx.putImageData(rippleImage, 0, 0);
  // Soften at low resolution (cheap), then scale up.
  if (!rippleSoft) {
    rippleSoft = document.createElement("canvas");
    rippleSoft.width = RIPPLE_W;
    rippleSoft.height = RIPPLE_H;
  }
  const sctx = rippleSoft.getContext("2d") as CanvasRenderingContext2D;
  sctx.clearRect(0, 0, RIPPLE_W, RIPPLE_H);
  if (CAN_FILTER) {
    sctx.filter = "blur(1px)";
  }
  sctx.drawImage(rippleCanvas, 0, 0);
  sctx.filter = "none";
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = Math.min(1, glow.alpha * 0.45 * fadeIn);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(rippleSoft, 0, 0, SCENE_W, SCENE_H);
  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D, clock: ClockState, glow: Glow | null): void {
  ctx.fillStyle = "#04050a";
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  if (!glow) {
    return;
  }
  const [r, g, b] = glow.rgb;
  const grad = ctx.createRadialGradient(SCENE_W / 2, SCENE_H / 2, 80, SCENE_W / 2, SCENE_H / 2, SCENE_W * 0.7);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glow.alpha * 1.4})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${glow.alpha * 0.5})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);

  // Reheating: a soft flash as the field's energy becomes light.
  const flash = Math.max(0, 1 - Math.abs(clock.story - (LIGHT_START + 1.2)) / 2);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255, 246, 228, ${0.3 * flash * flash})`;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  }
}

const TAIL = 36;
const HEAD = 10;

/** Photons as streaks: a short bright head and a longer, fainter tail, batched by colour. */
function drawPhotons(ctx: CanvasRenderingContext2D, state: SimState, clock: ClockState, share = 1): void {
  const kT = clock.kTeV ?? 1;
  const heads: (Path2D | null)[] = new Array(PHOTON_BUCKETS).fill(null);
  const tails: (Path2D | null)[] = new Array(PHOTON_BUCKETS).fill(null);
  const odd: { head: Path2D; tail: Path2D; alpha: number; bucket: number }[] = [];
  for (const p of state.particles) {
    if (p.kind !== "photon" || p.dead || (share < 1 && ((p.id * 2654435761) % 1000) / 1000 >= share)) {
      continue;
    }
    const bucket = photonBucket(p.energyX * kT);
    const speed = Math.hypot(p.vx, p.vy) || 1;
    const ux = p.vx / speed;
    const uy = p.vy / speed;
    const grow = Math.min(1, (state.story - p.born) / 0.25);
    const fadeOut = p.fadeFrom > 0 ? Math.max(0, 1 - (state.story - p.fadeFrom) / 0.5) : 1;
    let head: Path2D;
    let tail: Path2D;
    if (fadeOut < 1 || grow < 1) {
      head = new Path2D();
      tail = new Path2D();
      odd.push({ head, tail, alpha: fadeOut * grow, bucket });
    } else {
      head = heads[bucket] ?? new Path2D();
      tail = tails[bucket] ?? new Path2D();
      heads[bucket] = head;
      tails[bucket] = tail;
    }
    tail.moveTo(p.x, p.y);
    tail.lineTo(p.x - ux * TAIL * grow, p.y - uy * TAIL * grow);
    head.moveTo(p.x, p.y);
    head.lineTo(p.x - ux * HEAD * grow, p.y - uy * HEAD * grow);
  }
  ctx.lineCap = "round";
  const stroke = (path: Path2D, bucket: number, alpha: number, isHead: boolean): void => {
    const style = photonStyle(bucketEnergy(bucket));
    ctx.strokeStyle = style.color;
    ctx.lineWidth = isHead ? 2.4 : 1.3;
    ctx.globalAlpha = style.alpha * alpha * (isHead ? 1 : 0.4);
    ctx.stroke(path);
  };
  for (let b = 0; b < PHOTON_BUCKETS; b += 1) {
    const tail = tails[b];
    const head = heads[b];
    if (tail && head) {
      stroke(tail, b, 1, false);
      stroke(head, b, 1, true);
    }
  }
  for (const o of odd) {
    stroke(o.tail, o.bucket, o.alpha, false);
    stroke(o.head, o.bucket, o.alpha, true);
  }
}

function byIdMap(state: SimState): Map<number, Particle> {
  return new Map(state.particles.map((p) => [p.id, p]));
}

/**
 * Matter and antimatter closing in: a glowing tether between them and energy building up at the
 * point where they will meet. Quark pairs are too many and too quick to dress up.
 */
function drawAnnihilationApproach(ctx: CanvasRenderingContext2D, r: Reaction, byId: Map<number, Particle>, story: number): void {
  const a = byId.get(r.members[0]);
  const b = byId.get(r.members[1]);
  if (!a || !b || a.kind === "quark" || Math.abs(a.x - b.x) > SCENE_W / 2 || Math.abs(a.y - b.y) > SCENE_H / 2) {
    return;
  }
  const big = a.kind === "nucleon";
  const f = reactionProgress(r, story);
  const color = big ? "#ffe2b8" : "#d6f0ff";
  ctx.strokeStyle = color;
  ctx.lineWidth = big ? 2.4 : 1.6;
  ctx.globalAlpha = (0.2 + 0.7 * f) * (0.75 + 0.25 * Math.sin(story * 40));
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  drawGlow(ctx, color, (a.x + b.x) / 2, (a.y + b.y) / 2, (big ? 14 : 8) + (big ? 34 : 16) * f * f, 0.25 + 0.6 * f * f, 0.35);
}

/** Gluon "strings" pulling quarks together during confinement. */
function drawReactionStrings(ctx: CanvasRenderingContext2D, state: SimState): void {
  const byId = byIdMap(state);
  ctx.lineWidth = 2;
  for (const r of state.reactions) {
    if (r.kind === "annihilate") {
      drawAnnihilationApproach(ctx, r, byId, state.story);
      continue;
    }
    if (r.kind !== "bindBaryon" && r.kind !== "bindMeson") {
      continue;
    }
    const members = r.members.map((id) => byId.get(id)).filter((p): p is Particle => p !== undefined);
    const f = reactionProgress(r, state.story);
    ctx.globalAlpha = 0.25 + 0.5 * f;
    ctx.strokeStyle = r.kind === "bindBaryon" ? "#fff0cf" : "#e8dcff";
    ctx.beginPath();
    for (let i = 0; i < members.length; i += 1) {
      const a = members[i];
      const b = members[(i + 1) % members.length];
      if (members.length === 2 && i === 1) {
        break;
      }
      // Skip a string that would cross a periodic edge.
      if (Math.abs(a.x - b.x) > SCENE_W / 2 || Math.abs(a.y - b.y) > SCENE_H / 2) {
        continue;
      }
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
}

function nucleonColor(neutron: boolean): string {
  return neutron ? NEUTRON_COLOR : PROTON_COLOR;
}

/** Three colour charges inside a nucleon, slowly circling. */
function innerQuarks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  phase: number,
  colors: string[],
  alpha: number,
  orbit: number,
  size: number
): void {
  if (alpha <= 0.02) {
    return;
  }
  for (let i = 0; i < 3; i += 1) {
    const a = phase + (i * 2 * Math.PI) / 3;
    drawGlow(ctx, colors[i], x + Math.cos(a) * orbit, y + Math.sin(a) * orbit, size, alpha, 0.5);
  }
}

type Ball = { x: number; y: number; z: number; neutron: boolean };

/** Nucleons in a nucleus, rotated in 3D and drawn back to front with a little perspective. */
function drawNucleus(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  members: Ball[],
  spinA: number,
  spinB: number,
  alpha: number
): void {
  const ca = Math.cos(spinA);
  const sa = Math.sin(spinA);
  const cb = Math.cos(spinB);
  const sb = Math.sin(spinB);
  const placed = members.map((m) => {
    // Rotate about the vertical axis, then about the horizontal one.
    const x1 = m.x * ca + m.z * sa;
    const z1 = -m.x * sa + m.z * ca;
    const y2 = m.y * cb - z1 * sb;
    const z2 = m.y * sb + z1 * cb;
    return { x: x1, y: y2, z: z2, neutron: m.neutron };
  });
  placed.sort((a, b) => a.z - b.z);
  for (const m of placed) {
    const depth = 1 + 0.12 * m.z;
    drawSphere(ctx, nucleonColor(m.neutron), x + m.x * r, y + m.y * r, r * depth, alpha * (0.82 + 0.18 * (m.z + 1) * 0.5));
  }
}

const DEUTERON: Ball[] = [
  { x: -0.82, y: 0, z: 0, neutron: false },
  { x: 0.82, y: 0, z: 0, neutron: true }
];
const TETRA = 0.95 / Math.sqrt(3);
const HELIUM4: Ball[] = [
  { x: TETRA, y: TETRA, z: TETRA, neutron: false },
  { x: TETRA, y: -TETRA, z: -TETRA, neutron: true },
  { x: -TETRA, y: TETRA, z: -TETRA, neutron: false },
  { x: -TETRA, y: -TETRA, z: TETRA, neutron: true }
];

type Orbit = { rx: number; ry: number; tilt: number; theta: number };

function electronOrbit(p: Particle, e: number, story: number, radius: number): Orbit {
  return {
    rx: radius * (1 + 0.18 * e),
    ry: radius * (1 + 0.18 * e) * (0.5 + 0.2 * Math.sin(p.id * 0.7 + e * 2.1)),
    tilt: p.id * 1.3 + e * 1.9,
    theta: story * (2.1 + 0.35 * e) + p.id + e * Math.PI
  };
}

function orbitPoint(o: Orbit, theta: number): [number, number, number] {
  const ex = Math.cos(theta) * o.rx;
  const ey = Math.sin(theta) * o.ry;
  const c = Math.cos(o.tilt);
  const s = Math.sin(o.tilt);
  return [ex * c - ey * s, ex * s + ey * c, Math.sin(theta)];
}

/**
 * Bound electrons on tilted orbits around a nucleus. The back half is drawn before the nucleus,
 * the front half (with a short trail) after it, which gives the atom some depth.
 */
function drawElectronShell(ctx: CanvasRenderingContext2D, p: Particle, story: number, radius: number, alpha: number, front: boolean): void {
  for (let e = 0; e < p.electrons; e += 1) {
    const o = electronOrbit(p, e, story, radius);
    if (!front) {
      drawGlow(ctx, ELECTRON_COLOR, p.x, p.y, o.rx * 1.3, alpha * 0.12, 0.6);
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = ORBIT_COLOR;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, o.rx, o.ry, o.tilt, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let k = 6; k >= 0; k -= 1) {
      const [dx, dy, z] = orbitPoint(o, o.theta - k * 0.13);
      if (z >= 0 !== front) {
        continue;
      }
      const fade = 1 - k / 7;
      const depth = 0.8 + 0.2 * (z + 1) * 0.5;
      drawGlow(ctx, ELECTRON_COLOR, p.x + dx, p.y + dy, (k === 0 ? 7 : 4.2) * R * depth, alpha * fade * (k === 0 ? 1 : 0.45), 0.45);
    }
  }
}

const HELIUM3: Ball[] = [
  { x: 0, y: -0.9, z: 0.2, neutron: false },
  { x: -0.8, y: 0.45, z: -0.2, neutron: false },
  { x: 0.8, y: 0.45, z: 0.1, neutron: true }
];
const LITHIUM7: Ball[] = [
  { x: 0, y: 0, z: 0.9, neutron: true },
  { x: 0.95, y: 0, z: 0, neutron: false },
  { x: -0.95, y: 0, z: 0, neutron: true },
  { x: 0.48, y: 0.82, z: -0.3, neutron: false },
  { x: -0.48, y: 0.82, z: 0.3, neutron: true },
  { x: 0.48, y: -0.82, z: 0.3, neutron: true },
  { x: -0.48, y: -0.82, z: -0.3, neutron: false }
];
const TRACE_COLOR: Record<Exclude<Trace, null>, string> = {
  deuterium: "#ffd9a8",
  helium3: "#fff0b8",
  lithium: "#ff9ec4"
};

function drawParticles(
  ctx: CanvasRenderingContext2D,
  state: SimState,
  boost = 1,
  trace: (p: Particle) => Trace = () => null
): void {
  const story = state.story;
  const s = compositeScale(story);
  const nucleonR = 6.5 * s;
  // Inner quarks matter while quarks are the story; they fade once nuclei take over.
  const quarkVis = 1 - smoothstep(NUCLEI_START - 8, NUCLEI_START - 2, story);
  for (const p of state.particles) {
    if (p.dead || p.kind === "photon") {
      continue;
    }
    const alpha = Math.min(1, (story - p.born) / 0.3);
    const phase = story * 1.3 + p.id * 0.9;
    const spinA = story * 0.7 + p.id;
    const spinB = story * 0.45 + p.id * 0.7;
    const scaled = boost !== 1;
    if (scaled) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(boost, boost);
      ctx.translate(-p.x, -p.y);
    }
    const rare = trace(p);
    if (rare) {
      // A rare atom stands in for this one in a copy of the box (with the same electrons).
      const stand = { ...p, electrons: rare === "lithium" ? p.electrons * 3 : rare === "deuterium" ? p.electrons : Math.min(2, p.electrons) };
      const balls = rare === "deuterium" ? DEUTERON : rare === "helium3" ? HELIUM3 : LITHIUM7;
      const orbit = (rare === "lithium" ? 30 : rare === "helium3" ? 26 : 24) * s;
      drawElectronShell(ctx, stand, story, orbit, alpha, false);
      drawGlow(ctx, TRACE_COLOR[rare], p.x, p.y, nucleonR * 4, alpha * 0.4, 0.4);
      drawNucleus(ctx, p.x, p.y, nucleonR * (rare === "lithium" ? 1.15 : 1), balls, spinA, spinB, alpha);
      drawElectronShell(ctx, stand, story, orbit, alpha, true);
      if (scaled) {
        ctx.restore();
      }
      continue;
    }
    switch (p.kind) {
      case "quark":
        drawGlow(ctx, QUARK_COLORS[p.color], p.x, p.y, 8 * R, alpha * 0.95);
        break;
      case "antiquark":
        drawAnti(ctx, p.x, p.y, 4.8 * R, alpha, 2);
        break;
      case "electron":
        drawGlow(ctx, ELECTRON_COLOR, p.x, p.y, 5.5 * R, alpha * 0.9, 0.45);
        break;
      case "positron":
        drawAnti(ctx, p.x, p.y, 4 * R, alpha, 1.8);
        break;
      case "meson": {
        const a = phase * 2;
        const d = 3 * R;
        drawGlow(ctx, QUARK_COLORS[p.color], p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 5 * R, alpha);
        ring(ctx, ANTI, p.x - Math.cos(a) * d, p.y - Math.sin(a) * d, 3 * R, alpha, 1.6);
        break;
      }
      case "nucleon": {
        const orbit = 22 * s;
        drawElectronShell(ctx, p, story, orbit, alpha, false);
        drawGlow(ctx, nucleonColor(p.neutron), p.x, p.y, nucleonR * 2.6, alpha * 0.3, 0.5);
        drawSphere(ctx, nucleonColor(p.neutron), p.x, p.y, nucleonR, alpha);
        innerQuarks(ctx, p.x, p.y, phase, QUARK_COLORS, alpha * 0.85 * quarkVis, nucleonR * 0.45, nucleonR * 0.5);
        drawElectronShell(ctx, p, story, orbit, alpha, true);
        break;
      }
      case "antinucleon":
        drawAnti(ctx, p.x, p.y, nucleonR * 1.15, alpha, 2.6);
        innerQuarks(ctx, p.x, p.y, phase, [ANTI, ANTI, ANTI], alpha * 0.7, nucleonR * 0.6, nucleonR * 0.35);
        break;
      case "deuteron": {
        const orbit = 24 * s;
        drawElectronShell(ctx, p, story, orbit, alpha, false);
        drawGlow(ctx, PROTON_COLOR, p.x, p.y, nucleonR * 3, alpha * 0.3, 0.5);
        drawNucleus(ctx, p.x, p.y, nucleonR, DEUTERON, spinA, spinB, alpha);
        drawElectronShell(ctx, p, story, orbit, alpha, true);
        break;
      }
      case "helium": {
        const orbit = 26 * s;
        drawElectronShell(ctx, p, story, orbit, alpha, false);
        drawGlow(ctx, HELIUM_COLOR, p.x, p.y, nucleonR * 3.6, alpha * 0.28, 0.4);
        drawNucleus(ctx, p.x, p.y, nucleonR * 1.15, HELIUM4, spinA, spinB, alpha);
        drawElectronShell(ctx, p, story, orbit, alpha, true);
        break;
      }
    }
    if (scaled) {
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

function drawFx(ctx: CanvasRenderingContext2D, state: SimState, opts: SceneOptions, blast: number): void {
  const base = opts.gentle ? 0.45 : 1;
  // When many big annihilations overlap, each one is dimmed so the frame never washes out.
  const crowd = 1 / Math.sqrt(1 + blast / 4);
  for (const f of state.fx) {
    const t = (state.story - f.start) / f.duration;
    if (t < 0 || t > 1) {
      continue;
    }
    const intensity = f.size >= 30 ? base * crowd : base;
    switch (f.kind) {
      case "flash":
        drawGlow(ctx, f.color, f.x, f.y, f.size * (0.6 + 1.4 * t), (1 - t) ** 1.5 * intensity, 0.3);
        if (f.size >= 20) {
          drawStarburst(ctx, f, t, intensity);
        }
        break;
      case "ring":
        ring(ctx, f.color, f.x, f.y, f.size * (0.3 + t), (1 - t) * 0.9 * intensity, 2);
        break;
      case "spark":
        drawGlow(ctx, f.color, f.x, f.y, f.size * (1 - 0.5 * t), (1 - t) * 0.8 * intensity, 0.3);
        break;
      case "hit": {
        const a = f.angle ?? 0;
        const reach = 70 * (1 - Math.min(1, t * 2.2));
        if (t < 0.45) {
          ctx.globalAlpha = 0.8 * intensity;
          ctx.strokeStyle = f.color;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(f.x + Math.cos(a) * (reach + 24), f.y + Math.sin(a) * (reach + 24));
          ctx.lineTo(f.x + Math.cos(a) * reach, f.y + Math.sin(a) * reach);
          ctx.stroke();
        } else {
          drawGlow(ctx, f.color, f.x, f.y, f.size * 1.8, (1 - t) * 1.6 * intensity, 0.3);
        }
        break;
      }
      case "burst":
        drawBurst(ctx, f, t, intensity);
        break;
      case "label":
        break;
    }
  }
}

/** Radial shards of light flying out of an annihilation. Angles come from the position, so replays match. */
function drawBurst(ctx: CanvasRenderingContext2D, f: Fx, t: number, intensity: number): void {
  const shards = 11;
  const seed = Math.sin(f.x * 12.9898 + f.y * 78.233) * 43758.5453;
  const base = (seed - Math.floor(seed)) * Math.PI * 2;
  const ease = 1 - (1 - t) ** 2.2;
  ctx.strokeStyle = f.color;
  ctx.lineCap = "round";
  for (let i = 0; i < shards; i += 1) {
    const jitter = Math.sin(seed + i * 3.7);
    const a = base + (i * 2 * Math.PI) / shards + 0.2 * jitter;
    const reach = f.size * (0.8 + 0.35 * jitter);
    const outer = reach * (0.25 + 0.75 * ease);
    const inner = outer * (0.35 + 0.5 * t);
    ctx.globalAlpha = (1 - t) ** 1.4 * 0.85 * intensity;
    ctx.lineWidth = 2.6 * (1 - t) + 0.6;
    ctx.beginPath();
    ctx.moveTo(f.x + Math.cos(a) * inner, f.y + Math.sin(a) * inner);
    ctx.lineTo(f.x + Math.cos(a) * outer, f.y + Math.sin(a) * outer);
    ctx.stroke();
  }
}

/** Thin lens-flare spikes on the biggest flashes (matter–antimatter annihilations). */
function drawStarburst(ctx: CanvasRenderingContext2D, f: Fx, t: number, intensity: number): void {
  const long = f.size * 3.4 * (1 - t);
  const short = long * 0.45;
  ctx.strokeStyle = f.color;
  ctx.lineWidth = 1.4;
  ctx.globalAlpha = (1 - t) ** 1.2 * 0.75 * intensity;
  ctx.beginPath();
  ctx.moveTo(f.x - long, f.y);
  ctx.lineTo(f.x + long, f.y);
  ctx.moveTo(f.x, f.y - long);
  ctx.lineTo(f.x, f.y + long);
  ctx.stroke();
  ctx.globalAlpha *= 0.5;
  ctx.beginPath();
  ctx.moveTo(f.x - short, f.y - short);
  ctx.lineTo(f.x + short, f.y + short);
  ctx.moveTo(f.x - short, f.y + short);
  ctx.lineTo(f.x + short, f.y - short);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLabels(ctx: CanvasRenderingContext2D, state: SimState, cam: Camera): void {
  ctx.font = `500 22px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const f of state.fx) {
    if (f.kind !== "label" || !f.text) {
      continue;
    }
    const t = (state.story - f.start) / f.duration;
    if (t < 0 || t > 1) {
      continue;
    }
    const alpha = Math.min(1, t * 6, (1 - t) * 4);
    const w = ctx.measureText(f.text).width + 24;
    const [sx, sy] = toScreen(cam, f.x, f.y);
    const x = Math.min(SCENE_W - w / 2 - 20, Math.max(w / 2 + 20, sx));
    const y = Math.max(40, sy - 46);
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = "rgba(6, 8, 16, 1)";
    roundRect(ctx, x - w / 2, y - 18, w, 36, 10);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TEXT;
    ctx.fillText(f.text, x, y + 1);
  }
  ctx.globalAlpha = 1;
}

// ---------- HUD ----------

/** Soft dark vignettes behind the text corners, so captions stay readable over bright plasma. */
function drawScrims(ctx: CanvasRenderingContext2D, opts: SceneOptions): void {
  const corner = (x: number, y: number, radius: number, alpha: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(3, 4, 9, ${alpha})`);
    g.addColorStop(0.55, `rgba(3, 4, 9, ${alpha * 0.6})`);
    g.addColorStop(1, "rgba(3, 4, 9, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  };
  ctx.globalAlpha = 1;
  if (opts.clock || opts.legend) {
    corner(SCENE_W, 0, opts.legend ? 820 : 620, 0.62);
  }
  if (opts.captions) {
    corner(0, SCENE_H, 1250, 0.7);
  }
}

function textShadow(ctx: CanvasRenderingContext2D, on: boolean): void {
  ctx.shadowColor = on ? "rgba(0, 0, 0, 0.8)" : "transparent";
  ctx.shadowBlur = on ? 10 : 0;
}

function drawClock(ctx: CanvasRenderingContext2D, clock: ClockState): void {
  const x = SCENE_W - 48;
  let y = 64;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  textShadow(ctx, true);
  ctx.fillStyle = TEXT;
  ctx.font = `600 44px ${FONT}`;
  ctx.fillText(`t ≈ ${formatCosmicTime(clock.tSec)}`, x, y);
  y += 42;
  ctx.font = `400 28px ${FONT}`;
  if (clock.tempK !== null && clock.story < LIGHT_START) {
    // Inflation is over but the energy has not become a hot gas yet: no temperature to quote.
    ctx.fillText("no temperature yet", x, y);
    y += 34;
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText("energy still held in the field", x, y);
  } else if (clock.tempK === null || clock.kTeV === null) {
    const efolds = clock.efolds ?? 0;
    // e^N expressed as a power of ten.
    const growth = Math.floor(efolds / Math.LN10);
    ctx.fillText(growth > 0 ? `size grown × 10${superscript(growth)}` : "size × 1", x, y);
    y += 34;
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(`${Math.round(efolds)} of ≥ ${INFLATION_EFOLDS} e-folds · energy held in the inflaton field`, x, y);
  } else {
    ctx.fillText(`T ≈ ${formatTemperature(clock.tempK)}`, x, y);
    y += 34;
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(`typical particle energy kT ≈ ${formatEnergy(clock.kTeV)}`, x, y);
  }
  if (clock.modelDependent) {
    y += 28;
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `italic 400 19px ${FONT}`;
    ctx.fillText("values this early depend on the inflation model", x, y);
  }
  textShadow(ctx, false);
}

/** Cinematic mode: just time and temperature, top right, over a faint scrim. */
function drawCinemaClock(ctx: CanvasRenderingContext2D, clock: ClockState): void {
  const g = ctx.createRadialGradient(SCENE_W, 0, 0, SCENE_W, 0, 560);
  g.addColorStop(0, "rgba(3, 4, 9, 0.5)");
  g.addColorStop(1, "rgba(3, 4, 9, 0)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);
  const x = SCENE_W - 56;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  textShadow(ctx, true);
  ctx.fillStyle = TEXT;
  ctx.font = `600 46px ${FONT}`;
  ctx.fillText(`t ≈ ${formatCosmicTime(clock.tSec)}`, x, 72);
  if (clock.tempK !== null && clock.story >= LIGHT_START) {
    ctx.font = `400 32px ${FONT}`;
    ctx.fillStyle = "rgba(236, 233, 224, 0.88)";
    ctx.fillText(`T ≈ ${formatTemperature(clock.tempK)}`, x, 116);
  }
  textShadow(ctx, false);
}

/**
 * Closing card: what ordinary matter came out of the first minutes. Abundances are the standard
 * primordial values (Y ≈ 0.25; D/H ≈ 2.5 × 10⁻⁵; ³He/H ≈ 10⁻⁵; ⁷Li/H ≈ 5 × 10⁻¹⁰).
 */
function drawComposition(ctx: CanvasRenderingContext2D, clock: ClockState, belowClock: boolean): void {
  const chapter = CHAPTERS[clock.chapterIndex];
  const alpha = Math.min(1, (clock.story - chapter.start) / 1.2);
  if (alpha <= 0) {
    return;
  }
  const right = SCENE_W - 48;
  const width = 560;
  const left = right - width;
  let y = belowClock ? 228 : 72;
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = "rgba(6, 8, 16, 1)";
  roundRect(ctx, left - 18, y - 40, width + 36, 410, 16);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = TEXT;
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText("Ordinary matter, after the first minutes", left, y);
  y += 22;
  type Row = { icon: (x: number, y: number) => void; name: string; value: string; muted?: boolean };
  const rows: Row[] = [
    {
      icon: (x, yy) => drawSphere(ctx, PROTON_COLOR, x, yy, 9, alpha),
      name: "Hydrogen",
      value: "75% of the mass · 92% of atoms"
    },
    {
      icon: (x, yy) => drawNucleus(ctx, x, yy, 7.5, HELIUM4, 0.6, 0.5, alpha),
      name: "Helium-4",
      value: "25% of the mass · 8% of atoms"
    },
    {
      icon: (x, yy) => drawNucleus(ctx, x, yy, 7.5, DEUTERON, 0.3, 0.2, alpha),
      name: "Deuterium",
      value: "1 per 40,000 hydrogen atoms",
      muted: true
    },
    {
      icon: (x, yy) => drawNucleus(ctx, x, yy, 7, HELIUM3, 0.4, 0.3, alpha),
      name: "Helium-3",
      value: "1 per 100,000 hydrogen atoms",
      muted: true
    },
    {
      icon: (x, yy) => drawNucleus(ctx, x, yy, 6, LITHIUM7, 0.5, 0.4, alpha),
      name: "Lithium-7",
      value: "1 per 2 billion hydrogen atoms",
      muted: true
    }
  ];
  for (const row of rows) {
    y += 46;
    ctx.globalCompositeOperation = "lighter";
    row.icon(left + 14, y - 8);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = row.muted ? TEXT_MUTED : TEXT;
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText(row.name, left + 44, y);
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText(row.value, left + 184, y);
  }
  y += 44;
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `italic 400 18px ${FONT}`;
  ctx.fillText("Rare atoms are drawn far more often than they occur.", left, y);
  y += 26;
  ctx.fillText("Not shown: dark matter (about 5× more mass), which", left, y);
  y += 24;
  ctx.fillText("does not shine.", left, y);
  ctx.globalAlpha = 1;
}

type LegendItem = { label: string; draw: (x: number, y: number) => void };

function drawLegend(ctx: CanvasRenderingContext2D, c: Census, belowClock: boolean): void {
  const items: LegendItem[] = [];
  const add = (show: boolean, label: string, draw: (x: number, y: number) => void): void => {
    if (show) {
      items.push({ label, draw });
    }
  };
  ctx.globalCompositeOperation = "lighter";
  add(c.photons > 0, "light (photon)", (x, y) => {
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = "rgb(222, 232, 255)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x + 11, y);
    ctx.stroke();
  });
  add(c.quarks > 0, "quark (3 colour charges)", (x, y) => {
    QUARK_COLORS.forEach((col, i) => drawGlow(ctx, col, x - 9 + i * 9, y, 7, 0.95));
  });
  add(c.antiquarks > 0, "antiquark (antimatter: hollow, magenta)", (x, y) => {
    drawAnti(ctx, x, y, 6, 1, 1.8);
  });
  add(c.mesons > 0, "meson (quark + antiquark)", (x, y) => {
    drawGlow(ctx, QUARK_COLORS[0], x - 4, y, 6, 1);
    ring(ctx, ANTI, x + 4, y, 3.5, 1, 1.5);
  });
  add(c.protons > 0, "proton", (x, y) => {
    drawSphere(ctx, PROTON_COLOR, x, y, 9, 1);
  });
  add(c.neutrons > 0, "neutron", (x, y) => {
    drawSphere(ctx, NEUTRON_COLOR, x, y, 9, 1);
  });
  add(c.antiprotons + c.antineutrons > 0, "antiproton / antineutron", (x, y) => {
    drawAnti(ctx, x, y, 10, 1, 2.2);
  });
  add(c.freeElectrons > 0, "electron", (x, y) => {
    drawGlow(ctx, ELECTRON_COLOR, x, y, 5, 0.9, 0.45);
  });
  add(c.positrons > 0, "positron (anti-electron)", (x, y) => {
    drawAnti(ctx, x, y, 5, 1, 1.6);
  });
  add(c.deuterons > 0, "deuterium (p + n)", (x, y) => {
    drawNucleus(ctx, x, y, 8, DEUTERON, 0.3, 0.2, 1);
  });
  add(c.helium > 0, "helium-4 (2p + 2n)", (x, y) => {
    drawNucleus(ctx, x, y, 8, HELIUM4, 0.6, 0.5, 1);
  });
  add(c.hydrogenAtoms + c.heliumAtoms > 0, "atom (electron bound)", (x, y) => {
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = ORBIT_COLOR;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.ellipse(x, y, 16, 6, -0.4, 0, Math.PI * 2);
    ctx.stroke();
    drawSphere(ctx, PROTON_COLOR, x, y, 7, 1);
    drawGlow(ctx, ELECTRON_COLOR, x + 14, y - 6, 8, 1, 0.45);
  });

  const x = SCENE_W - 48;
  let y = belowClock ? 220 : 64;
  ctx.font = `400 21px ${FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const item of items) {
    ctx.globalCompositeOperation = "lighter";
    item.draw(x - ctx.measureText(item.label).width - 28, y);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    textShadow(ctx, true);
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText(item.label, x, y);
    textShadow(ctx, false);
    y += 42;
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

const EXCESS_SHOWN: Record<number, string> = { 2: "3 : 2", 4: "5 : 4", 8: "9 : 8" };

function drawCaption(ctx: CanvasRenderingContext2D, clock: ClockState, settings: SimSettings, aboveTimeline: boolean): void {
  const chapter = CHAPTERS[clock.chapterIndex];
  const into = clock.story - chapter.start;
  const left = chapter.end - clock.story;
  const isLast = clock.chapterIndex === CHAPTERS.length - 1;
  const alpha = Math.max(0, Math.min(1, into / 0.8, isLast ? 1 : left / 0.5));
  if (alpha <= 0) {
    return;
  }
  const x = 64;
  const lineGap = 33;
  const footnote =
    chapter.id === "matter" || chapter.id === "plasma" || chapter.id === "confinement" || chapter.id === "annihilation"
      ? `Matter excess exaggerated: shown ${EXCESS_SHOWN[settings.excess]}; real ≈ 1,000,000,001 : 1,000,000,000.`
      : null;
  // Stack upward from the bottom margin so any number of lines fits.
  let y = SCENE_H - (aboveTimeline ? 96 : 52);
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  textShadow(ctx, true);
  if (footnote) {
    ctx.fillStyle = TEXT_MUTED;
    ctx.font = `italic 400 19px ${FONT}`;
    ctx.fillText(footnote, x, y);
    y -= lineGap + 2;
  }
  ctx.font = `400 25px ${FONT}`;
  ctx.fillStyle = "rgba(236, 233, 224, 0.9)";
  for (let i = chapter.caption.length - 1; i >= 0; i -= 1) {
    ctx.fillText(chapter.caption[i], x, y);
    y -= lineGap;
  }
  y -= 12;
  ctx.fillStyle = TEXT;
  ctx.font = `650 50px ${FONT}`;
  ctx.fillText(chapter.title, x, y);
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(`CHAPTER ${clock.chapterIndex + 1} OF ${CHAPTERS.length}`, x, y - 52);
  textShadow(ctx, false);
  ctx.globalAlpha = 1;
}

function drawTimeline(ctx: CanvasRenderingContext2D, clock: ClockState): void {
  const x0 = 64;
  const x1 = SCENE_W - 64;
  const y = SCENE_H - 34;
  const toX = (s: number): number => x0 + ((x1 - x0) * s) / STORY_DURATION;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(toX(clock.story), y);
  ctx.stroke();
  ctx.font = `500 15px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  CHAPTERS.forEach((c, i) => {
    const cx = toX(c.start);
    ctx.fillStyle = i <= clock.chapterIndex ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.3)";
    ctx.fillRect(cx - 1, y - 7, 2, 14);
    ctx.fillStyle = i === clock.chapterIndex ? TEXT : TEXT_MUTED;
    ctx.fillText(c.short, cx + 6, y - 10);
  });
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(toX(clock.story), y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// ---------- Photon-energy inset ----------

export const SPECTRUM_W = 300;
export const SPECTRUM_H = 176;
const X_MIN = 0.05;
const X_MAX = 60;
const BINS = 28;

type Threshold = { label: string; energyEV: number };

function thresholdsFor(chapterIndex: number): Threshold[] {
  const id = CHAPTERS[chapterIndex].id;
  if (id === "confinement" || id === "annihilation") {
    return [
      { label: "makes p + p̄", energyEV: 2 * NUCLEON_MASS_EV },
      { label: "makes e⁻ + e⁺", energyEV: 2 * ELECTRON_MASS_EV }
    ];
  }
  if (id === "nuclei") {
    return [
      { label: "makes e⁻ + e⁺", energyEV: 2 * ELECTRON_MASS_EV },
      { label: "splits deuterium", energyEV: DEUTERON_BINDING_EV }
    ];
  }
  if (id === "atoms" || id === "afterglow" || id === "composition") {
    return [{ label: "ionises hydrogen", energyEV: HYDROGEN_BINDING_EV }];
  }
  return [];
}

/**
 * Histogram of drawn photon energies in units of kT (log axis), with the blackbody curve and the
 * energies needed for key reactions. As the Universe cools, the thresholds slide into the tail.
 */
export function renderSpectrum(ctx: CanvasRenderingContext2D, state: SimState): void {
  setLogicalTransform(ctx, SPECTRUM_W);
  ctx.clearRect(0, 0, SPECTRUM_W, SPECTRUM_H);
  const clock = clockAt(state.story);
  const left = 10;
  const right = SPECTRUM_W - 10;
  const top = 30;
  const bottom = SPECTRUM_H - 30;
  const lx0 = Math.log10(X_MIN);
  const lx1 = Math.log10(X_MAX);
  const toX = (x: number): number => left + ((Math.log10(x) - lx0) / (lx1 - lx0)) * (right - left);

  ctx.fillStyle = TEXT;
  ctx.font = `600 12px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Photon energies", left, 16);
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `400 11px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(clock.kTeV ? `kT ≈ ${formatEnergy(clock.kTeV)}` : "", right, 16);

  if (clock.kTeV === null) {
    ctx.textAlign = "center";
    ctx.fillText("No particles yet: the energy is in the field.", SPECTRUM_W / 2, (top + bottom) / 2);
    return;
  }
  const kT = clock.kTeV;

  const counts = new Array(BINS).fill(0);
  let total = 0;
  for (const p of state.particles) {
    if (p.kind !== "photon" || p.dead || p.fadeFrom > 0) {
      continue;
    }
    const f = (Math.log10(Math.max(p.energyX, 1e-9)) - lx0) / (lx1 - lx0);
    if (f >= 0 && f < 1) {
      counts[Math.floor(f * BINS)] += 1;
    }
    total += 1;
  }
  // Blackbody photons per log-energy bin ∝ x³/(eˣ − 1).
  const expected = (x: number): number => (x ** 3 / Math.expm1(x)) * Math.LN10 * ((lx1 - lx0) / BINS) / 2.404;
  let peak = 1;
  for (let i = 0; i < BINS; i += 1) {
    const x = 10 ** (lx0 + ((i + 0.5) / BINS) * (lx1 - lx0));
    peak = Math.max(peak, counts[i], expected(x) * total);
  }
  const yOf = (n: number): number => bottom - (n / peak) * (bottom - top);

  const bw = (right - left) / BINS;
  ctx.fillStyle = "rgba(170, 196, 255, 0.75)";
  for (let i = 0; i < BINS; i += 1) {
    if (counts[i] === 0) {
      continue;
    }
    const x = left + i * bw + 1;
    const h = bottom - yOf(counts[i]);
    ctx.fillRect(x, bottom - h, bw - 2, h);
  }
  ctx.strokeStyle = TEXT;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= 80; i += 1) {
    const x = 10 ** (lx0 + (i / 80) * (lx1 - lx0));
    const px = toX(x);
    const py = yOf(expected(x) * total);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.beginPath();
  ctx.moveTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  ctx.fillStyle = TEXT_MUTED;
  ctx.font = `400 10px ${FONT}`;
  ctx.textAlign = "center";
  for (const tick of [0.1, 1, 10]) {
    ctx.fillText(`${tick} kT`, toX(tick), bottom + 12);
  }

  // Reaction thresholds.
  ctx.font = `400 10.5px ${FONT}`;
  thresholdsFor(clock.chapterIndex).forEach((th, i) => {
    const x = th.energyEV / kT;
    const share = log10PlanckTail(x);
    const shareText =
      share > -0.3 ? "most photons" : share > -2 ? `${Math.round(10 ** share * 100)}% of photons` : `1 in 10${superscript(Math.round(-share))}`;
    const rowY = top + 4 + i * 26;
    ctx.textAlign = "left";
    if (x <= X_MAX) {
      const px = toX(Math.max(X_MIN, x));
      ctx.strokeStyle = "rgba(255, 214, 140, 0.85)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, top - 4);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const labelRight = px > SPECTRUM_W * 0.6;
      ctx.textAlign = labelRight ? "right" : "left";
      ctx.fillStyle = TEXT;
      ctx.fillText(th.label, px + (labelRight ? -4 : 4), rowY);
      ctx.fillStyle = TEXT_MUTED;
      ctx.fillText(shareText, px + (labelRight ? -4 : 4), rowY + 12);
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = TEXT;
      ctx.fillText(`${th.label} → at ${formatScientific(x, 2)} kT`, right, rowY);
      ctx.fillStyle = TEXT_MUTED;
      ctx.fillText(shareText, right, rowY + 12);
    }
  });
  if (thresholdsFor(clock.chapterIndex).length === 0) {
    ctx.textAlign = "right";
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText("all photons can make light-quark pairs", right, top + 4);
  }
}
