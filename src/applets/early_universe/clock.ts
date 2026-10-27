import { formatScientific, sig } from "../../core/sciFormat";
import { K_B_EV_PER_K } from "./physics";

/**
 * The film runs on "story time" (presentation seconds). Each moment maps to a cosmic time
 * and temperature: inflation is keyed in cosmic time, everything after in temperature, and
 * the other quantity follows from the standard radiation-era relation
 * t ≈ 2.42 s / √g* · (kT / 1 MeV)⁻², then T ∝ t^(−2/3) after matter–radiation equality.
 */

export type ChapterId =
  | "inflation"
  | "reheating"
  | "matter"
  | "plasma"
  | "confinement"
  | "annihilation"
  | "nuclei"
  | "atoms"
  | "afterglow"
  | "composition";

export type Chapter = {
  id: ChapterId;
  title: string;
  caption: string[];
  /** Short label for chapter buttons. */
  short: string;
  start: number;
  end: number;
};

export const CHAPTERS: Chapter[] = [
  {
    id: "inflation",
    short: "Inflation",
    title: "Inflation",
    caption: [
      "A tiny patch of space grows by a factor of at least 10²⁶ in a split second.",
      "Its energy is held in a field, not yet in particles.",
      "Quantum ripples in the field are stretched to cosmic size."
    ],
    start: 0,
    end: 14
  },
  {
    id: "reheating",
    short: "Reheating",
    title: "Inflation ends",
    caption: [
      "Inflation stops, and the field's energy pours out as radiation:",
      "the Universe fills with blazing light.",
      "Where the field was slightly stronger, there is slightly more energy: the seeds of all structure."
    ],
    start: 14,
    end: 22
  },
  {
    id: "matter",
    short: "Energy → matter",
    title: "Energy becomes matter",
    caption: [
      "So hot that energy and matter constantly trade places (E = mc²):",
      "light turns into pairs of quarks and antiquarks, and of electrons and positrons.",
      "The quarks that will one day build protons and neutrons are born."
    ],
    start: 22,
    end: 30
  },
  {
    id: "plasma",
    short: "Quark soup",
    title: "The quark–gluon plasma",
    caption: [
      "Too hot for anything to stick together.",
      "Light keeps turning into quark–antiquark pairs, and pairs annihilate back into light.",
      "Quarks slightly outnumber antiquarks. Why is still unknown."
    ],
    start: 30,
    end: 44
  },
  {
    id: "confinement",
    short: "Confinement",
    title: "Quarks lock together",
    caption: [
      "Below about 2 trillion K, quarks can no longer roam free.",
      "They bind in threes into protons and neutrons (and their antiparticles),",
      "or in quark–antiquark pairs that quickly decay into light."
    ],
    start: 44,
    end: 48
  },
  {
    id: "annihilation",
    short: "Annihilation",
    title: "Matter meets antimatter",
    caption: [
      "Light is no longer energetic enough to make new proton–antiproton pairs.",
      "Matter and antimatter annihilate; only the small excess of matter survives.",
      "Later, electrons and positrons do the same."
    ],
    start: 48,
    end: 70
  },
  {
    id: "nuclei",
    short: "First nuclei",
    title: "The first nuclei",
    caption: [
      "Protons and neutrons stick together as deuterium, but energetic light smashes it",
      "apart until about 3–4 minutes in. Then deuterium quickly builds helium:",
      "about a quarter of the mass ends up in helium nuclei."
    ],
    start: 70,
    end: 84
  },
  {
    id: "atoms",
    short: "First atoms",
    title: "The first atoms",
    caption: [
      "Some 380,000 years later, below about 3,000 K, nuclei finally keep their electrons.",
      "Light stops bouncing off free electrons and travels in straight lines:",
      "the Universe becomes transparent."
    ],
    start: 84,
    end: 102
  },
  {
    id: "afterglow",
    short: "Afterglow",
    title: "The afterglow",
    caption: [
      "That released light still fills the Universe.",
      "Stretched by cosmic expansion ever since, it is now the 2.7 K",
      "cosmic microwave background."
    ],
    start: 102,
    end: 112
  },
  {
    id: "composition",
    short: "Dark ages",
    title: "What the Universe is made of",
    caption: [
      "The Universe drifts on through its dark ages: no stars yet, only cooling gas.",
      "By mass it is three quarters hydrogen and one quarter helium,",
      "with tiny traces of deuterium, helium-3 and lithium.",
      "Over the next hundred million years, gravity will gather it into the first stars."
    ],
    start: 112,
    end: 134
  }
];

export const STORY_DURATION = CHAPTERS[CHAPTERS.length - 1].end;
export const INFLATION_END_STORY = CHAPTERS[0].end;
/** e-folds of expansion drawn during inflation (≥ 60 is the usual requirement). */
export const INFLATION_EFOLDS = 60;

/** Inflation keyframes: story seconds → log₁₀(t / s). */
const INFLATION_LOG_T: [number, number] = [-36, -32];

/** Story seconds → log₁₀(T / K), linear in between. */
const TEMPERATURE_KEYS: [number, number][] = [
  [14, 25.75],
  [30, 15.8],
  [44, 12.3],
  [48, 12.18],
  [55, 11.5],
  [62, 10.3],
  [70, 9.1],
  [84, 8.55],
  [88, 4.0],
  [102, 3.42],
  [112, 2.5],
  [134, 1.92]
];

/**
 * Coarse table of the effective number of relativistic species g*(kT), interpolated in log kT:
 * all Standard Model particles above ~200 GeV, the QCD drop at ~155 MeV, e± annihilation near 0.5 MeV.
 */
const G_STAR: [number, number][] = [
  [2e5, 106.75],
  [2e4, 86.25],
  [2e3, 75.75],
  [300, 61.75],
  [170, 61.75],
  [130, 17.25],
  [40, 14.25],
  [15, 10.75],
  [2, 10.75],
  [0.05, 3.36]
];

/** Matter–radiation equality (z ≈ 3400). */
const T_EQUALITY_K = 9270;

export function gStar(kTMeV: number): number {
  if (kTMeV >= G_STAR[0][0]) {
    return G_STAR[0][1];
  }
  for (let i = 1; i < G_STAR.length; i += 1) {
    const [hiT, hiG] = G_STAR[i - 1];
    const [loT, loG] = G_STAR[i];
    if (kTMeV >= loT) {
      const f = Math.log(kTMeV / loT) / Math.log(hiT / loT);
      return loG + (hiG - loG) * f;
    }
  }
  return G_STAR[G_STAR.length - 1][1];
}

function radiationEraTime(tempK: number): number {
  const kTMeV = tempK * K_B_EV_PER_K * 1e-6;
  return 2.42 / Math.sqrt(gStar(kTMeV)) / (kTMeV * kTMeV);
}

/** Cosmic time in seconds at temperature T (after reheating). */
export function timeAtTemperature(tempK: number): number {
  if (tempK >= T_EQUALITY_K) {
    return radiationEraTime(tempK);
  }
  return radiationEraTime(T_EQUALITY_K) * (T_EQUALITY_K / tempK) ** 1.5;
}

/** Temperature at which `timeAtTemperature` reaches tSec (bisection; t falls monotonically with T). */
export function temperatureAtTime(tSec: number): number {
  let lo = 1;
  let hi = 30;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (timeAtTemperature(10 ** mid) > tSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 10 ** ((lo + hi) / 2);
}

export type ClockState = {
  story: number;
  chapterIndex: number;
  /** 0..1 through the current chapter. */
  chapterProgress: number;
  tSec: number;
  /** Null during inflation: the energy is in the inflaton field, not a thermal gas. */
  tempK: number | null;
  kTeV: number | null;
  /** e-folds of inflation so far (inflation chapter only). */
  efolds: number | null;
  /** Before ~10⁻¹¹ s the numbers depend on the (unknown) inflation and reheating model. */
  modelDependent: boolean;
};

export function chapterIndexAt(story: number): number {
  for (let i = CHAPTERS.length - 1; i >= 0; i -= 1) {
    if (story >= CHAPTERS[i].start) {
      return i;
    }
  }
  return 0;
}

function interpolateKeys(keys: [number, number][], story: number): number {
  if (story <= keys[0][0]) {
    return keys[0][1];
  }
  for (let i = 1; i < keys.length; i += 1) {
    if (story <= keys[i][0]) {
      const [s0, v0] = keys[i - 1];
      const [s1, v1] = keys[i];
      return v0 + ((v1 - v0) * (story - s0)) / (s1 - s0);
    }
  }
  return keys[keys.length - 1][1];
}

export function clockAt(story: number): ClockState {
  const s = Math.min(STORY_DURATION, Math.max(0, story));
  const chapterIndex = chapterIndexAt(s);
  const chapter = CHAPTERS[chapterIndex];
  const chapterProgress = (s - chapter.start) / (chapter.end - chapter.start);
  if (s < INFLATION_END_STORY) {
    const f = s / INFLATION_END_STORY;
    const logT = INFLATION_LOG_T[0] + (INFLATION_LOG_T[1] - INFLATION_LOG_T[0]) * f;
    return {
      story: s,
      chapterIndex,
      chapterProgress,
      tSec: 10 ** logT,
      tempK: null,
      kTeV: null,
      efolds: INFLATION_EFOLDS * f,
      modelDependent: true
    };
  }
  const tempK = 10 ** interpolateKeys(TEMPERATURE_KEYS, s);
  const tSec = timeAtTemperature(tempK);
  return {
    story: s,
    chapterIndex,
    chapterProgress,
    tSec,
    tempK,
    kTeV: tempK * K_B_EV_PER_K,
    efolds: null,
    modelDependent: tSec < 1e-11
  };
}

/** First story time at which the temperature falls to `tempK` (for tests and markers). */
export function storyAtTemperature(tempK: number): number {
  const target = Math.log10(tempK);
  for (let i = 1; i < TEMPERATURE_KEYS.length; i += 1) {
    const [s0, v0] = TEMPERATURE_KEYS[i - 1];
    const [s1, v1] = TEMPERATURE_KEYS[i];
    if (target <= v0 && target >= v1) {
      return s0 + ((s1 - s0) * (v0 - target)) / (v0 - v1);
    }
  }
  return target > TEMPERATURE_KEYS[0][1] ? TEMPERATURE_KEYS[0][0] : STORY_DURATION;
}

/** Cosmic time when weak interactions freeze out (kT ≈ 0.8 MeV), used by the neutron fraction. */
export const WEAK_FREEZE_TIME_S = timeAtTemperature(0.8e6 / K_B_EV_PER_K);

// ---------- Formatting ----------

export { formatScientific, superscript } from "../../core/sciFormat";

const YEAR_S = 3.156e7;

export function formatCosmicTime(tSec: number): string {
  if (tSec < 1e-3) {
    return `${formatScientific(tSec)} s`;
  }
  if (tSec < 1) {
    return `${sig(tSec * 1000)} ms`;
  }
  if (tSec < 120) {
    return `${sig(tSec)} s`;
  }
  if (tSec < 7200) {
    return `${sig(tSec / 60)} min`;
  }
  if (tSec < YEAR_S) {
    return `${formatScientific(tSec / 86400)} days`;
  }
  const years = tSec / YEAR_S;
  if (years < 1e3) {
    return `${sig(years)} yr`;
  }
  if (years < 1e6) {
    return `${Math.round(years / 1e3).toLocaleString("en-US")},000 yr`;
  }
  return `${sig(years / 1e6)} million yr`;
}

export function formatTemperature(tempK: number): string {
  if (tempK < 1e5) {
    return `${sig(tempK)} K`;
  }
  return `${formatScientific(tempK)} K`;
}

export function formatEnergy(eV: number): string {
  const units: [number, string][] = [
    [1e9, "GeV"],
    [1e6, "MeV"],
    [1e3, "keV"],
    [1, "eV"],
    [1e-3, "meV"]
  ];
  if (eV >= 1e12) {
    return `${formatScientific(eV / 1e9)} GeV`;
  }
  for (const [scale, unit] of units) {
    if (eV >= scale) {
      return `${sig(eV / scale)} ${unit}`;
    }
  }
  return `${sig(eV / 1e-3)} meV`;
}
