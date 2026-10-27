import type { Rng } from "./rng";

export type ParticleKind =
  | "photon"
  | "quark"
  | "antiquark"
  | "electron"
  | "positron"
  | "meson"
  | "nucleon"
  | "antinucleon"
  | "deuteron"
  | "helium";

export type Particle = {
  id: number;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Story time when it appeared (for fade-in). */
  born: number;
  /** Photons: energy in units of the current kT. Fixed between scatterings, so photons cool with the gas. */
  energyX: number;
  /** Quarks: colour 0..2 (red, green, blue); antiquarks carry the matching anticolour. */
  color: number;
  /** Nucleons and antinucleons: neutron (true) or proton (false). */
  neutron: boolean;
  /** Nuclei: electrons captured so far (a proton with 1 is a hydrogen atom). */
  electrons: number;
  /** Id of the reaction this particle is taking part in, or 0. */
  busy: number;
  /** Mesons: story time when they decay into light. */
  decayAt: number;
  /** Photons culled from the drawn sample fade out from this story time; 0 = not fading. */
  fadeFrom: number;
  dead: boolean;
};

export type ReactionKind =
  | "annihilate"
  | "bindBaryon"
  | "bindMeson"
  | "fuseDeuteron"
  | "fuseHelium"
  | "capture";

/**
 * A short animated event: members move from their positions to offsets around a meeting
 * point, then `completeReaction` swaps them for the products.
 */
export type Reaction = {
  id: number;
  kind: ReactionKind;
  members: number[];
  start: number;
  end: number;
  cx: number;
  cy: number;
  /** Member start offsets from (cx, cy), unwrapped across the periodic edges. */
  fromX: number[];
  fromY: number[];
  toX: number[];
  toY: number[];
  /** For annihilations: rest energy per particle in eV, passed on to each outgoing photon. */
  energyEV: number;
  /** For baryon binding: whether the product is a neutron (or antineutron). */
  neutron: boolean;
};

export type FxKind = "flash" | "ring" | "spark" | "label" | "hit" | "burst";

/** Purely visual effects emitted by events. They live in the sim state so replay is exact. */
export type Fx = {
  kind: FxKind;
  x: number;
  y: number;
  start: number;
  duration: number;
  color: string;
  size: number;
  text?: string;
  /** "hit": direction the incoming photon comes from. */
  angle?: number;
};

/** "Matter : antimatter" after confinement is (k + 1) : k. */
export type MatterExcess = 2 | 4 | 8;

export type SimSettings = {
  seed: number;
  excess: MatterExcess;
};

export type SimState = {
  /** stepIndex × STEP, kept as an integer count so replays land on identical times. */
  story: number;
  stepIndex: number;
  rng: Rng;
  nextId: number;
  particles: Particle[];
  reactions: Reaction[];
  fx: Fx[];
  /** Particles from the inflaton field so far (reheating). */
  spawned: { photon: number; pairs: number; excessQuarks: number; electronPairs: number; excessElectrons: number };
  confined: boolean;
  lastWeakEvent: number;
  lastLabel: number;
};

export type Census = {
  photons: number;
  quarks: number;
  antiquarks: number;
  electrons: number;
  positrons: number;
  mesons: number;
  protons: number;
  neutrons: number;
  antiprotons: number;
  antineutrons: number;
  deuterons: number;
  helium: number;
  hydrogenAtoms: number;
  heliumAtoms: number;
  freeElectrons: number;
  /** Helium-4 share of all nucleon mass (bound in helium / all nucleons). */
  heliumMassFraction: number;
};
