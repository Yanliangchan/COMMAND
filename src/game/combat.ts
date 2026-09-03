// ============================================================================
// COMMAND — Combat model (phase 6).
//
// ONE pure module that decides who hurts whom and by how much. It is imported
// by the engine (to resolve an attack), by the client (to draw the pre-attack
// odds preview) and by the bot (to score a candidate attack), so the number the
// player is shown before committing and the number the server resolves with
// come from literally the same code.
//
// ---------------------------------------------------------------------------
// THE FORMULA, IN FULL
// ---------------------------------------------------------------------------
// Two effective powers are built as a plain multiplicative chain. Every link is
// named, every link appears in the preview and in the battle report, and there
// are no unnamed links.
//
//   ATTACK  A = baseAttack
//             x strength/100
//             x readiness   (0.60 + readiness/100 x 0.40)
//             x morale      (Elite 1.25 … Broken 0.40)
//             x MATCHUP[attacker arm][defender arm][open|close ground]
//             x closeAssaultPenalty  (guns and ships fighting at arm's length)
//             x support     (+7% per adjacent complementary arm, cap +21%)
//
//   DEFENCE D = baseDefense
//             x strength/100
//             x readiness
//             x morale
//             x terrain     (TERRAIN_DEFS defenseBonus, e.g. urban +35%)
//             x fortification (dug in, x1.30)
//             x terrain affinity (infantry hold close country, armour does not)
//             x support     (+5% per adjacent friendly, cap +15%)
//
// A single bounded roll of +/-12% is applied to the attacker's power. Then:
//
//   share = A' / (A' + D)          0 = defender dominates, 1 = attacker does
//
// and LOSSES ARE PROPORTIONAL TO THE OPPONENT'S SHARE OF THE COMBAT POWER:
//
//   defender loses  2 x LOSS_BASE x share
//   attacker loses  2 x LOSS_BASE x (1 - share)
//
// An even fight (share 0.5) costs both sides LOSS_BASE. A 3:1 fight costs the
// loser three times what it costs the winner. Attacking therefore always costs
// something, which is the point. Standoff fire (a gun or a ship shooting from
// beyond assault range) scales the attacker's own losses down to a token
// counter-battery figure and the defender's down slightly — it is safe, and
// less decisive, and it can never take ground.
//
// This is deliberately legible arithmetic rather than an opaque curve: a player
// who reads "my 10 x 0.9 x 1.45 against their 7 x 1.35" can predict the result.
// ============================================================================

import { FORMATION_DEFS, MORALE_MULTIPLIER, TERRAIN_DEFS } from './data';
import {
  BattleFactor,
  DetectionLevel,
  Formation,
  FormationType,
  GameState,
  LossLevel,
  SUPPRESSION_HIT_DIRECT,
  SUPPRESSION_HIT_INDIRECT,
  Tile,
  suppressionMultiplier,
} from './types';

/** How much suppression a given kind of engagement inflicts on the defender. */
export function suppressionHitFor(closeAssault: boolean): number {
  return closeAssault ? SUPPRESSION_HIT_DIRECT : SUPPRESSION_HIT_INDIRECT;
}

// ---------------------------------------------------------------------------
// Tunables — every one of them is quoted to the player somewhere.
// ---------------------------------------------------------------------------

/** Strength percentage each side loses in a perfectly even close engagement. */
export const LOSS_BASE = 13;
/** Hard ceiling on one engagement's losses to either side. */
export const LOSS_CAP = 60;
/** Bounded combat roll, +/- this percentage, applied to the attacker's power. */
export const COMBAT_ROLL_PCT = 12;
/** Share of the combat power above which a close assault takes the ground. */
export const CAPTURE_SHARE = 0.65;
/** A stand-up assault is bloodier than a firefight. */
export const ASSAULT_INTENSITY = 1.15;
/** What the attacker's own losses are scaled to when it fires from standoff range. */
export const STANDOFF_RETURN_FIRE = 0.15;
/** What the defender's losses are scaled to under standoff fire (no ground taken). */
export const STANDOFF_EFFECT = 0.8;

// ---------------------------------------------------------------------------
// Unit-type matchups
// ---------------------------------------------------------------------------

/** Arms, for matchup purposes. */
export type CombatClass = 'INFANTRY' | 'ARMOUR' | 'ARTILLERY' | 'SUPPORT' | 'NAVAL';

export const COMBAT_CLASS: Record<FormationType, CombatClass> = {
  INFANTRY: 'INFANTRY',
  COMMANDO: 'INFANTRY',
  GUARDS: 'INFANTRY',
  ARMOUR: 'ARMOUR',
  ARTILLERY: 'ARTILLERY',
  ENGINEER: 'SUPPORT',
  RECON: 'SUPPORT',
  FRIGATE: 'NAVAL',
  CORVETTE: 'NAVAL',
};

export const COMBAT_CLASS_LABEL: Record<CombatClass, string> = {
  INFANTRY: 'infantry',
  ARMOUR: 'armour',
  ARTILLERY: 'guns',
  SUPPORT: 'support troops',
  NAVAL: 'warships',
};

/** Close country = the defender is in cover that breaks up a mechanised attack. */
export function isCloseTerrain(t: Tile): boolean {
  return t.terrain === 'FOREST' || t.terrain === 'URBAN' || t.terrain === 'INDUSTRIAL';
}

/**
 * THE MATCHUP TABLE. Attacker arm x defender arm, split by whether the defender
 * is standing in close country or in the open. This is where combined arms
 * comes from: it is not a bonus bolted onto the side of the maths, it IS the
 * maths.
 *
 *   armour smashes infantry in the open (1.45) and bogs down in a town (0.70)
 *   infantry are the arm that digs armour out of a town (1.30) and are poor
 *     against it in open country (0.85)
 *   guns are devastating against anything exposed (1.50 / 1.80) and nearly
 *     useless against a target under cover (0.80 / 0.65)
 *   everything mauls unescorted guns, engineers and sensors (the SUPPORT column)
 *   warships shoot up a coastline well and cannot reach into a city
 */
export const MATCHUP: Record<CombatClass, Record<CombatClass, { open: number; close: number }>> = {
  INFANTRY: {
    INFANTRY: { open: 1.0, close: 0.9 },
    ARMOUR: { open: 0.85, close: 1.3 },
    ARTILLERY: { open: 1.4, close: 1.3 },
    SUPPORT: { open: 1.35, close: 1.25 },
    NAVAL: { open: 0.5, close: 0.5 },
  },
  ARMOUR: {
    INFANTRY: { open: 1.45, close: 0.7 },
    ARMOUR: { open: 1.2, close: 0.75 },
    ARTILLERY: { open: 1.75, close: 0.95 },
    SUPPORT: { open: 1.7, close: 0.9 },
    NAVAL: { open: 0.4, close: 0.4 },
  },
  ARTILLERY: {
    INFANTRY: { open: 1.5, close: 0.8 },
    ARMOUR: { open: 1.1, close: 0.65 },
    ARTILLERY: { open: 1.8, close: 1.0 },
    SUPPORT: { open: 1.8, close: 1.0 },
    NAVAL: { open: 0.7, close: 0.7 },
  },
  SUPPORT: {
    INFANTRY: { open: 0.6, close: 0.5 },
    ARMOUR: { open: 0.5, close: 0.6 },
    ARTILLERY: { open: 0.8, close: 0.7 },
    SUPPORT: { open: 0.8, close: 0.7 },
    NAVAL: { open: 0.4, close: 0.4 },
  },
  NAVAL: {
    INFANTRY: { open: 1.3, close: 0.7 },
    ARMOUR: { open: 1.0, close: 0.6 },
    ARTILLERY: { open: 1.5, close: 0.85 },
    SUPPORT: { open: 1.5, close: 0.85 },
    NAVAL: { open: 1.2, close: 1.2 },
  },
};

/**
 * How well each arm DEFENDS the ground it is standing on. Infantry hold woods
 * and built-up areas far better than the raw terrain bonus alone suggests;
 * tanks and guns caught in one do worse.
 */
export const DEFENCE_AFFINITY: Record<CombatClass, { open: number; close: number }> = {
  INFANTRY: { open: 1.0, close: 1.2 },
  ARMOUR: { open: 1.15, close: 0.85 },
  ARTILLERY: { open: 0.8, close: 0.9 },
  SUPPORT: { open: 0.85, close: 0.95 },
  NAVAL: { open: 1.0, close: 1.0 },
};

/** Guns and ships fighting at arm's length are out of their element. */
export const CLOSE_ASSAULT_PENALTY: Partial<Record<CombatClass, number>> = {
  ARTILLERY: 0.5,
  NAVAL: 0.6,
  SUPPORT: 0.75,
};

/** Adjacent friendly arms that improve an attack, and by how much each. */
export const SUPPORT_PER_ARM = 0.07;
export const SUPPORT_CAP = 0.21;
export const DEFENCE_SUPPORT_PER_UNIT = 0.05;
export const DEFENCE_SUPPORT_CAP = 0.15;

// ---------------------------------------------------------------------------
// Condition multipliers
// ---------------------------------------------------------------------------

/** Readiness is a real but bounded multiplier: 100% -> x1.00, 0% -> x0.60. */
export function readinessMult(readiness: number): number {
  return 0.6 + (Math.max(0, Math.min(100, readiness)) / 100) * 0.4;
}

export function moraleMult(f: Formation): number {
  return MORALE_MULTIPLIER[f.morale] ?? 1;
}

/** Manhattan distance — the same metric movement, attack range and the rest of
 *  the game use, so "adjacent" means one tile orthogonally, everywhere. */
function adjacent(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1) <= 1;
}

/** Distinct complementary arms sitting next to `f` (its combined-arms support). */
export function supportingArms(state: GameState, f: Formation): CombatClass[] {
  const own = COMBAT_CLASS[f.type];
  const seen = new Set<CombatClass>();
  for (const o of Object.values(state.formations)) {
    if (o.owner !== f.owner || o.id === f.id) continue;
    if (!adjacent(o.x, o.y, f.x, f.y)) continue;
    const c = COMBAT_CLASS[o.type];
    if (c === own) continue; // more of the same arm is mass, not combined arms
    seen.add(c);
  }
  return [...seen];
}

/** Friendly formations adjacent to `f` — mutual support on the defence. */
export function adjacentFriendlies(state: GameState, f: Formation): number {
  return Object.values(state.formations).filter(
    (o) => o.owner === f.owner && o.id !== f.id && adjacent(o.x, o.y, f.x, f.y)
  ).length;
}

// ---------------------------------------------------------------------------
// The power chain
// ---------------------------------------------------------------------------

export interface PowerBreakdown {
  power: number;
  factors: BattleFactor[];
}

/**
 * Attacker's effective power. `defenderTile` is needed because the matchup
 * depends on the ground the DEFENDER is standing in, not the attacker's.
 */
export function attackPower(
  state: GameState,
  attacker: Formation,
  defender: Formation,
  defenderTile: Tile,
  closeAssault: boolean
): PowerBreakdown {
  const def = FORMATION_DEFS[attacker.type];
  const ac = COMBAT_CLASS[attacker.type];
  const dc = COMBAT_CLASS[defender.type];
  const close = isCloseTerrain(defenderTile);
  const factors: BattleFactor[] = [];

  let power = def.baseAttack;
  factors.push({ label: `${def.label} base attack`, positive: true, magnitude: def.baseAttack });

  const strengthMult = attacker.strength / 100;
  power *= strengthMult;
  if (strengthMult < 0.99)
    factors.push({ label: `Strength ${Math.round(attacker.strength)}%`, positive: false, magnitude: (1 - strengthMult) * 100 });

  const rm = readinessMult(attacker.readiness);
  power *= rm;
  if (rm < 0.995)
    factors.push({ label: `Readiness ${Math.round(attacker.readiness)}%`, positive: false, magnitude: (1 - rm) * 100 });

  const mm = moraleMult(attacker);
  power *= mm;
  if (mm !== 1) factors.push({ label: `Morale (${attacker.morale})`, positive: mm > 1, magnitude: Math.abs(mm - 1) * 100 });

  // Suppression (phase 7): a suppressed formation hits softer, up to -50% at
  // maximum suppression. Purely an attack-power effect — it never causes
  // casualties by itself, and it never touches the DEFENDER's resistance.
  const sm = suppressionMultiplier(attacker.suppression ?? 0);
  power *= sm;
  if (sm < 0.995)
    factors.push({ label: `Suppressed (${Math.round(attacker.suppression ?? 0)}%)`, positive: false, magnitude: (1 - sm) * 100 });

  const match = MATCHUP[ac][dc][close ? 'close' : 'open'];
  power *= match;
  factors.push({
    label: `${COMBAT_CLASS_LABEL[ac]} vs ${COMBAT_CLASS_LABEL[dc]} in ${close ? 'close country' : 'the open'}`,
    positive: match >= 1,
    magnitude: Math.abs(match - 1) * 100,
  });

  if (closeAssault) {
    const pen = CLOSE_ASSAULT_PENALTY[ac];
    if (pen) {
      power *= pen;
      factors.push({ label: `${COMBAT_CLASS_LABEL[ac]} in close assault`, positive: false, magnitude: (1 - pen) * 100 });
    }
  }

  const arms = supportingArms(state, attacker);
  const supportBonus = Math.min(SUPPORT_CAP, arms.length * SUPPORT_PER_ARM);
  if (supportBonus > 0) {
    power *= 1 + supportBonus;
    factors.push({
      label: `Combined arms — ${arms.map((a) => COMBAT_CLASS_LABEL[a]).join(' + ')} alongside`,
      positive: true,
      magnitude: supportBonus * 100,
    });
  }

  return { power: Math.max(0.1, power), factors };
}

/** Defender's effective resistance. */
export function defencePower(state: GameState, defender: Formation, tile: Tile): PowerBreakdown {
  const def = FORMATION_DEFS[defender.type];
  const dc = COMBAT_CLASS[defender.type];
  const close = isCloseTerrain(tile);
  const factors: BattleFactor[] = [];

  let power = def.baseDefense;
  factors.push({ label: `${def.label} base defence`, positive: true, magnitude: def.baseDefense });

  const strengthMult = defender.strength / 100;
  power *= strengthMult;
  if (strengthMult < 0.99)
    factors.push({ label: `Strength ${Math.round(defender.strength)}%`, positive: false, magnitude: (1 - strengthMult) * 100 });

  const rm = readinessMult(defender.readiness);
  power *= rm;
  if (rm < 0.995)
    factors.push({ label: `Readiness ${Math.round(defender.readiness)}%`, positive: false, magnitude: (1 - rm) * 100 });

  const mm = moraleMult(defender);
  power *= mm;
  if (mm !== 1) factors.push({ label: `Morale (${defender.morale})`, positive: mm > 1, magnitude: Math.abs(mm - 1) * 100 });

  const terrain = TERRAIN_DEFS[tile.terrain];
  if (terrain.defenseBonus !== 0) {
    power *= 1 + terrain.defenseBonus;
    factors.push({
      label: `${terrain.label} terrain`,
      positive: terrain.defenseBonus > 0,
      magnitude: Math.abs(terrain.defenseBonus) * 100,
    });
  }

  const affinity = DEFENCE_AFFINITY[dc][close ? 'close' : 'open'];
  if (affinity !== 1) {
    power *= affinity;
    factors.push({
      label: `${COMBAT_CLASS_LABEL[dc]} holding ${close ? 'close country' : 'open ground'}`,
      positive: affinity > 1,
      magnitude: Math.abs(affinity - 1) * 100,
    });
  }

  if (defender.fortified) {
    power *= 1.3;
    factors.push({ label: 'Dug in (fortified)', positive: true, magnitude: 30 });
  }

  const friends = adjacentFriendlies(state, defender);
  const supportBonus = Math.min(DEFENCE_SUPPORT_CAP, friends * DEFENCE_SUPPORT_PER_UNIT);
  if (supportBonus > 0) {
    power *= 1 + supportBonus;
    factors.push({
      label: `Mutual support — ${friends} friendly formation${friends === 1 ? '' : 's'} adjacent`,
      positive: true,
      magnitude: supportBonus * 100,
    });
  }

  return { power: Math.max(0.1, power), factors };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type Outcome = 'Position Captured' | 'Defender Repelled' | 'Attack Repulsed' | 'Mutual Attrition';

export interface Losses {
  attacker: number; // negative strength delta
  defender: number;
  share: number;
  outcome: Outcome;
  captured: boolean;
}

/** Turn a power share into the two strength deltas and the named outcome. */
export function lossesFromShare(share: number, closeAssault: boolean): Losses {
  const intensity = closeAssault ? ASSAULT_INTENSITY : 1;
  let defender = 2 * LOSS_BASE * share * intensity;
  let attacker = 2 * LOSS_BASE * (1 - share) * intensity;
  if (!closeAssault) {
    // Standoff fire: the target cannot reply in kind, and shellfire alone is
    // less decisive than closing with the position.
    attacker *= STANDOFF_RETURN_FIRE;
    defender *= STANDOFF_EFFECT;
  }
  attacker = Math.min(LOSS_CAP, attacker);
  defender = Math.min(LOSS_CAP, defender);

  let outcome: Outcome;
  let captured = false;
  if (share >= CAPTURE_SHARE && closeAssault) {
    outcome = 'Position Captured';
    captured = true;
  } else if (share >= 0.55) {
    outcome = 'Defender Repelled';
  } else if (share > 0.45) {
    outcome = 'Mutual Attrition';
  } else {
    outcome = 'Attack Repulsed';
  }
  return { attacker: -attacker, defender: -defender, share, outcome, captured };
}

export function lossFromDelta(delta: number): LossLevel {
  const d = Math.abs(delta);
  if (d < 2) return 'None';
  if (d < 10) return 'Light';
  if (d < 22) return 'Moderate';
  if (d < 40) return 'Heavy';
  return 'Destroyed';
}

// ---------------------------------------------------------------------------
// Pre-attack prediction (phase 6, §5)
//
// The SAME chain, resolved without a roll, plus an explicit uncertainty band.
// Two things widen that band:
//   1. the bounded combat roll (always, +/-12%)
//   2. how well the target is IDENTIFIED — a CONFIRMED formation is predicted
//      from its true numbers, an IDENTIFIED one from an assumption about a
//      battalion whose strength, morale, readiness and fortification the
//      player has NOT established.
// That is what recon now buys: certainty, not firepower. The engine resolves
// with the true values whichever rung you attack from.
// ---------------------------------------------------------------------------

/** What a player must assume about a formation they have identified but not confirmed. */
export const ASSUMED = { strength: 80, readiness: 85, morale: 'Steady' as const, moraleValue: 70 };

/** Extra +/- uncertainty on the power share, by how well the target is known. */
export const INTEL_UNCERTAINTY: Record<DetectionLevel, number> = {
  CONFIRMED: 0,
  IDENTIFIED: 0.3,
  CONTACT: 0.55,
  UNKNOWN: 0.55,
};

export const INTEL_NOTE: Record<DetectionLevel, string> = {
  CONFIRMED:
    'Target confirmed. Strength, morale and whether it is dug in are all established — this prediction is reliable.',
  IDENTIFIED:
    'Target identified by arm only. Its strength, morale and whether it is dug in are NOT established, so the prediction below is a wide estimate. Recon (R) to confirm it before you commit.',
  CONTACT:
    'Contact only — you do not know what is there. Anything could be in that position. Recon (R) before committing a battalion.',
  UNKNOWN: 'Nothing is established about this position.',
};

export interface Prediction {
  /** Deterministic power share, 0..1, at the middle of the band. */
  share: number;
  attackerPower: number;
  defenderPower: number;
  /** Expected strength loss, and the low/high bound of the band, per side. */
  attackerLoss: { mid: number; low: number; high: number };
  defenderLoss: { mid: number; low: number; high: number };
  likelyOutcome: Outcome;
  /** Outcome at the pessimistic and optimistic ends of the band. */
  worstOutcome: Outcome;
  bestOutcome: Outcome;
  closeAssault: boolean;
  canCapture: boolean;
  /** Suppression this engagement will apply to the defender (phase 7), 0..100. */
  suppressionApplied: number;
  intel: DetectionLevel;
  /** True when the band is wide because the target is not confirmed. */
  uncertain: boolean;
  factors: BattleFactor[];
  /** Things the player is being made to assume, spelled out. */
  assumptions: string[];
}

/**
 * Substitute the neutral assumption for every field a viewer has NOT earned.
 * On the client a redacted enemy arrives with -1 sentinels (see fog.ts); this
 * is the one place that turns them into something the maths can use, and it
 * records what was assumed so the preview can say so out loud.
 */
export function assumeUnknowns(target: Formation): { target: Formation; assumptions: string[] } {
  if (!target.redacted && target.strength >= 0) return { target, assumptions: [] };
  return {
    target: {
      ...target,
      strength: ASSUMED.strength,
      readiness: ASSUMED.readiness,
      morale: ASSUMED.morale,
      moraleValue: ASSUMED.moraleValue,
      moraleBaseline: ASSUMED.moraleValue,
      fortified: false,
    },
    assumptions: [
      `Strength assumed ${ASSUMED.strength}% — not established`,
      `Morale assumed ${ASSUMED.morale} — not established`,
      'Assumed NOT dug in — not established',
    ],
  };
}

export function predictEngagement(
  state: GameState,
  attacker: Formation,
  rawTarget: Formation,
  closeAssault: boolean,
  intel: DetectionLevel
): Prediction {
  const { target, assumptions } = assumeUnknowns(rawTarget);
  const defenderTile = state.tiles[target.y][target.x];
  const atk = attackPower(state, attacker, target, defenderTile, closeAssault);
  const def = defencePower(state, target, defenderTile);

  const share = atk.power / (atk.power + def.power);
  const band = COMBAT_ROLL_PCT / 100 + (INTEL_UNCERTAINTY[intel] ?? 0);
  // The band is expressed on the attacker's power, then converted to shares so
  // the numbers the player reads are the numbers the resolver produces.
  const lo = (atk.power * (1 - band)) / (atk.power * (1 - band) + def.power);
  const hi = (atk.power * (1 + band)) / (atk.power * (1 + band) + def.power);

  const mid = lossesFromShare(share, closeAssault);
  const low = lossesFromShare(lo, closeAssault);
  const high = lossesFromShare(hi, closeAssault);

  return {
    share,
    attackerPower: atk.power,
    defenderPower: def.power,
    attackerLoss: { mid: -mid.attacker, low: -high.attacker, high: -low.attacker },
    defenderLoss: { mid: -mid.defender, low: -low.defender, high: -high.defender },
    likelyOutcome: mid.outcome,
    worstOutcome: low.outcome,
    bestOutcome: high.outcome,
    closeAssault,
    canCapture: closeAssault,
    suppressionApplied: suppressionHitFor(closeAssault),
    intel,
    uncertain: (INTEL_UNCERTAINTY[intel] ?? 0) > 0,
    factors: [
      ...atk.factors.map((f) => ({ ...f, side: 'attacker' as const })),
      ...def.factors.map((f) => ({ ...f, side: 'defender' as const })),
    ],
    assumptions,
  };
}
