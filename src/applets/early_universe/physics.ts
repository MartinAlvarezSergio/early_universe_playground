import { nextRandom, Rng } from "./rng";

/**
 * Textbook constants and equilibrium formulas. Energies are in eV, kT means k_B·T.
 * Natural units (ħ = c = k_B = 1) inside the Saha formulas.
 */

export const K_B_EV_PER_K = 8.617333e-5;
export const ELECTRON_MASS_EV = 0.51099895e6;
export const NUCLEON_MASS_EV = 938.9e6;
/** Light-quark scale used only for the pair-creation threshold in the plasma (u, d current masses are a few MeV). */
export const LIGHT_QUARK_MASS_EV = 4e6;
/** Neutron–proton mass difference. */
export const NP_MASS_DIFF_EV = 1.293e6;
export const DEUTERON_BINDING_EV = 2.224e6;
export const HYDROGEN_BINDING_EV = 13.6;
/** He⁺ + e⁻ → He (second electron). */
export const HELIUM_I_BINDING_EV = 24.59;
/** He²⁺ + e⁻ → He⁺ (first electron). */
export const HELIUM_II_BINDING_EV = 54.42;
export const NEUTRON_LIFETIME_S = 879;
/** Baryon-to-photon ratio today (Planck 2018 ≈ 6.1 × 10⁻¹⁰). */
export const ETA_BARYON = 6.1e-10;
/** QCD crossover temperature from lattice QCD, ≈ 155 MeV (≈ 1.8 × 10¹² K). */
export const CONFINEMENT_KT_EV = 155e6;
/** Weak interactions stop converting neutrons ⇄ protons at kT ≈ 0.8 MeV (t ≈ 1 s). */
export const WEAK_FREEZE_KT_EV = 0.8e6;
const ZETA3 = 1.2020569;

/**
 * Photon energy in units of kT drawn from the Planck spectrum, number density ∝ x²/(eˣ − 1).
 * Exact: x²/(eˣ−1) = Σₙ x² e^(−n x), so pick term n with weight 1/n³ and draw x ~ Gamma(3, 1/n).
 */
export function samplePlanckX(r: Rng): number {
  let u = nextRandom(r) * ZETA3;
  let n = 1;
  while (n < 60) {
    u -= 1 / (n * n * n);
    if (u <= 0) {
      break;
    }
    n += 1;
  }
  const g = -Math.log((1 - nextRandom(r)) * (1 - nextRandom(r)) * (1 - nextRandom(r)));
  return g / n;
}

/** Fraction of blackbody photons with energy above xMin·kT. */
export function planckTailFraction(xMin: number): number {
  if (xMin <= 0) {
    return 1;
  }
  let sum = 0;
  for (let n = 1; n <= 30; n += 1) {
    const term = Math.exp(-n * xMin) * ((xMin * xMin) / n + (2 * xMin) / (n * n) + 2 / (n * n * n));
    sum += term;
    if (term < sum * 1e-12) {
      break;
    }
  }
  return sum / (2 * ZETA3);
}

/** log₁₀ of planckTailFraction, usable far into the tail where the fraction underflows. */
export function log10PlanckTail(xMin: number): number {
  if (xMin < 30) {
    return Math.log10(planckTailFraction(xMin));
  }
  // The n = 1 term dominates.
  return (-xMin + Math.log(xMin * xMin + 2 * xMin + 2) - Math.log(2 * ZETA3)) / Math.LN10;
}

/**
 * Neutron share of all nucleons, n/(n+p). In weak equilibrium n/p = e^(−Q/kT); after freeze-out
 * the free-neutron fraction only falls by β decay. Neutrons bound in nuclei stop decaying,
 * which the simulation handles by only decaying free neutrons.
 */
export function neutronFraction(kTeV: number, tSec: number, tFreezeSec: number): number {
  if (kTeV >= WEAK_FREEZE_KT_EV) {
    return 1 / (1 + Math.exp(NP_MASS_DIFF_EV / kTeV));
  }
  const xFreeze = 1 / (1 + Math.exp(NP_MASS_DIFF_EV / WEAK_FREEZE_KT_EV));
  return xFreeze * Math.exp(-Math.max(0, tSec - tFreezeSec) / NEUTRON_LIFETIME_S);
}

/**
 * Saha right-hand side S for capturing an electron with binding energy B:
 * x_e·x_ion/x_atom = S, with n_b = η·n_γ and n_γ = (2ζ(3)/π²) T³.
 * `gFactor` is the statistical-weight ratio g_ion·g_e/g_atom (1 for H and He⁺→He²⁺, 4 for He→He⁺).
 */
export function sahaS(kTeV: number, bindingEV: number, gFactor = 1): number {
  const logS =
    Math.log(gFactor) +
    Math.log((Math.PI * Math.PI) / (2 * ZETA3 * ETA_BARYON)) +
    1.5 * Math.log(ELECTRON_MASS_EV / (2 * Math.PI * kTeV)) -
    bindingEV / kTeV;
  return logS > 700 ? Infinity : Math.exp(logS);
}

/** Ionised fraction of a pure-hydrogen gas in Saha equilibrium: X²/(1−X) = S. */
export function sahaIonizedFraction(kTeV: number, bindingEV = HYDROGEN_BINDING_EV, gFactor = 1): number {
  const s = sahaS(kTeV, bindingEV, gFactor);
  if (!Number.isFinite(s)) {
    return 1;
  }
  return (-s + Math.sqrt(s * s + 4 * s)) / 2;
}

/**
 * Deuterium Saha ratio K = n_D / n_n,free for given free-proton fraction X_p:
 * K = X_p · η n_γ · (3/4) (4π / (m_N kT))^{3/2} e^{B_D/kT}. Deuterium survives once K ≳ 1,
 * which with ~1.6 billion photons per nucleon only happens near kT ≈ 0.07 MeV.
 */
export function deuteriumSahaK(kTeV: number, protonFraction: number): number {
  const nGamma = (2 * ZETA3) / (Math.PI * Math.PI) * kTeV ** 3;
  const logK =
    Math.log(Math.max(1e-9, protonFraction) * ETA_BARYON * nGamma * 0.75) +
    1.5 * Math.log((4 * Math.PI) / (NUCLEON_MASS_EV * kTeV)) +
    DEUTERON_BINDING_EV / kTeV;
  return logK > 700 ? Infinity : Math.exp(logK);
}
