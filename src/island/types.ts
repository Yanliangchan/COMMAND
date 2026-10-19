// ============================================================================
// ISLAND OPS — game state and rules constants.
// ============================================================================

import type { SectorId } from './map';

export type FactionId = 'ARMY' | 'NAVY' | 'AIRFORCE' | 'DIS';

export interface FactionDef {
  id: FactionId;
  name: string;
  short: string;
  color: string;
  /** Darker shade for borders, badges and text on light fills. */
  deep: string;
  motto: string;
  power: string;
  powerText: string;
}

export const FACTIONS: Record<FactionId, FactionDef> = {
  ARMY: {
    id: 'ARMY', name: 'Army', short: 'ARMY', color: '#5fa832', deep: '#2f5e16',
    motto: 'Ready, Decisive, Formidable',
    power: 'NS Call-Up', powerText: '+1 extra troop every Mobilise phase, on top of everything else.',
  },
  NAVY: {
    id: 'NAVY', name: 'Navy', short: 'RSN', color: '#2f5fd0', deep: '#16306f',
    motto: 'Beyond the Horizon',
    power: 'Amphibious Assault', powerText: 'Attack any enemy coastal region within reach of your coastal regions, across the water.',
  },
  AIRFORCE: {
    id: 'AIRFORCE', name: 'Air Force', short: 'RSAF', color: '#23b5d9', deep: '#0d5a6e',
    motto: 'Above All',
    power: 'Precision Strike', powerText: 'Once a turn, knock a troop off any enemy region on the island.',
  },
  DIS: {
    id: 'DIS', name: 'Digital & Intelligence', short: 'DIS', color: '#9150c8', deep: '#45206a',
    motto: 'Stronger Together',
    power: 'Signals Intelligence', powerText: 'Draw an Asset Card every turn, even without a capture, and every set you trade is worth +2 troops.',
  },
};

export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

export type CardKind = 'LAND' | 'SEA' | 'AIR' | 'WILD';

export interface Card {
  id: number;
  kind: CardKind;
  /** The SAF asset on the card face. */
  asset: string;
  /** Holding this region when the card is traded puts +2 troops on it. */
  region: string | null;
}

export const ASSETS: Record<Exclude<CardKind, 'WILD'>, string[]> = {
  LAND: ['Leopard 2SG', 'Hunter AFV', 'Bionix II', 'Terrex ICV', 'HIMARS', 'Pegasus Howitzer'],
  SEA: ['Formidable Frigate', 'Invincible Submarine', 'Littoral Mission Vessel', 'Endurance LST'],
  AIR: ['F-15SG', 'F-35B', 'AH-64D Apache', 'CH-47 Chinook', 'Hermes UAV'],
};

export type AttackMode = 'LAND' | 'AMPHIBIOUS';

export type Phase = 'MOBILISE' | 'ASSAULT' | 'REDEPLOY' | 'GAME_OVER';

export type MissionKind = 'SECTORS' | 'REGIONS' | 'ELIMINATE';

export interface Mission {
  kind: MissionKind;
  sectors?: SectorId[];
  regions?: number;
  target?: FactionId;
  text: string;
}

export interface Player {
  id: FactionId;
  human: boolean;
  alive: boolean;
  cards: Card[];
  mission: Mission;
  /** Captured at least one region this turn — earns a card at end of turn. */
  conquered: boolean;
  powerUsed: boolean;
  eliminatedBy?: FactionId;
}

export interface Holding {
  owner: FactionId;
  troops: number;
}

export interface DiceRoll {
  attacker: FactionId;
  defender: FactionId;
  from: string;
  to: string;
  atk: number[];
  def: number[];
  atkLoss: number;
  defLoss: number;
  /** +1 to the defender's highest die from a stronghold. */
  stronghold: boolean;
}

export type GameEvent =
  | { kind: 'BATTLE'; from: string; to: string; attacker: FactionId; defender: FactionId; rolls: DiceRoll[]; atkLoss: number; defLoss: number; captured: boolean; mode: AttackMode }
  | { kind: 'CAPTURE'; region: string; by: FactionId; from: FactionId }
  | { kind: 'SECTOR'; sector: SectorId; by: FactionId }
  | { kind: 'ELIMINATED'; who: FactionId; by: FactionId }
  | { kind: 'STRIKE'; region: string; by: FactionId; killed: number }
  | { kind: 'CARD'; who: FactionId; card: Card }
  | { kind: 'TRADE'; who: FactionId; troops: number }
  | { kind: 'TURN'; who: FactionId; round: number }
  | { kind: 'VICTORY'; who: FactionId; reason: string };

/** After a capture: `min` troops are already in `to`; MOVE_IN sets the total, min..max. */
export interface PendingMove {
  from: string;
  to: string;
  min: number;
  max: number;
}

export interface GameState {
  seed: number;
  rng: number;
  round: number;
  turnIndex: number;
  order: FactionId[];
  players: Record<FactionId, Player | undefined>;
  map: Record<string, Holding>;
  phase: Phase;
  reserve: number;
  /** Set right after a capture — the player must move troops in before anything else. */
  pendingMove: PendingMove | null;
  deck: Card[];
  discard: Card[];
  tradesDone: number;
  /** Incremented every action; UI uses it to key animations. */
  tick: number;
  events: { tick: number; event: GameEvent }[];
  log: { round: number; who: FactionId | null; text: string }[];
  winner: FactionId | null;
  winReason: string | null;
  stats: { attacks: number; captures: number; turns: number };
}

export type Action =
  | { type: 'PLACE'; region: string; count: number }
  | { type: 'TRADE'; cardIds: number[] }
  | { type: 'END_MOBILISE' }
  | { type: 'ATTACK'; from: string; to: string; blitz: boolean }
  | { type: 'MOVE_IN'; count: number }
  | { type: 'STRIKE'; region: string }
  | { type: 'END_ASSAULT' }
  | { type: 'REDEPLOY'; from: string; to: string; count: number }
  | { type: 'END_TURN' };

export const START_TROOPS: Record<number, number> = { 2: 32, 3: 28, 4: 24, 5: 20 };
export const MIN_REINFORCEMENT = 3;
export const ARMY_BONUS = 1;
export const STRIKE_DAMAGE = 1;
export const CARD_REGION_BONUS = 2;
/** DIS turns intelligence into manpower: every set it trades is worth this much more. */
export const DIS_TRADE_BONUS = 2;
export const MAX_HAND = 5;
export const AMPHIBIOUS_REACH = 230;
export const REGION_GOAL = 24;
/** Landing craft carry less: an amphibious assault rolls at most this many dice. */
export const AMPHIBIOUS_MAX_DICE = 3;
/** Safety valve: a stalemated game is decided on regions held after this round. */
export const MAX_ROUNDS = 40;

/** RISK's escalating trade-in values: 4, 6, 8, 10, 12, 15, then +5 each. */
export function tradeValue(tradesDone: number): number {
  const fixed = [4, 6, 8, 10, 12, 15];
  return tradesDone < fixed.length ? fixed[tradesDone] : 15 + 5 * (tradesDone - fixed.length + 1);
}
