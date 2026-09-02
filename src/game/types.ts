// ============================================================================
// COMMAND — Core game types (pure TypeScript, no rendering dependencies).
// ============================================================================

export const GRID_SIZE = 60;

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
  | 'AIRFIELD'
  | 'PORT';

export interface TerrainDef {
  type: TerrainType;
  label: string;
  /** Base movement cost multiplier for a foot/vehicle formation crossing one tile. Infinity = impassable to land units. */
  moveCost: number;
  /** Defensive combat modifier, additive fraction e.g. 0.25 = +25% defense. */
  defenseBonus: number;
  /** Whether this tile blocks line of sight for spotting beyond it (partial). */
  blocksSight: boolean;
  elevation: number; // 0 = sea level, higher = more elevated (hills)
}

export interface Tile {
  x: number;
  y: number;
  terrain: TerrainType;
  elevation: number; // 0-3, used for shading; hills tiles typically 1-3
  road: boolean;
  river: boolean; // river segment (only meaningful on WATER tiles that are the river, not the sea)
  bridge: boolean; // a bridge (permanent or engineer-built) allows crossing a river/water tile
  depotOwner?: PlayerId; // supply depot present, and which side it originally belongs to (neutral start also allowed as undefined owner + isDepot)
  isDepot?: boolean;
  objectiveId?: string; // if this tile is a capture-point objective
  noiseSeed: number; // deterministic per-tile noise value 0..1 used for texture rendering
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
  | 'LOGISTICS'
  | 'NAVAL_TRANSPORT'
  | 'FRIGATE';

export type Morale = 'Elite' | 'Steady' | 'Stressed' | 'Shaken' | 'Broken';

export interface FormationDef {
  type: FormationType;
  label: string;
  branch: 'Army' | 'Air Force' | 'Navy';
  flavor: string; // real-world SAF-inspired flavor text — NOT authoritative org data, see README
  baseAttack: number;
  baseDefense: number;
  moveRange: number; // movement points per turn (fictional, balance-driven)
  sightRadius: number; // fog-of-war reveal radius (tiles)
  reconRadius: number; // radius when performing an explicit Recon action
  canEmbark: boolean; // can be ferried by naval transport
  isNaval: boolean;
  maxAmmo: number | null; // null = doesn't consume ammo (e.g. recon/engineer/logistics)
}

export interface Formation {
  id: string;
  owner: PlayerId;
  type: FormationType;
  name: string;
  x: number;
  y: number;
  strength: number; // 0-100 %
  morale: Morale;
  readiness: number; // 0-100 %
  supply: number; // 0-100 %
  ammo: number; // 0-100 %, meaningless if def.maxAmmo === null (kept at 100)
  hasActedThisTurn: boolean; // spent its one "major" action (move/attack/etc.) — formations may still be selected
  embarkedOn?: string; // id of naval transport formation carrying this unit, if any
  fortified: boolean; // dug in (from Engineer fortify action) — bonus defense while true, cleared if it moves
  lastOrder: string; // human-readable description of the last action taken, shown in UI
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
  source: string; // e.g. "Recon Sweep", "Visual Contact", "Commando Recon"
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export interface Objective {
  id: string;
  x: number;
  y: number;
  name: string;
  kind: 'Bridge' | 'Port' | 'Airfield' | 'Urban District' | 'Hill' | 'Supply Depot';
  controlledBy: PlayerId | null;
  vpPerTurn: number;
}

// ---------------------------------------------------------------------------
// Battle report
// ---------------------------------------------------------------------------

export interface BattleFactor {
  label: string;
  positive: boolean; // true = favors attacker
  magnitude: number; // informational, % contribution
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
  roll: number; // the random modifier applied, -15..+15
  factors: BattleFactor[];
  attackerLoss: LossLevel;
  defenderLoss: LossLevel;
  attackerStrengthDelta: number;
  defenderStrengthDelta: number;
  captured: boolean;
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
  | 'SPECIAL_OP'
  | 'AMPHIBIOUS';

export const AP_COSTS: Record<ActionKind, number> = {
  MOVE: 1,
  ATTACK: 2,
  RECON: 1,
  FORTIFY: 1,
  RESUPPLY: 1,
  ARTILLERY: 2,
  AIR: 3,
  ENGINEER_BRIDGE: 2,
  ENGINEER_CLEAR: 2,
  SPECIAL_OP: 3,
  AMPHIBIOUS: 3,
};

export const AP_PER_TURN = 15;
export const AP_CAP = 25;
export const AIR_SORTIES_PER_TURN = 2;
export const VP_WIN_THRESHOLD = 150;
export const MAX_ROUNDS = 20;

export interface PlayerState {
  id: PlayerId;
  ap: number;
  vp: number;
  airSorties: number;
  contacts: Record<string, Contact>; // known/suspected enemy contacts, keyed by formationId
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
