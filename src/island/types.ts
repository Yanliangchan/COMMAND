// ============================================================================
// ISLAND OPS — game state, orders and tuning constants.
//
// Every Pasukan (task force) plans its round in secret and at the same time;
// the server — or, single-player, the client — resolves all orders together.
// No dice: battles are decided by strength, and the uncertainty comes from not
// knowing what the others ordered or exactly how strong they are.
// ============================================================================

import type { InstallationKind, ZoneId } from './map';

export type FactionId = 'SINGA' | 'HARIMAU' | 'HELANG' | 'JERUNG';

export interface FactionDef {
  id: FactionId;
  /** "Pasukan Singa" */
  name: string;
  short: string;
  animal: string;
  color: string;
  /** Darker shade for borders, badges and text on light fills. */
  deep: string;
  motto: string;
  doctrine: string;
  doctrineText: string;
  /** Real SAF battalions in this Pasukan's order of battle (see README: Formation naming). */
  battalions: string[];
  /** The RSN squadron its ships belong to. */
  squadron: string;
}

export const FACTIONS: Record<FactionId, FactionDef> = {
  SINGA: {
    id: 'SINGA', name: 'Pasukan Singa', short: 'SINGA', animal: 'Lion', color: '#e0483c', deep: '#7a1d15',
    motto: 'Majulah', doctrine: 'Total Mobilisation', doctrineText: '+1 troop every round.',
    battalions: ['1 SIR', '2 SIR', '40 SAR', '21 SA', '10 C4I Bn'], squadron: '185 SQN',
  },
  HARIMAU: {
    id: 'HARIMAU', name: 'Pasukan Harimau', short: 'HARIMAU', animal: 'Tiger', color: '#f29a1f', deep: '#7a4504',
    motto: 'Senyap, Pantas', doctrine: 'Ambush', doctrineText: '+1 strength whenever you defend. +1 recon a round, and you see exact enemy numbers along your borders.',
    battalions: ['3 SIR', '5 SIR', '41 SAR', '35 SCE', '11 C4I Bn'], squadron: '188 SQN',
  },
  HELANG: {
    id: 'HELANG', name: 'Pasukan Helang', short: 'HELANG', animal: 'Eagle', color: '#3d8ee8', deep: '#163e74',
    motto: 'Above All', doctrine: 'Air Superiority', doctrineText: '+1 air sortie every round.',
    battalions: ['8 SIR', '1 GDS', '42 SAR', '20 SA', '12 C4I Bn'], squadron: '189 SQN',
  },
  JERUNG: {
    id: 'JERUNG', name: 'Pasukan Jerung', short: 'JERUNG', animal: 'Shark', color: '#16a88f', deep: '#0a4d42',
    motto: 'Beyond the Horizon', doctrine: 'Sea Control', doctrineText: 'An extra ship, ships carry 2 more troops, and your naval gunfire hits twice as hard.',
    battalions: ['9 SIR', '1 CDO BN', '48 SAR', '30 SCE', '16 C4I Bn'], squadron: '191 SQN',
  },
};

export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface Holding {
  owner: FactionId;
  troops: number;
  /** The company holding it, e.g. "Charlie Coy, 40 SAR". */
  unit: string;
}

const COMPANIES = ['Alpha Coy', 'Bravo Coy', 'Charlie Coy', 'Support Coy'];

/** Every company in a Pasukan's ORBAT, in the order they're sent to hold ground. */
export function companies(f: FactionId): string[] {
  const out: string[] = [];
  for (const coy of COMPANIES) for (const bn of FACTIONS[f].battalions) out.push(`${coy}, ${bn}`);
  return out;
}

export interface Ship {
  id: string;
  /** e.g. "185 SQN · 2" */
  name: string;
  owner: FactionId;
  /** null while in drydock after being sunk. */
  zone: ZoneId | null;
  /** Rounds until a sunk ship can recommission at a naval base its owner holds. */
  repair: number;
}

export interface Player {
  id: FactionId;
  human: boolean;
  alive: boolean;
  vp: number;
  /** Regions revealed by recon this round (exact numbers, until the round resolves). */
  revealed: string[];
  reconsUsed: number;
  /** This round's orders once submitted; null while still planning. */
  orders: Order[] | null;
  eliminatedRound?: number;
}

export type Phase = 'PLANNING' | 'GAME_OVER';

export interface GameState {
  seed: number;
  rng: number;
  round: number;
  phase: Phase;
  factions: FactionId[];
  players: Partial<Record<FactionId, Player>>;
  map: Record<string, Holding>;
  ships: Ship[];
  /** The last round's resolution, for the playback and the recap. */
  lastReport: RoundReport | null;
  log: { round: number; who: FactionId | null; text: string }[];
  winner: FactionId | null;
  winReason: string | null;
  stats: { battles: number; captures: number };
}

// ---------------------------------------------------------------------------
// Orders — what a player submits for a round
// ---------------------------------------------------------------------------

export type Order =
  /** Put new troops down in one of your regions. */
  | { kind: 'DEPLOY'; region: string; count: number }
  /** March to a neighbouring region: reinforce it if yours, attack it if not. */
  | { kind: 'MOVE'; from: string; to: string; count: number }
  /** Ship troops across a sea zone you control, coast to coast. */
  | { kind: 'LAND'; from: string; to: string; zone: ZoneId; count: number }
  /** Sail a ship to a neighbouring zone. */
  | { kind: 'SAIL'; ship: string; to: ZoneId }
  /** Air sortie: bomb a region before the fighting. */
  | { kind: 'STRIKE'; region: string }
  /** Air sortie: close air support for whatever you fight at a region. */
  | { kind: 'CAS'; region: string };

// ---------------------------------------------------------------------------
// What one player is allowed to see
// ---------------------------------------------------------------------------

/** exact: a number · band: a range like 3–5 · hidden: nothing but the owner's colour */
export type Intel = { kind: 'exact'; troops: number } | { kind: 'band'; min: number; max: number } | { kind: 'hidden' };

export interface RegionView {
  owner: FactionId;
  intel: Intel;
  /** The holding company — known for your own ground and wherever you have exact intel. */
  unit: string | null;
}

export interface PlayerView {
  me: FactionId;
  round: number;
  phase: Phase;
  map: Record<string, RegionView>;
  /** Ships are public: a fleet at sea can't hide. */
  ships: Ship[];
  players: { id: FactionId; alive: boolean; vp: number; regions: number; ready: boolean }[];
  budget: Budget;
  reconsLeft: number;
  lastReport: RoundReport | null;
  winner: FactionId | null;
  winReason: string | null;
  log: GameState['log'];
  stats: GameState['stats'];
}

export interface Budget {
  troops: number;
  sorties: number;
  recons: number;
  /** How the troop figure is made up, for the HUD. */
  troopParts: { label: string; n: number }[];
}

// ---------------------------------------------------------------------------
// Round report — the resolution, step by step, for playback
// ---------------------------------------------------------------------------

export interface Side {
  owner: FactionId;
  /** The companies in the fight. */
  units: string[];
  troops: number;
  /** Strength = troops + these bonuses. */
  bonuses: { label: string; n: number }[];
  strength: number;
  /** Where an attacking force came from. */
  from: string[];
}

export type ReportStep =
  | { kind: 'NAVAL'; zone: ZoneId; sides: { owner: FactionId; ships: number }[]; winner: FactionId | null; sunk: Partial<Record<FactionId, number>> }
  | { kind: 'STRIKE'; by: FactionId; region: string; killed: number }
  | { kind: 'MOVES'; moves: { owner: FactionId; from: string; to: string; count: number; landing: boolean }[] }
  | { kind: 'FAILED'; owner: FactionId; text: string }
  | { kind: 'CLASH'; a: Side; b: Side; at: [string, string]; winner: FactionId | null }
  | { kind: 'BATTLE'; region: string; defender: Side | null; attackers: Side[]; winner: FactionId; captured: boolean; survivors: number }
  | { kind: 'RECOMMISSION'; owner: FactionId; zone: ZoneId }
  | { kind: 'SCORE'; gains: Partial<Record<FactionId, number>> }
  | { kind: 'ELIMINATED'; who: FactionId }
  | { kind: 'VICTORY'; who: FactionId; reason: string };

export interface RoundReport {
  round: number;
  steps: ReportStep[];
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const START_TROOPS_PER_REGION = 2;
export const HQ_TROOPS = 5;
export const BASE_INCOME = 3;
export const SINGA_BONUS = 1;
export const START_SHIPS = 2;
export const SHIP_CAPACITY = 3;
export const JERUNG_CAPACITY_BONUS = 2;
export const SHIP_REPAIR_ROUNDS = 2;
export const BASE_SORTIES = 1;
export const BASE_RECONS = 1;
export const STRIKE_DAMAGE = 2;
export const CAS_BONUS = 3;
export const NAVAL_GUNFIRE_BONUS = 1;
export const HARIMAU_AMBUSH_BONUS = 1;
export const DEFENCE_BONUS = 1;
export const STRONGHOLD_BONUS = 2;
export const VP_TARGET = 30;
export const MAX_ROUNDS = 15;

export const INSTALLATION_INCOME: Partial<Record<InstallationKind, number>> = { CITY: 2, INDUSTRY: 2, CAUSEWAY: 1 };
