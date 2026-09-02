// ============================================================================
// COMMAND — Core game types (pure TypeScript, no rendering dependencies).
// ============================================================================

/**
 * Battlefield grid edge length. Raised 60 -> 80 in phase 1, then trimmed to 72
 * in phase 3 (5,184 tiles, ~19% fewer than 80x80): the board reads better at a
 * glance and engagement distances tighten so the two forces meet sooner.
 * See README "Map generation".
 */
export const GRID_SIZE = 72;

export type PlayerId = 'BLUEFOR' | 'REDFOR';

export function otherPlayer(p: PlayerId): PlayerId {
  return p === 'BLUEFOR' ? 'REDFOR' : 'BLUEFOR';
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

export type TerrainType =
  | 'OPEN'
  | 'GRASS'
  | 'FOREST'
  | 'HILLS'
  | 'URBAN'
  | 'INDUSTRIAL'
  | 'WATER'
  | 'BEACH'
  | 'AIRFIELD'
  | 'PORT';

export interface TerrainDef {
  type: TerrainType;
  label: string;
  /** Base movement cost multiplier for a land formation crossing one tile. Infinity = impassable to land units. */
  moveCost: number;
  /** Defensive combat modifier, additive fraction e.g. 0.25 = +25% defense. */
  defenseBonus: number;
  /** Whether this tile blocks line of sight for spotting beyond it (partial). */
  blocksSight: boolean;
}

export interface Tile {
  x: number;
  y: number;
  terrain: TerrainType;
  /**
   * Quantised elevation band 0..5 (0 = sea/coastal flat, 5 = ridge crest).
   * Used for movement/defence reasoning and for relief shading.
   */
  elevation: number;
  /**
   * Continuous normalised height 0..1 straight off the generator heightfield,
   * rounded to 3dp. Kept in the wire state so the renderer can draw real
   * topographic contour lines rather than per-tile blocks.
   */
  height: number;
  /**
   * road / river / bridge / navigable are OPTIONAL and present only when true.
   * The map is 6,400 tiles and rides the wire inside GameState, so every
   * always-false field would cost ~90 KB per broadcast.
   */
  road?: boolean;
  river?: boolean; // river channel (from the drainage network, not the open sea)
  bridge?: boolean; // a bridge (permanent or engineer-built) lets land units cross a water tile
  /** True for WATER tiles that belong to the single connected navigable body. */
  navigable?: boolean;
  depotOwner?: PlayerId;
  isDepot?: boolean;
  objectiveId?: string; // if this tile is a capture-point objective
  /** Settlement id for urban/industrial tiles — lets the UI name districts. */
  settlement?: string;
}

// ---------------------------------------------------------------------------
// Formations (unit groups)
// ---------------------------------------------------------------------------

export type FormationType =
  | 'INFANTRY'
  | 'COMMANDO'
  | 'ARMOUR'
  | 'ARTILLERY'
  | 'ENGINEER'
  | 'RECON'
  | 'FRIGATE'
  | 'CORVETTE';

export type Morale = 'Elite' | 'Steady' | 'Stressed' | 'Shaken' | 'Broken';

export interface FormationDef {
  type: FormationType;
  label: string;
  branch: 'Army' | 'Navy';
  baseAttack: number;
  baseDefense: number;
  moveRange: number; // movement points per movement action (fictional, balance-driven)
  /** Direct/indirect engagement range in tiles (1 = must be adjacent). */
  attackRange: number;
  sightRadius: number; // fog-of-war reveal radius (tiles)
  reconRadius: number; // radius when performing an explicit Recon action
  isNaval: boolean;
  maxAmmo: number | null; // null = doesn't consume ammo
  /** Movement actions this formation may take per round (see MOVES_PER_ROUND). */
  movesPerRound: number;
}

/**
 * Per-unit, per-round movement-action allowance. This is a cap *on top of* the
 * AP budget — each movement action still costs AP_COSTS.MOVE — so a formation
 * can manoeuvre several times a round without movement becoming free.
 */
export const MOVES_PER_ROUND: Record<FormationType, number> = {
  INFANTRY: 2,
  COMMANDO: 3,
  ARMOUR: 2,
  ARTILLERY: 1,
  ENGINEER: 1,
  RECON: 3,
  FRIGATE: 2,
  CORVETTE: 3,
};

export interface Formation {
  id: string;
  owner: PlayerId;
  type: FormationType;
  /** Full formation title, e.g. "1st Battalion, Singapore Infantry Regiment". */
  name: string;
  /** Short designation used on the map and in tight UI, e.g. "1 SIR". */
  shortName: string;
  /** Echelon, e.g. "Battalion", "Squadron". */
  echelon: string;
  /** Arm / branch of service, e.g. "Infantry", "Armour", "Republic of Singapore Navy". */
  arm: string;
  /** Equipment flavour text — publicly known platform names only. */
  equipment: string;
  x: number;
  y: number;
  strength: number; // 0-100 %
  morale: Morale;
  readiness: number; // 0-100 %
  supply: number; // 0-100 %
  ammo: number; // 0-100 %, meaningless if def.maxAmmo === null (kept at 100)
  /** Movement actions already spent this round. */
  movesUsed: number;
  /** Movement actions allowed this round (from MOVES_PER_ROUND). */
  movesMax: number;
  /** True once the formation has spent its one non-movement ("major") action this round. */
  hasActedThisTurn: boolean;
  fortified: boolean; // dug in — bonus defense while true, cleared if it moves
  lastOrder: string; // human-readable description of the last action taken
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

export interface Contact {
  formationId: string;
  owner: PlayerId;
  type: FormationType;
  x: number;
  y: number;
  confidence: number; // 0-100, decays each turn since last seen
  lastSeenTurn: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export type ObjectiveKind =
  | 'Bridge'
  | 'Port'
  | 'Airfield'
  | 'Urban District'
  | 'Hill'
  | 'Supply Depot'
  | 'Anchorage';

export interface Objective {
  id: string;
  x: number;
  y: number;
  name: string;
  kind: ObjectiveKind;
  controlledBy: PlayerId | null;
  vpPerTurn: number;
  /** True for objectives that sit on navigable water — only naval units can hold them. */
  maritime?: boolean;
}

// ---------------------------------------------------------------------------
// Battle report
// ---------------------------------------------------------------------------

export interface BattleFactor {
  label: string;
  positive: boolean;
  magnitude: number;
  /** Which side the factor applied to. Set when the two lists are merged into
   *  the report, so the UI can explain *why* a result went the way it did. */
  side?: 'attacker' | 'defender';
}

export type LossLevel = 'None' | 'Light' | 'Moderate' | 'Heavy' | 'Destroyed';

export interface BattleReport {
  id: string;
  attackerId: string;
  defenderId: string;
  attackerName: string;
  defenderName: string;
  outcome: 'Position Captured' | 'Defender Repelled' | 'Attack Repulsed' | 'Mutual Attrition';
  attackerPower: number;
  defenderPower: number;
  roll: number;
  factors: BattleFactor[];
  attackerLoss: LossLevel;
  defenderLoss: LossLevel;
  attackerStrengthDelta: number;
  defenderStrengthDelta: number;
  captured: boolean;
  /** Tiles the engagement was fought over — the UI flashes them so the player
   *  can see the action the report describes. */
  attackerX: number;
  attackerY: number;
  defenderX: number;
  defenderY: number;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'MOVE'
  | 'ATTACK'
  | 'RECON'
  | 'FORTIFY'
  | 'RESUPPLY'
  | 'ARTILLERY'
  | 'AIR'
  | 'ENGINEER_BRIDGE'
  | 'ENGINEER_CLEAR'
  | 'SPECIAL_OP';

export const AP_COSTS: Record<ActionKind, number> = {
  MOVE: 1,
  ATTACK: 2,
  RECON: 1,
  FORTIFY: 1,
  RESUPPLY: 1,
  ARTILLERY: 2,
  AIR: 3,
  ENGINEER_BRIDGE: 2,
  ENGINEER_CLEAR: 1,
  SPECIAL_OP: 3,
};

/**
 * AP economy (phase-1 rebalance): ten formations a side, each with 1-3
 * movement actions plus one major action, is roughly a 26-32 AP appetite per
 * round. 26 AP/turn keeps the budget slightly *under* the appetite so choices
 * matter, while making it very hard to sit on unspent AP.
 */
export const AP_PER_TURN = 26;
export const AP_CAP = 34;
export const AIR_SORTIES_PER_TURN = 2;
export const VP_WIN_THRESHOLD = 200;
export const MAX_ROUNDS = 24;

export interface PlayerState {
  id: PlayerId;
  ap: number;
  vp: number;
  airSorties: number;
  contacts: Record<string, Contact>;
}

export interface GameState {
  round: number;
  activePlayer: PlayerId;
  tiles: Tile[][]; // [y][x]
  formations: Record<string, Formation>;
  objectives: Objective[];
  players: Record<PlayerId, PlayerState>;
  log: string[];
  phase: 'PLAYING' | 'TURN_HANDOFF' | 'GAME_OVER';
  winner: PlayerId | 'DRAW' | null;
  lastBattleReport: BattleReport | null;
}
