import { CHAPTERS, clockAt, INFLATION_END_STORY, STORY_DURATION, WEAK_FREEZE_TIME_S } from "./clock";
import { createInflatonField, fieldValue, finalFieldZoom, InflatonField } from "./field";
import {
  CONFINEMENT_KT_EV,
  deuteriumSahaK,
  ELECTRON_MASS_EV,
  HELIUM_I_BINDING_EV,
  HELIUM_II_BINDING_EV,
  HYDROGEN_BINDING_EV,
  LIGHT_QUARK_MASS_EV,
  neutronFraction,
  NUCLEON_MASS_EV,
  sahaS,
  samplePlanckX,
  WEAK_FREEZE_KT_EV
} from "./physics";
import { createRng, gaussian, nextRandom, poisson } from "./rng";
import type { Census, Fx, FxKind, Particle, ParticleKind, Reaction, ReactionKind, SimSettings, SimState } from "./types";

/** Logical frame (16:9, 1080p). The box is periodic: what leaves one edge enters the opposite one. */
export const SCENE_W = 1920;
export const SCENE_H = 1080;
/** Fixed story-time step; scrubbing and export replay these steps exactly. */
export const STEP = 1 / 60;

/** Drawn photons are a sample held near this size; the real Universe has ~1.6 billion per nucleon. */
export const PHOTON_BUDGET = 650;
/** Nucleons that survive annihilation: 28 protons + 4 neutrons once the neutrons have decayed to n/p ≈ 1/7. */
export const SURVIVING_NUCLEONS = 32;
const EXCESS_QUARKS = 3 * SURVIVING_NUCLEONS;
/** At confinement n ≈ p, so 16 protons; electrons balance their charge. */
const EXCESS_ELECTRONS_START = SURVIVING_NUCLEONS / 2;
const ELECTRON_PAIRS = 40;

/** Equilibrium quark–antiquark pairs in the plasma: a third end up in mesons, the rest in (anti)nucleons. */
export function quarkPairTarget(excess: number): number {
  return 144 * excess;
}

/** Rates are per story second; they set how fast things happen on screen, not cosmic rates. */
const RATE = {
  quarkCreate: 0.12,
  electronCreate: 0.08,
  nucleonCreate: 0.12,
  /** Like-with-like nucleon annihilation, per particle pair. */
  nucleonAnnihilate: 0.02,
  scatter: 2.5,
  /** Per free neutron; rises once deuterium can survive (the breakup rate keeps D/n at the Saha ratio). */
  deuteronForm: 1.0,
  deuteronFormBoost: 5,
  heliumFuse: 0.9,
  capture: 1.2
};

/**
 * Reheating, staged for the screen: as inflation stops, the field's energy turns into light, then
 * pairs condense out of that light. Really the field's decay products thermalise all together;
 * the info panel says so.
 */
export const LIGHT_START = INFLATION_END_STORY + 1;
export const LIGHT_END = INFLATION_END_STORY + 6;
export const PAIRS_START = INFLATION_END_STORY + 8.5;
export const PAIRS_END = INFLATION_END_STORY + 14;
const SPAWN_START = LIGHT_START;
const SPAWN_END = PAIRS_END;
const LABEL_SPACING = 2.2;
const CHECKPOINT_EVERY = 4;
const MAX_PHOTON_X = 80;

const SPEED: Record<ParticleKind, number> = {
  photon: 380,
  quark: 80,
  antiquark: 80,
  electron: 120,
  positron: 120,
  meson: 60,
  nucleon: 40,
  antinucleon: 40,
  deuteron: 30,
  helium: 24
};
const ATOM_SPEED = 18;
const DRIFT_DAMPING = 1.2;

export const COLORS = {
  flash: "#ffffff",
  quarkFlash: "#fff4d6",
  nucleonFlash: "#ffe2b8",
  electronFlash: "#d6f0ff",
  weak: "#7fe0ff",
  fusion: "#ffd27a",
  capture: "#9fd8ff",
  hit: "#e8f1ff"
};

// ---------- State helpers ----------

function wrap(v: number, size: number): number {
  return ((v % size) + size) % size;
}

function deltaWrapped(d: number, size: number): number {
  return d - size * Math.round(d / size);
}

function distance2(a: Particle, b: Particle): number {
  const dx = deltaWrapped(b.x - a.x, SCENE_W);
  const dy = deltaWrapped(b.y - a.y, SCENE_H);
  return dx * dx + dy * dy;
}

type Context = {
  state: SimState;
  byId: Map<number, Particle>;
  settings: SimSettings;
  field: InflatonField;
};

function addParticle(ctx: Context, kind: ParticleKind, x: number, y: number, vx: number, vy: number): Particle {
  const { state } = ctx;
  const p: Particle = {
    id: state.nextId++,
    kind,
    x: wrap(x, SCENE_W),
    y: wrap(y, SCENE_H),
    vx,
    vy,
    born: state.story,
    energyX: 0,
    color: 0,
    neutron: false,
    electrons: 0,
    busy: 0,
    decayAt: 0,
    fadeFrom: 0,
    dead: false
  };
  state.particles.push(p);
  ctx.byId.set(p.id, p);
  return p;
}

function addPhoton(ctx: Context, x: number, y: number, angle: number, energyX: number): Particle {
  const p = addParticle(ctx, "photon", x, y, Math.cos(angle) * SPEED.photon, Math.sin(angle) * SPEED.photon);
  p.energyX = Math.min(MAX_PHOTON_X, energyX);
  return p;
}

function randomVelocity(ctx: Context, speed: number): [number, number] {
  const a = nextRandom(ctx.state.rng) * Math.PI * 2;
  return [Math.cos(a) * speed, Math.sin(a) * speed];
}

function kill(p: Particle): void {
  p.dead = true;
}

function addFx(ctx: Context, kind: FxKind, x: number, y: number, duration: number, color: string, size: number, extra?: Partial<Fx>): void {
  ctx.state.fx.push({ kind, x, y, start: ctx.state.story, duration, color, size, ...extra });
}

/** Event labels are spaced out so the audience can read them. */
function maybeLabel(ctx: Context, text: string, x: number, y: number): void {
  if (ctx.state.story - ctx.state.lastLabel < LABEL_SPACING) {
    return;
  }
  ctx.state.lastLabel = ctx.state.story;
  addFx(ctx, "label", x, y, 1.8, "#ffffff", 0, { text });
}

function isFree(p: Particle): boolean {
  return !p.dead && p.busy === 0 && p.fadeFrom === 0;
}

function freeOf(ctx: Context, test: (p: Particle) => boolean): Particle[] {
  return ctx.state.particles.filter((p) => isFree(p) && test(p));
}

function nearest(from: Particle, candidates: Particle[], exclude?: Set<number>): Particle | null {
  let best: Particle | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (c === from || !isFree(c) || exclude?.has(c.id)) {
      continue;
    }
    const d = distance2(from, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function pick<T>(ctx: Context, list: T[]): T {
  return list[Math.floor(nextRandom(ctx.state.rng) * list.length)];
}

function startReaction(
  ctx: Context,
  kind: ReactionKind,
  members: Particle[],
  duration: number,
  toOffsets: [number, number][],
  energyEV = 0,
  neutron = false
): Reaction {
  const { state } = ctx;
  // Meeting point: centroid in coordinates unwrapped around the first member.
  const ref = members[0];
  const rel = members.map((m) => [deltaWrapped(m.x - ref.x, SCENE_W), deltaWrapped(m.y - ref.y, SCENE_H)]);
  const mx = rel.reduce((s, r) => s + r[0], 0) / members.length;
  const my = rel.reduce((s, r) => s + r[1], 0) / members.length;
  const reaction: Reaction = {
    id: state.nextId++,
    kind,
    members: members.map((m) => m.id),
    start: state.story,
    end: state.story + duration,
    cx: wrap(ref.x + mx, SCENE_W),
    cy: wrap(ref.y + my, SCENE_H),
    fromX: rel.map((r) => r[0] - mx),
    fromY: rel.map((r) => r[1] - my),
    toX: toOffsets.map((o) => o[0]),
    toY: toOffsets.map((o) => o[1]),
    energyEV,
    neutron
  };
  for (const m of members) {
    m.busy = reaction.id;
    m.vx = 0;
    m.vy = 0;
  }
  state.reactions.push(reaction);
  return reaction;
}

function easeInOut(f: number): number {
  return f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
}

/** Progress of a reaction at the current story time, eased. */
export function reactionProgress(r: Reaction, story: number): number {
  return easeInOut(Math.min(1, Math.max(0, (story - r.start) / (r.end - r.start))));
}

// ---------- Construction, checkpoints ----------

function freshState(settings: SimSettings): SimState {
  return {
    story: 0,
    stepIndex: 0,
    rng: createRng(settings.seed),
    nextId: 1,
    particles: [],
    reactions: [],
    fx: [],
    spawned: { photon: 0, pairs: 0, excessQuarks: 0, electronPairs: 0, excessElectrons: 0 },
    confined: false,
    lastWeakEvent: -Infinity,
    lastLabel: -Infinity
  };
}

function cloneState(s: SimState): SimState {
  return structuredClone(s);
}

export type EarlyUniverseSim = {
  readonly settings: SimSettings;
  readonly field: InflatonField;
  state(): SimState;
  /** Advance by `seconds` of story time (whole steps; the remainder carries over). */
  advance(seconds: number): void;
  /** Jump to a story time, replaying from the nearest earlier checkpoint. */
  seek(story: number): void;
  reset(settings: SimSettings): void;
  census(): Census;
};

export function createEarlyUniverseSim(initial: SimSettings): EarlyUniverseSim {
  let settings = initial;
  let field = createInflatonField(settings.seed);
  let ctx: Context = { state: freshState(settings), byId: new Map(), settings, field };
  let checkpoints = new Map<number, SimState>();
  let carry = 0;

  const rebuildIndex = (): void => {
    ctx.byId = new Map(ctx.state.particles.map((p) => [p.id, p]));
  };

  const stepOnce = (): void => {
    const index = ctx.state.stepIndex;
    if (index % Math.round(CHECKPOINT_EVERY / STEP) === 0 && !checkpoints.has(index)) {
      checkpoints.set(index, cloneState(ctx.state));
    }
    step(ctx);
  };

  const api: EarlyUniverseSim = {
    get settings() {
      return settings;
    },
    get field() {
      return field;
    },
    state: () => ctx.state,
    advance(seconds: number) {
      carry += seconds;
      while (carry >= STEP && ctx.state.story < STORY_DURATION) {
        carry -= STEP;
        stepOnce();
      }
      if (ctx.state.story >= STORY_DURATION) {
        carry = 0;
      }
    },
    seek(story: number) {
      const targetIndex = Math.round(Math.min(STORY_DURATION, Math.max(0, story)) / STEP);
      if (targetIndex !== ctx.state.stepIndex) {
        let bestIndex = -1;
        for (const k of checkpoints.keys()) {
          if (k <= targetIndex && k > bestIndex) {
            bestIndex = k;
          }
        }
        // Keep going from the current state when that is closer than any checkpoint.
        if (!(ctx.state.stepIndex <= targetIndex && ctx.state.stepIndex >= bestIndex)) {
          ctx.state = bestIndex >= 0 ? cloneState(checkpoints.get(bestIndex) as SimState) : freshState(settings);
          rebuildIndex();
        }
        while (ctx.state.stepIndex < targetIndex) {
          stepOnce();
        }
      }
      carry = 0;
    },
    reset(next: SimSettings) {
      settings = next;
      field = createInflatonField(settings.seed);
      ctx = { state: freshState(settings), byId: new Map(), settings, field };
      checkpoints = new Map();
      carry = 0;
    },
    census: () => census(ctx.state)
  };
  return api;
}

// ---------- One step ----------

function step(ctx: Context): void {
  const { state } = ctx;
  state.stepIndex += 1;
  state.story = state.stepIndex * STEP;
  if (state.story < SPAWN_START) {
    return;
  }
  const clock = clockAt(state.story);
  const kT = clock.kTeV ?? 0;

  spawnFromField(ctx);
  move(ctx);
  updateReactions(ctx);
  scatterPhotons(ctx);

  const photons = state.particles.filter((p) => p.kind === "photon" && isFree(p));
  const settled = state.story >= SPAWN_END;
  if (!state.confined) {
    if (kT > CONFINEMENT_KT_EV) {
      if (settled) {
        quarkPlasma(ctx, photons, kT);
      }
    } else {
      confine(ctx);
    }
  } else {
    nucleonPairs(ctx, photons, kT);
    weakInteractions(ctx, kT, clock.tSec);
  }
  if (settled) {
    electronPairs(ctx, photons, kT);
  }
  if (kT < 0.3e6) {
    nucleosynthesis(ctx, kT);
  }
  if (kT < 8) {
    recombination(ctx, kT);
  }
  decayMesons(ctx, kT);
  cullPhotons(ctx);

  state.fx = state.fx.filter((f) => state.story < f.start + f.duration);
  if (state.particles.some((p) => p.dead)) {
    state.particles = state.particles.filter((p) => {
      if (p.dead) {
        ctx.byId.delete(p.id);
        return false;
      }
      return true;
    });
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const f = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return f * f * (3 - 2 * f);
}

/**
 * Reheating: light appears where the (frozen) inflaton field was strongest, then quark–antiquark
 * and electron–positron pairs condense out of that light, each from one photon.
 */
function spawnFromField(ctx: Context): void {
  const { state, settings } = ctx;
  if (state.story > SPAWN_END + STEP) {
    return;
  }
  const zoom = finalFieldZoom(INFLATION_END_STORY);
  const s = state.spawned;

  const position = (): [number, number] => {
    for (let tries = 0; tries < 12; tries += 1) {
      const x = nextRandom(state.rng) * SCENE_W;
      const y = nextRandom(state.rng) * SCENE_H;
      const v = fieldValue(ctx.field, x, y, zoom);
      const accept = Math.max(0.05, Math.min(1, 0.5 + 0.7 * v)) ** 2;
      if (nextRandom(state.rng) < accept) {
        return [x, y];
      }
    }
    return [nextRandom(state.rng) * SCENE_W, nextRandom(state.rng) * SCENE_H];
  };

  // Light: keep the drawn photons topped up to their (rising) budget, which also replaces the
  // photons that turn into pairs below.
  const photons = state.particles.filter((p) => p.kind === "photon" && isFree(p));
  const lightTarget = Math.round(PHOTON_BUDGET * smoothstep(LIGHT_START, LIGHT_END, state.story));
  for (let i = photons.length; i < lightTarget; i += 1) {
    const [x, y] = position();
    photons.push(addPhoton(ctx, x, y, nextRandom(state.rng) * Math.PI * 2, samplePlanckX(state.rng)));
    s.photon += 1;
  }

  // Matter: pairs condense out of the light. The small excess of quarks and electrons (whose
  // origin is unknown) appears quietly alongside.
  const frac = smoothstep(PAIRS_START, PAIRS_END, state.story);
  const due = (target: number, done: number): number => Math.max(0, Math.round(target * frac) - done);
  const fromLight = (a: ParticleKind, b: ParticleKind, flash: string, label: string): void => {
    const free = photons.filter((p) => !p.dead);
    const photon = free.length > 0 ? pick(ctx, free) : null;
    const [x, y] = photon ? [photon.x, photon.y] : position();
    const heading = photon ? Math.atan2(photon.vy, photon.vx) : nextRandom(state.rng) * Math.PI * 2;
    if (photon) {
      kill(photon);
    }
    makePair(ctx, a, b, x, y, heading);
    addFx(ctx, "spark", x, y, 0.6, flash, 16);
    maybeLabel(ctx, label, x, y);
  };
  for (let i = due(quarkPairTarget(settings.excess), s.pairs); i > 0; i -= 1) {
    fromLight("quark", "antiquark", COLORS.quarkFlash, "γ + γ → q + q̄");
    s.pairs += 1;
  }
  for (let i = due(ELECTRON_PAIRS, s.electronPairs); i > 0; i -= 1) {
    fromLight("electron", "positron", COLORS.electronFlash, "γ + γ → e⁻ + e⁺");
    s.electronPairs += 1;
  }
  for (let i = due(EXCESS_QUARKS, s.excessQuarks); i > 0; i -= 1) {
    const [x, y] = position();
    const q = addParticle(ctx, "quark", x, y, ...randomVelocity(ctx, SPEED.quark));
    q.color = Math.floor(nextRandom(state.rng) * 3);
    s.excessQuarks += 1;
  }
  for (let i = due(EXCESS_ELECTRONS_START, s.excessElectrons); i > 0; i -= 1) {
    const [x, y] = position();
    addParticle(ctx, "electron", x, y, ...randomVelocity(ctx, SPEED.electron));
    s.excessElectrons += 1;
  }
}

function makePair(ctx: Context, a: ParticleKind, b: ParticleKind, x: number, y: number, heading: number): [Particle, Particle] {
  const speed = SPEED[a];
  const side = heading + Math.PI / 2;
  const vx = Math.cos(side) * speed;
  const vy = Math.sin(side) * speed;
  const p = addParticle(ctx, a, x, y, vx, vy);
  const q = addParticle(ctx, b, x, y, -vx, -vy);
  const color = Math.floor(nextRandom(ctx.state.rng) * 3);
  p.color = color;
  q.color = color;
  return [p, q];
}

function move(ctx: Context): void {
  const { state } = ctx;
  const rng = state.rng;
  for (const p of state.particles) {
    if (p.busy !== 0 || p.dead) {
      continue;
    }
    if (p.kind !== "photon") {
      // Ornstein–Uhlenbeck drift: random kicks with damping keep a steady typical speed.
      const target = p.electrons > 0 ? ATOM_SPEED : SPEED[p.kind];
      const kick = target * Math.sqrt(DRIFT_DAMPING * STEP);
      p.vx += -DRIFT_DAMPING * p.vx * STEP + kick * gaussian(rng);
      p.vy += -DRIFT_DAMPING * p.vy * STEP + kick * gaussian(rng);
    }
    p.x = wrap(p.x + p.vx * STEP, SCENE_W);
    p.y = wrap(p.y + p.vy * STEP, SCENE_H);
  }
}

/** Free electrons scatter light (Thomson scattering); once they are bound in atoms, light streams freely. */
function scatterPhotons(ctx: Context): void {
  const { state } = ctx;
  let free = 0;
  let total = 0;
  for (const p of state.particles) {
    if (p.kind === "electron" || p.kind === "positron") {
      total += 1;
      if (p.busy === 0) {
        free += 1;
      }
    } else if (p.electrons > 0) {
      total += p.electrons;
    }
  }
  const freeFraction = total > 0 ? free / total : 1;
  const chance = 1 - Math.exp(-RATE.scatter * freeFraction * STEP);
  if (chance <= 0) {
    return;
  }
  for (const p of state.particles) {
    if (p.kind !== "photon" || p.dead || nextRandom(state.rng) >= chance) {
      continue;
    }
    const a = nextRandom(state.rng) * Math.PI * 2;
    p.vx = Math.cos(a) * SPEED.photon;
    p.vy = Math.sin(a) * SPEED.photon;
    // Collisions keep the light thermal: re-draw the energy from the blackbody spectrum.
    if (nextRandom(state.rng) < 0.5) {
      p.energyX = samplePlanckX(state.rng);
    }
  }
}

function eligiblePhotons(photons: Particle[], kT: number, thresholdEV: number): Particle[] {
  const xMin = thresholdEV / kT;
  return photons.filter((p) => p.energyX > xMin);
}

/**
 * Generic pair equilibrium: energetic photons make pairs at `createRate`, and pairs annihilate
 * at σ·N·N̄ with σ set so the equilibrium holds `pairTarget` pairs while all photons qualify.
 * As the Universe cools, fewer photons clear the 2mc² threshold and the pairs die out.
 */
function pairEquilibrium(
  ctx: Context,
  photons: Particle[],
  kT: number,
  opts: {
    matter: ParticleKind;
    anti: ParticleKind;
    massEV: number;
    createRate: number;
    sigma: number;
    duration: number;
    flash: string;
    createLabel: string;
    annihilateLabel: string;
    sameNeutron?: boolean;
  }
): void {
  const { state } = ctx;
  const eligible = eligiblePhotons(photons, kT, 2 * opts.massEV);
  const creations = poisson(state.rng, opts.createRate * eligible.length * STEP);
  for (let i = 0; i < creations && eligible.length > 0; i += 1) {
    const idx = Math.floor(nextRandom(state.rng) * eligible.length);
    const photon = eligible[idx];
    eligible.splice(idx, 1);
    if (photon.dead) {
      continue;
    }
    kill(photon);
    const [p, q] = makePair(ctx, opts.matter, opts.anti, photon.x, photon.y, Math.atan2(photon.vy, photon.vx));
    if (opts.sameNeutron) {
      const n = nextRandom(state.rng) < 0.5;
      p.neutron = n;
      q.neutron = n;
    }
    addFx(ctx, "spark", photon.x, photon.y, 0.45, opts.flash, 10);
    maybeLabel(ctx, opts.createLabel, photon.x, photon.y);
  }

  const matter = freeOf(ctx, (p) => p.kind === opts.matter);
  const anti = freeOf(ctx, (p) => p.kind === opts.anti);
  const pairsOf = (n: boolean | null): [Particle[], Particle[]] =>
    n === null ? [matter, anti] : [matter.filter((p) => p.neutron === n), anti.filter((p) => p.neutron === n)];
  const groups = opts.sameNeutron ? [pairsOf(false), pairsOf(true)] : [pairsOf(null)];
  for (const [m, a] of groups) {
    const events = poisson(state.rng, opts.sigma * m.length * a.length * STEP);
    const used = new Set<number>();
    for (let i = 0; i < events; i += 1) {
      const candidates = a.filter((p) => !used.has(p.id));
      if (candidates.length === 0) {
        break;
      }
      const antiParticle = pick(ctx, candidates);
      const partner = nearest(antiParticle, m, used);
      if (!partner) {
        break;
      }
      used.add(antiParticle.id);
      used.add(partner.id);
      const r = startReaction(ctx, "annihilate", [partner, antiParticle], opts.duration, [
        [0, 0],
        [0, 0]
      ]);
      r.energyEV = opts.massEV;
      maybeLabel(ctx, opts.annihilateLabel, r.cx, r.cy);
    }
  }
}

function quarkPlasma(ctx: Context, photons: Particle[], kT: number): void {
  const pairs = quarkPairTarget(ctx.settings.excess);
  pairEquilibrium(ctx, photons, kT, {
    matter: "quark",
    anti: "antiquark",
    massEV: LIGHT_QUARK_MASS_EV,
    createRate: RATE.quarkCreate,
    sigma: (RATE.quarkCreate * PHOTON_BUDGET) / (pairs * (pairs + EXCESS_QUARKS)),
    duration: 0.25,
    flash: COLORS.quarkFlash,
    createLabel: "γ + γ → q + q̄",
    annihilateLabel: "q + q̄ → γ + γ"
  });
}

function electronPairs(ctx: Context, photons: Particle[], kT: number): void {
  pairEquilibrium(ctx, photons, kT, {
    matter: "electron",
    anti: "positron",
    massEV: ELECTRON_MASS_EV,
    createRate: RATE.electronCreate,
    sigma: (RATE.electronCreate * PHOTON_BUDGET) / (ELECTRON_PAIRS * (ELECTRON_PAIRS + EXCESS_ELECTRONS_START)),
    duration: 0.5,
    flash: COLORS.electronFlash,
    createLabel: "γ + γ → e⁻ + e⁺",
    annihilateLabel: "e⁻ + e⁺ → γ + γ"
  });
}

function nucleonPairs(ctx: Context, photons: Particle[], kT: number): void {
  pairEquilibrium(ctx, photons, kT, {
    matter: "nucleon",
    anti: "antinucleon",
    massEV: NUCLEON_MASS_EV,
    createRate: RATE.nucleonCreate,
    sigma: RATE.nucleonAnnihilate,
    duration: 0.9,
    flash: COLORS.nucleonFlash,
    createLabel: "γ + γ → p + p̄",
    annihilateLabel: "p + p̄ → light",
    sameNeutron: true
  });
}

// ---------- Confinement ----------

/** Position along a Hilbert curve on a 64×64 grid, to group particles that are near each other. */
function hilbertIndex(x: number, y: number): number {
  const n = 64;
  let hx = Math.min(n - 1, Math.floor((x / SCENE_W) * n));
  let hy = Math.min(n - 1, Math.floor((y / SCENE_H) * n));
  let d = 0;
  for (let s = n / 2; s > 0; s = Math.floor(s / 2)) {
    const rx = (hx & s) > 0 ? 1 : 0;
    const ry = (hy & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        hx = s - 1 - hx;
        hy = s - 1 - hy;
      }
      [hx, hy] = [hy, hx];
    }
  }
  return d;
}

function byHilbert(list: Particle[]): Particle[] {
  return list
    .map((p) => ({ p, h: hilbertIndex(p.x, p.y) }))
    .sort((a, b) => a.h - b.h || a.p.id - b.p.id)
    .map((e) => e.p);
}

const TRIANGLE: [number, number][] = [0, 1, 2].map((i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3;
  return [Math.cos(a) * 6, Math.sin(a) * 6];
});

/**
 * At kT ≈ 155 MeV free quarks disappear: each antiquark either pairs with a nearby quark
 * into a meson or joins two neighbours in an antibaryon; the leftover quarks form baryons.
 * Colours are reassigned within each trio (gluon exchange shuffles them constantly anyway).
 */
function confine(ctx: Context): void {
  const { state } = ctx;
  // Let quark annihilations already under way finish first, so quarks − antiquarks is exactly the excess.
  const quarkBusy = state.reactions.some(
    (r) => r.kind === "annihilate" && r.members.some((id) => ctx.byId.get(id)?.kind === "quark")
  );
  if (quarkBusy) {
    return;
  }
  state.confined = true;
  const quarks = freeOf(ctx, (p) => p.kind === "quark");
  const antiquarks = byHilbert(freeOf(ctx, (p) => p.kind === "antiquark"));
  const pairs = antiquarks.length;
  const antibaryons = Math.floor((pairs - Math.round(pairs / 3)) / 3);
  const mesons = pairs - 3 * antibaryons;

  const mesonAnti: Particle[] = [];
  const tripletAnti: Particle[] = [];
  antiquarks.forEach((p, i) => {
    if (i % 3 === 0 && mesonAnti.length < mesons) {
      mesonAnti.push(p);
    } else {
      tripletAnti.push(p);
    }
  });
  while (mesonAnti.length < mesons) {
    mesonAnti.push(tripletAnti.pop() as Particle);
  }

  const usedQuarks = new Set<number>();
  for (const a of mesonAnti) {
    const q = nearest(a, quarks, usedQuarks);
    if (!q) {
      continue;
    }
    usedQuarks.add(q.id);
    q.color = a.color;
    startReaction(ctx, "bindMeson", [q, a], 0.8 + 0.6 * nextRandom(state.rng), [
      [-4, 0],
      [4, 0]
    ]);
  }

  const bindTriplets = (list: Particle[], neutronFlags: boolean[]): void => {
    for (let i = 0; i + 2 < list.length; i += 3) {
      const trio = [list[i], list[i + 1], list[i + 2]];
      trio.forEach((p, c) => {
        p.color = c;
      });
      startReaction(ctx, "bindBaryon", trio, 1.2 + 1.2 * nextRandom(state.rng), TRIANGLE, 0, neutronFlags[i / 3]);
    }
  };

  // Antinucleons alternate p̄, n̄; nucleons get 16 more of each so 16 p + 16 n survive annihilation.
  const antiFlags = Array.from({ length: antibaryons }, (_, i) => i % 2 === 1);
  const antineutrons = antiFlags.filter(Boolean).length;
  const baryonQuarks = byHilbert(quarks.filter((q) => !usedQuarks.has(q.id)));
  const baryonCount = Math.floor(baryonQuarks.length / 3);
  const neutronCount = Math.min(baryonCount, antineutrons + EXCESS_QUARKS / 6);
  const flags = Array.from({ length: baryonCount }, (_, i) => i < neutronCount);
  for (let i = flags.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom(state.rng) * (i + 1));
    [flags[i], flags[j]] = [flags[j], flags[i]];
  }
  bindTriplets(tripletAnti, antiFlags);
  bindTriplets(baryonQuarks, flags);
  // Safety net: the counts above always divide exactly, but never leave a free quark behind.
  for (const p of state.particles) {
    if ((p.kind === "quark" || p.kind === "antiquark") && isFree(p)) {
      kill(p);
      addFx(ctx, "flash", p.x, p.y, 0.3, COLORS.quarkFlash, 8);
    }
  }
  addFx(ctx, "label", SCENE_W / 2, SCENE_H / 2 - 40, 2.4, "#ffffff", 0, {
    text: "Confinement: quarks bind into hadrons"
  });
}

// ---------- Weak interactions, nuclei, atoms ----------

/**
 * Pure Saha balance waits until deuterium is as common as free neutrons (kT ≈ 0.066 MeV, t ≈ 5 min).
 * In a full reaction network deuterium is burned on to helium as soon as a small amount of it lasts,
 * so helium forms at kT ≈ 0.08 MeV, t ≈ 3–4 min. Scaling the Saha ratio by this factor puts the
 * opening of the bottleneck at that textbook point.
 */
const HELIUM_PULL = 200;

function deuteriumSurvival(kT: number, protonFraction: number): number {
  return deuteriumSahaK(kT, protonFraction) * HELIUM_PULL;
}

function weakInteractions(ctx: Context, kT: number, tSec: number): void {
  const { state } = ctx;
  if (state.story - state.lastWeakEvent < 0.15) {
    return;
  }
  // Once deuterium survives, free neutrons are captured within seconds, far sooner than they decay
  // (τ ≈ 879 s), so the neutron count is locked from here on.
  if (kT < 0.3e6) {
    const freeProtons = state.particles.filter((p) => !p.dead && p.kind === "nucleon" && !p.neutron && p.electrons === 0);
    if (deuteriumSurvival(kT, freeProtons.length / SURVIVING_NUCLEONS) > 1) {
      return;
    }
  }
  const target = Math.round(SURVIVING_NUCLEONS * neutronFraction(kT, tSec, WEAK_FREEZE_TIME_S));
  let net = 0;
  for (const p of state.particles) {
    if (p.dead) {
      continue;
    }
    if (p.kind === "nucleon" && p.neutron) {
      net += 1;
    } else if (p.kind === "antinucleon" && p.neutron) {
      net -= 1;
    } else if (p.kind === "deuteron") {
      net += 1;
    } else if (p.kind === "helium") {
      net += 2;
    }
  }
  if (net <= target) {
    return;
  }
  const free = freeOf(ctx, (p) => p.kind === "nucleon" && p.neutron);
  if (free.length === 0) {
    return;
  }
  const n = pick(ctx, free);
  n.neutron = false;
  state.lastWeakEvent = state.story;
  addParticle(ctx, "electron", n.x, n.y, ...randomVelocity(ctx, SPEED.electron * 1.6));
  addFx(ctx, "ring", n.x, n.y, 0.7, COLORS.weak, 16);
  maybeLabel(ctx, kT >= WEAK_FREEZE_KT_EV ? "n + ν → p + e⁻" : "n → p + e⁻ + ν̄  (decay)", n.x, n.y);
}

function nucleosynthesis(ctx: Context, kT: number): void {
  const { state } = ctx;
  const freeNeutrons = freeOf(ctx, (p) => p.kind === "nucleon" && p.neutron);
  const freeProtons = freeOf(ctx, (p) => p.kind === "nucleon" && !p.neutron && p.electrons === 0);
  const k = deuteriumSurvival(kT, freeProtons.length / SURVIVING_NUCLEONS);

  const survival = Number.isFinite(k) ? k / (1 + k) : 1;
  const formRate = RATE.deuteronForm + RATE.deuteronFormBoost * survival;
  const forms = poisson(state.rng, formRate * freeNeutrons.length * STEP);
  const used = new Set<number>();
  for (let i = 0; i < forms; i += 1) {
    const candidates = freeNeutrons.filter((p) => !used.has(p.id));
    if (candidates.length === 0) {
      break;
    }
    const n = pick(ctx, candidates);
    const p = nearest(n, freeProtons, used);
    if (!p) {
      break;
    }
    used.add(n.id);
    used.add(p.id);
    startReaction(ctx, "fuseDeuteron", [p, n], 0.45, [
      [-4.5, 0],
      [4.5, 0]
    ]);
  }

  // Photodisintegration: detailed balance with the Saha ratio, formation/breakup = K.
  const breakChance = 1 - Math.exp(-(formRate / Math.max(k, 1e-12)) * STEP);
  for (const d of freeOf(ctx, (p) => p.kind === "deuteron")) {
    if (nextRandom(state.rng) >= breakChance) {
      continue;
    }
    kill(d);
    const a = nextRandom(state.rng) * Math.PI * 2;
    const vx = Math.cos(a) * 70;
    const vy = Math.sin(a) * 70;
    const p = addParticle(ctx, "nucleon", d.x - Math.cos(a) * 5, d.y - Math.sin(a) * 5, -vx, -vy);
    const n = addParticle(ctx, "nucleon", d.x + Math.cos(a) * 5, d.y + Math.sin(a) * 5, vx, vy);
    p.neutron = false;
    n.neutron = true;
    addFx(ctx, "hit", d.x, d.y, 0.5, COLORS.hit, 12, { angle: nextRandom(state.rng) * Math.PI * 2 });
    maybeLabel(ctx, "γ + D → p + n", d.x, d.y);
  }

  // Deuterium burns on to helium-4 (through helium-3 and tritium, not drawn).
  const deuterons = freeOf(ctx, (p) => p.kind === "deuteron");
  if (deuterons.length >= 2 && k > 1) {
    const fuses = poisson(state.rng, RATE.heliumFuse * deuterons.length * STEP);
    const usedD = new Set<number>();
    for (let i = 0; i < fuses; i += 1) {
      const candidates = deuterons.filter((p) => !usedD.has(p.id));
      if (candidates.length < 2) {
        break;
      }
      const a = pick(ctx, candidates);
      const b = nearest(a, deuterons, new Set([...usedD, a.id]));
      if (!b) {
        break;
      }
      usedD.add(a.id);
      usedD.add(b.id);
      startReaction(ctx, "fuseHelium", [a, b], 0.7, [
        [-4, 0],
        [4, 0]
      ]);
    }
  }
}

/** Protons and deuterons both hold one electron (deuterium is heavy hydrogen). */
function isHydrogenNucleus(p: Particle): boolean {
  return (p.kind === "nucleon" && !p.neutron) || p.kind === "deuteron";
}

function recombination(ctx: Context, kT: number): void {
  const { state } = ctx;
  const freeElectrons = freeOf(ctx, (p) => p.kind === "electron");
  const nuclei = state.particles.filter((p) => !p.dead && (p.kind === "helium" || isHydrogenNucleus(p)));
  const xe = Math.max(1, freeElectrons.length) / Math.max(1, nuclei.length);

  type Stage = { ions: (p: Particle) => boolean; binding: number; g: number; label: string };
  const stages: Stage[] = [
    { ions: (p) => p.kind === "helium" && p.electrons === 0, binding: HELIUM_II_BINDING_EV, g: 1, label: "He²⁺ + e⁻ → He⁺" },
    { ions: (p) => p.kind === "helium" && p.electrons === 1, binding: HELIUM_I_BINDING_EV, g: 4, label: "He⁺ + e⁻ → He" },
    { ions: (p) => isHydrogenNucleus(p) && p.electrons === 0, binding: HYDROGEN_BINDING_EV, g: 1, label: "p + e⁻ → H" }
  ];

  const usedE = new Set<number>();
  for (const stage of stages) {
    const ions = freeOf(ctx, stage.ions);
    const captures = poisson(state.rng, RATE.capture * ions.length * STEP);
    for (let i = 0; i < captures && ions.length > 0; i += 1) {
      const ion = pick(ctx, ions);
      ions.splice(ions.indexOf(ion), 1);
      const e = nearest(ion, freeElectrons, usedE);
      if (!e) {
        break;
      }
      usedE.add(e.id);
      const orbit = ion.kind === "helium" ? 13 : 14;
      const a = nextRandom(state.rng) * Math.PI * 2;
      startReaction(ctx, "capture", [ion, e], 0.7, [
        [0, 0],
        [Math.cos(a) * orbit, Math.sin(a) * orbit]
      ]);
      maybeLabel(ctx, stage.label, ion.x, ion.y);
    }
  }

  // Photoionisation, balanced against capture so the bound share follows the Saha equation.
  const atomsOf: { test: (p: Particle) => boolean; binding: number; g: number }[] = [
    { test: (p) => p.kind === "helium" && p.electrons === 1, binding: HELIUM_II_BINDING_EV, g: 1 },
    { test: (p) => p.kind === "helium" && p.electrons === 2, binding: HELIUM_I_BINDING_EV, g: 4 },
    { test: (p) => isHydrogenNucleus(p) && p.electrons === 1, binding: HYDROGEN_BINDING_EV, g: 1 }
  ];
  for (const species of atomsOf) {
    const rate = (RATE.capture * sahaS(kT, species.binding, species.g)) / xe;
    const chance = 1 - Math.exp(-Math.min(rate, 1e3) * STEP);
    if (chance < 1e-9) {
      continue;
    }
    for (const atom of freeOf(ctx, species.test)) {
      if (nextRandom(state.rng) >= chance) {
        continue;
      }
      atom.electrons -= 1;
      addParticle(ctx, "electron", atom.x, atom.y, ...randomVelocity(ctx, SPEED.electron * 1.4));
      addFx(ctx, "hit", atom.x, atom.y, 0.45, COLORS.hit, 9, { angle: nextRandom(state.rng) * Math.PI * 2 });
    }
  }
}

function decayMesons(ctx: Context, kT: number): void {
  const { state } = ctx;
  for (const m of state.particles) {
    if (m.kind !== "meson" || m.dead || m.busy !== 0 || state.story < m.decayAt) {
      continue;
    }
    kill(m);
    const a = nextRandom(state.rng) * Math.PI * 2;
    // A pion (≈ 140 MeV) decays into two photons of ≈ 70 MeV each.
    const x = 70e6 / Math.max(kT, 1);
    addPhoton(ctx, m.x, m.y, a, x);
    addPhoton(ctx, m.x, m.y, a + Math.PI, x);
    addFx(ctx, "flash", m.x, m.y, 0.3, COLORS.quarkFlash, 9);
  }
}

/** Keep the drawn photon sample near its budget: the oldest extras fade out. */
function cullPhotons(ctx: Context): void {
  const { state } = ctx;
  let live = 0;
  for (const p of state.particles) {
    if (p.kind === "photon" && !p.dead) {
      if (p.fadeFrom > 0 && state.story - p.fadeFrom > 0.5) {
        kill(p);
      } else if (p.fadeFrom === 0) {
        live += 1;
      }
    }
  }
  let extra = live - PHOTON_BUDGET;
  for (const p of state.particles) {
    if (extra <= 0) {
      break;
    }
    if (p.kind === "photon" && !p.dead && p.fadeFrom === 0 && p.busy === 0) {
      p.fadeFrom = state.story;
      extra -= 1;
    }
  }
}

// ---------- Reactions ----------

function updateReactions(ctx: Context): void {
  const { state } = ctx;
  const remaining: Reaction[] = [];
  for (const r of state.reactions) {
    const f = reactionProgress(r, state.story);
    // Particle and antiparticle spiral into each other, faster and faster, before they annihilate.
    const turn = r.kind === "annihilate" ? f * f * 2.5 * Math.PI : 0;
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    r.members.forEach((id, i) => {
      const m = ctx.byId.get(id);
      if (m) {
        const ox = r.fromX[i] + (r.toX[i] - r.fromX[i]) * f;
        const oy = r.fromY[i] + (r.toY[i] - r.fromY[i]) * f;
        m.x = wrap(r.cx + ox * c - oy * sn, SCENE_W);
        m.y = wrap(r.cy + ox * sn + oy * c, SCENE_H);
      }
    });
    if (state.story >= r.end) {
      completeReaction(ctx, r);
    } else {
      remaining.push(r);
    }
  }
  state.reactions = remaining;
}

function completeReaction(ctx: Context, r: Reaction): void {
  const { state } = ctx;
  const members = r.members.map((id) => ctx.byId.get(id)).filter((p): p is Particle => p !== undefined);
  const kT = clockAt(state.story).kTeV ?? 1;
  const release = (): void => {
    for (const m of members) {
      m.busy = 0;
    }
  };
  switch (r.kind) {
    case "annihilate": {
      members.forEach(kill);
      // Each photon carries one rest mass plus a thermal share of kinetic energy.
      const a = nextRandom(state.rng) * Math.PI * 2;
      addPhoton(ctx, r.cx, r.cy, a, r.energyEV / kT + samplePlanckX(state.rng));
      addPhoton(ctx, r.cx, r.cy, a + Math.PI, r.energyEV / kT + samplePlanckX(state.rng));
      const kind = members[0]?.kind;
      if (kind === "nucleon") {
        // A proton and antiproton release about 2 GeV: the biggest bangs in the film.
        addFx(ctx, "flash", r.cx, r.cy, 0.8, COLORS.nucleonFlash, 42);
        addFx(ctx, "ring", r.cx, r.cy, 1.0, COLORS.nucleonFlash, 76);
        addFx(ctx, "ring", r.cx, r.cy, 0.55, COLORS.flash, 34);
        addFx(ctx, "burst", r.cx, r.cy, 0.85, COLORS.nucleonFlash, 96);
      } else if (kind === "electron") {
        addFx(ctx, "flash", r.cx, r.cy, 0.5, COLORS.electronFlash, 20);
        addFx(ctx, "ring", r.cx, r.cy, 0.55, COLORS.electronFlash, 30);
        addFx(ctx, "burst", r.cx, r.cy, 0.5, COLORS.electronFlash, 40);
      } else {
        addFx(ctx, "flash", r.cx, r.cy, 0.4, COLORS.flash, 16);
      }
      break;
    }
    case "bindMeson": {
      members.forEach(kill);
      const m = addParticle(ctx, "meson", r.cx, r.cy, ...randomVelocity(ctx, SPEED.meson));
      m.color = members[0]?.color ?? 0;
      m.decayAt = state.story + 0.4 + 0.6 * nextRandom(state.rng);
      break;
    }
    case "bindBaryon": {
      const anti = members[0]?.kind === "antiquark";
      members.forEach(kill);
      const b = addParticle(ctx, anti ? "antinucleon" : "nucleon", r.cx, r.cy, ...randomVelocity(ctx, SPEED.nucleon));
      b.neutron = r.neutron;
      addFx(ctx, "flash", r.cx, r.cy, 0.35, anti ? "#bfe9ff" : "#ffe7c2", 12);
      break;
    }
    case "fuseDeuteron": {
      members.forEach(kill);
      addParticle(ctx, "deuteron", r.cx, r.cy, ...randomVelocity(ctx, SPEED.deuteron));
      addFx(ctx, "flash", r.cx, r.cy, 0.35, COLORS.fusion, 10);
      maybeLabel(ctx, "p + n → D + γ", r.cx, r.cy);
      break;
    }
    case "fuseHelium": {
      members.forEach(kill);
      addParticle(ctx, "helium", r.cx, r.cy, ...randomVelocity(ctx, SPEED.helium));
      addPhoton(ctx, r.cx, r.cy, nextRandom(state.rng) * Math.PI * 2, 23.8e6 / kT);
      addFx(ctx, "ring", r.cx, r.cy, 0.9, COLORS.fusion, 30);
      maybeLabel(ctx, "D + D → ⁴He", r.cx, r.cy);
      break;
    }
    case "capture": {
      const [nucleus, electron] = members;
      if (nucleus && electron) {
        kill(electron);
        nucleus.electrons += 1;
        addFx(ctx, "flash", r.cx, r.cy, 0.3, COLORS.capture, 8);
      }
      break;
    }
  }
  release();
}

// ---------- Census ----------

export function census(state: SimState): Census {
  const c: Census = {
    photons: 0,
    quarks: 0,
    antiquarks: 0,
    electrons: 0,
    positrons: 0,
    mesons: 0,
    protons: 0,
    neutrons: 0,
    antiprotons: 0,
    antineutrons: 0,
    deuterons: 0,
    helium: 0,
    hydrogenAtoms: 0,
    heliumAtoms: 0,
    freeElectrons: 0,
    heliumMassFraction: 0
  };
  for (const p of state.particles) {
    if (p.dead) {
      continue;
    }
    switch (p.kind) {
      case "photon":
        if (p.fadeFrom === 0) {
          c.photons += 1;
        }
        break;
      case "quark":
        c.quarks += 1;
        break;
      case "antiquark":
        c.antiquarks += 1;
        break;
      case "electron":
        c.electrons += 1;
        if (p.busy === 0) {
          c.freeElectrons += 1;
        }
        break;
      case "positron":
        c.positrons += 1;
        break;
      case "meson":
        c.mesons += 1;
        break;
      case "nucleon":
        if (p.neutron) {
          c.neutrons += 1;
        } else {
          c.protons += 1;
          if (p.electrons > 0) {
            c.hydrogenAtoms += 1;
          }
          c.electrons += p.electrons;
        }
        break;
      case "antinucleon":
        if (p.neutron) {
          c.antineutrons += 1;
        } else {
          c.antiprotons += 1;
        }
        break;
      case "deuteron":
        c.deuterons += 1;
        c.electrons += p.electrons;
        if (p.electrons > 0) {
          c.hydrogenAtoms += 1;
        }
        break;
      case "helium":
        c.helium += 1;
        c.electrons += p.electrons;
        if (p.electrons === 2) {
          c.heliumAtoms += 1;
        }
        break;
    }
  }
  const nucleons = c.protons + c.neutrons + 2 * c.deuterons + 4 * c.helium;
  c.heliumMassFraction = nucleons > 0 ? (4 * c.helium) / nucleons : 0;
  return c;
}

/** Story time at the start of each chapter (for jump buttons). */
export const CHAPTER_STARTS = CHAPTERS.map((c) => c.start);
