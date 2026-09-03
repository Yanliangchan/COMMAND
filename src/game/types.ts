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

export type PlayerId = 'SABRE' | 'VANGUARD';

export function otherPlayer(p: PlayerId): PlayerId {
  return p === 'SABRE' ? 'VANGUARD' : 'SABRE';
}

// ---------------------------------------------------------------------------
// Grid references
//
// Phase 4a: the UI used to print raw "(x, y)" tuples in half a dozen places and
// nothing at all in the others. There is now ONE map-sheet coordinate scheme —
// lettered columns, numbered rows, 1-based — used by the movement preview, the
// order log, the battle report, contact markers and the unit card alike.
// 72 columns => A..Z, AA..AZ, BA..BT.
// ---------------------------------------------------------------------------

export function columnLabel(x: number): string {
  let out = '';
  let n = x;
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Player-facing reference for a tile, e.g. "H-42". */
export function gridRef(x: number, y: number): string {
  return `${columnLabel(x)}-${y + 1}`;
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
  | 'GUARDS'
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
  /**
   * Nominal passive detection radius (tiles) over level, open ground. The real
   * spotting rules live in detection.ts and modify this by terrain, elevation
   * and line of sight; this mirrors DETECTION[type].baseRange so the unit card
   * and the bot can quote one number without importing the detection model.
   */
  sightRadius: number;
  /** Nominal radius of a deliberate Recon sweep — mirrors DETECTION[type].reconRange. */
  reconRadius: number;
  isNaval: boolean;
  /**
   * Ready rounds carried. null = this formation does not use ammunition at all
   * (every land formation except the guns). See Formation.ammo.
   */
  maxAmmo: number | null;
  /** Movement actions this formation may take per round (see MOVES_PER_ROUND). */
  movesPerRound: number;
}

/**
 * ---------------------------------------------------------------------------
 * MOBILITY MODEL (phase 4a)
 * ---------------------------------------------------------------------------
 * Every formation has exactly two published movement numbers, both shown on
 * the unit card:
 *
 *   Movement Range   — movement points for ONE movement action. One point
 *                      crosses one ordinary (grass/open) tile, so the range is
 *                      quoted to the player in tiles.
 *   Movement Actions — how many separate bounds it may make per round.
 *
 * Base range follows the formation's OPERATIONAL ROLE, not a crude
 * combat/support split. The previous model gave artillery and engineers
 * 3 range x 1 action = 3 tiles a round while armour had 5 x 2 = 10, which is
 * exactly why the guns and the bridging plant were always left behind. They
 * now get 4 x 2 = 8, close enough to keep station with the manoeuvre element
 * they support without becoming a manoeuvre element themselves.
 *
 * `roadCost` is what one ROAD tile costs instead of its terrain cost, so a
 * road is a real, published multiplier rather than a hidden fudge:
 *   infantry 4 range / 0.65 = 6 tiles along a road (4 off it)
 *   armour   5 range / 0.50 = 10 tiles along a road (5 off it)
 * `roughMultiplier` is the surcharge heavy tracked formations pay in forest,
 * urban and industrial tiles — it is why armour is "fast on roads and open
 * ground" specifically, and it is itemised in the movement preview.
 */
export interface MobilityProfile {
  /** Movement points per movement action; 1 point = 1 ordinary tile. */
  moveRange: number;
  /** Movement actions per round. */
  movesPerRound: number;
  /** Cost of entering a road tile (land formations). */
  roadCost: number;
  /** Multiplier applied to forest / urban / industrial tiles. 1 = no penalty. */
  roughMultiplier: number;
  /** Short label for the unit card, e.g. "Mechanised". */
  mobilityLabel: string;
}

export const MOBILITY: Record<FormationType, MobilityProfile> = {
  INFANTRY: { moveRange: 4, movesPerRound: 2, roadCost: 0.65, roughMultiplier: 1, mobilityLabel: 'Foot / motorised' },
  COMMANDO: { moveRange: 6, movesPerRound: 3, roadCost: 0.7, roughMultiplier: 1, mobilityLabel: 'Light / heliborne' },
  GUARDS: { moveRange: 6, movesPerRound: 3, roadCost: 0.7, roughMultiplier: 1, mobilityLabel: 'Air-assault / heliborne' },
  ARMOUR: { moveRange: 5, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.5, mobilityLabel: 'Tracked / mechanised' },
  ARTILLERY: { moveRange: 4, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.25, mobilityLabel: 'Self-propelled / towed' },
  ENGINEER: { moveRange: 4, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.25, mobilityLabel: 'Mechanised plant' },
  RECON: { moveRange: 6, movesPerRound: 3, roadCost: 0.5, roughMultiplier: 1, mobilityLabel: 'Wheeled recce' },
  FRIGATE: { moveRange: 7, movesPerRound: 2, roadCost: 1, roughMultiplier: 1, mobilityLabel: 'Blue-water' },
  CORVETTE: { moveRange: 8, movesPerRound: 3, roadCost: 1, roughMultiplier: 1, mobilityLabel: 'Littoral' },
};

/** Back-compat view of the movement-action allowance (see MOBILITY). */
export const MOVES_PER_ROUND: Record<FormationType, number> = Object.fromEntries(
  Object.entries(MOBILITY).map(([k, v]) => [k, v.movesPerRound])
) as Record<FormationType, number>;

// ---------------------------------------------------------------------------
// MORALE MODEL (phase 4a)
//
// Morale is a long-term battlefield CONDITION, not a per-engagement resource.
// It is carried as a 0..100 number that each formation drifts back toward its
// own per-type baseline every round. Only major events push it off that
// baseline; routine movement and small engagements do essentially nothing.
// The five named bands are unchanged and still drive combat power.
// ---------------------------------------------------------------------------

/** Normal, "healthy formation in the field" morale each type settles at. */
export const MORALE_BASELINE: Record<FormationType, number> = {
  INFANTRY: 72,
  COMMANDO: 78,
  GUARDS: 78,
  ARMOUR: 74,
  ARTILLERY: 70,
  ENGINEER: 70,
  RECON: 70,
  FRIGATE: 74,
  CORVETTE: 72,
};

/** Lower bound of each band, highest first. */
export const MORALE_BANDS: { band: Morale; min: number }[] = [
  { band: 'Elite', min: 90 },
  { band: 'Steady', min: 60 },
  { band: 'Stressed', min: 44 },
  { band: 'Shaken', min: 28 },
  { band: 'Broken', min: 0 },
];

export function moraleBandFor(value: number): Morale {
  for (const b of MORALE_BANDS) if (value >= b.min) return b.band;
  return 'Broken';
}

/**
 * Casualty shock. Deliberately has a DEAD ZONE: a formation shrugging off a
 * light contact (<=15 strength lost) takes no morale damage at all, and only
 * genuinely heavy casualties bite.
 */
export const MORALE_CASUALTY_DEADZONE = 15;
export const MORALE_CASUALTY_SCALE = 0.5;

/**
 * Elan above the baseline has diminishing returns: the further a formation is
 * already riding above its normal morale, the less another success adds. This
 * is what stops a run of easy objective captures ratcheting the whole force to
 * Elite and parking it there — Elite has to be earned and cannot be farmed.
 */
export const MORALE_ELAN_CEILING = 20;

/**
 * Named shocks. Everything that can move morale by itself lives here.
 *
 * Phase 6: the two supply shocks (SUPPLY_CRITICAL / SUPPLY_LOW) and the
 * RESUPPLIED lift are gone with the supply system. Nothing replaced them —
 * a formation's condition is now its own (strength, readiness, morale), not a
 * function of how far it has walked from a depot.
 */
export const MORALE_SHOCKS = {
  ATTACK_REPULSED: -5, // a major attack that failed outright
  POSITION_LOST: -8, // driven off ground you were holding
  OBJECTIVE_LOST: -6, // an objective your side held changed hands (units near it)
  KEY_FORMATION_LOST: -7, // a friendly formation was destroyed nearby
  SURROUNDED: -4, // more enemy than friendly formations close by, per round
  ISOLATED: -3, // no friendly formation within COHESION_RADIUS, per round
  ASSAULT_SUCCESS: 6, // took the position
  OBJECTIVE_TAKEN: 8, // captured an objective
} as const;

/**
 * Per-round recovery toward baseline, additive, for a formation not engaged.
 * BASE absorbed the old IN_SUPPLY component (3 + 3) when supply was removed, so
 * a formation in the field recovers exactly as fast as a supplied one used to.
 */
export const MORALE_RECOVERY = {
  BASE: 6,
  HELD_POSITION: 2, // did not move this round (or is fortified)
  NEAR_FRIENDS: 2, // at least one friendly formation within COHESION_RADIUS
  /** Decay back down toward baseline when a unit is riding ABOVE it. */
  ABOVE_BASELINE_DECAY: 2,
} as const;

/**
 * Radius (tiles) inside which formations count as mutually supporting. Drives
 * the isolation shock, the morale recovery bonus, and the movement-side
 * "becoming separated from supported formation" advisory.
 */
export const COHESION_RADIUS = 6;

/**
 * Rounds of ammunition an artillery or naval formation recovers at the end of
 * a round in which it did NOT fire. With maxAmmo 3-4 this means roughly "fire,
 * fire, then sit a turn out" — visible on the unit card as a row of pips, with
 * no depot, no radius and no logistics order to manage.
 */
export const AMMO_REGEN_PER_ROUND = 1;

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
  /** Named morale band, derived from moraleValue — never set directly. */
  morale: Morale;
  /** Continuous 0-100 morale. See MORALE_BASELINE / MORALE_SHOCKS. */
  moraleValue: number;
  /** Baseline this formation drifts back toward when left alone. */
  moraleBaseline: number;
  /** Round in which this formation last took part in a fight (0 = never). */
  lastEngagedRound: number;
  readiness: number; // 0-100 %
  /**
   * AMMUNITION (phase 6) — whole ready rounds/fire missions, and ONLY for the
   * formations that shoot from a distance: artillery and the two naval
   * squadrons (`FormationDef.maxAmmo`). Everything else has maxAmmo === null
   * and carries 0 here; the unit card does not show the field at all.
   *
   * There is no depot dependency of any kind. A fire mission spends one round;
   * a formation that does not fire during a round gets AMMO_REGEN_PER_ROUND
   * back, up to its maximum. That is the whole system, and it exists for one
   * reason: to stop the guns and the ships firing every single turn forever.
   */
  ammo: number;
  /** Round this formation last spent ammunition (0 = never). */
  lastFiredRound: number;
  /** Movement actions already spent this round. */
  movesUsed: number;
  /** Movement actions allowed this round (from MOBILITY). */
  movesMax: number;
  /** True once the formation has spent its one non-movement ("major") action this round. */
  hasActedThisTurn: boolean;
  fortified: boolean; // dug in — bonus defense while true, cleared if it moves
  lastOrder: string; // human-readable description of the last action taken
  /**
   * Set by fog.ts on ENEMY formations only: the rung of the detection ladder
   * this viewer has reached. Undefined on your own formations. When it is
   * 'IDENTIFIED' the numeric fields above are REDACTED placeholders (-1) and
   * the identity strings are generic — never render them as facts.
   */
  intel?: DetectionLevel;
  /** True when this object was redacted for the viewer (intel below CONFIRMED). */
  redacted?: boolean;
}

// ---------------------------------------------------------------------------
// DETECTION MODEL (phase 4b)
//
// Spotting is PASSIVE and CONTINUOUS. Every friendly formation permanently
// watches its surroundings: if it has line of sight to an enemy and that enemy
// is inside its detection range, the enemy is detected — no action, no AP.
// The Recon order is an *amplifier* on top of that, not the way you see at all.
//
// What a side knows about a given enemy is a four-rung ladder:
//
//   UNKNOWN     nothing detected — the enemy is absent from the wire payload
//               entirely, not merely hidden in the UI.
//   CONTACT     something is there. Position only. Type, strength, identity
//               are NOT sent to the client (see fog.ts).
//   IDENTIFIED  the arm is known ("Enemy Infantry"). Strength, morale, ammo
//               and the true unit title are still withheld.
//   CONFIRMED   the exact formation is known, in full.
//
// The rung is derived from a 0-100 CONFIDENCE number, which rises with closer,
// better and repeated observation and decays once contact is lost.
// ---------------------------------------------------------------------------

export type DetectionLevel = 'UNKNOWN' | 'CONTACT' | 'IDENTIFIED' | 'CONFIRMED';

/** Lower confidence bound of each rung. */
export const DETECTION_THRESHOLDS = {
  CONTACT: 1,
  IDENTIFIED: 55,
  CONFIRMED: 85,
} as const;

export function detectionLevelFor(confidence: number): DetectionLevel {
  if (confidence >= DETECTION_THRESHOLDS.CONFIRMED) return 'CONFIRMED';
  if (confidence >= DETECTION_THRESHOLDS.IDENTIFIED) return 'IDENTIFIED';
  if (confidence >= DETECTION_THRESHOLDS.CONTACT) return 'CONTACT';
  return 'UNKNOWN';
}

export const DETECTION_LEVEL_LABEL: Record<DetectionLevel, string> = {
  UNKNOWN: 'Unknown',
  CONTACT: 'Contact',
  IDENTIFIED: 'Identified',
  CONFIRMED: 'Confirmed',
};

export interface DetectionProfile {
  /** Passive detection range in tiles over open, level ground. */
  baseRange: number;
  /** Range of a deliberate Recon sweep (the R order). */
  reconRange: number;
  /**
   * Multiplier on observation QUALITY — how quickly this formation climbs the
   * ladder from Contact to Identified to Confirmed. Recon and commandos not
   * only see further, they know what they are looking at sooner.
   */
  identifyFactor: number;
  /**
   * Confidence lost per round once contact is lost. Recon assets keep track of
   * a contact far longer than a line battalion does.
   */
  decayPerRound: number;
  /** Short player-facing description of this formation's sensor picture. */
  sensorLabel: string;
}

/**
 * Passive detection ranges. Recon and commandos see furthest; artillery, whose
 * crews are looking at their own gun line rather than the enemy, sees least.
 * Warships have good sensors but only over water and coast.
 */
export const DETECTION: Record<FormationType, DetectionProfile> = {
  INFANTRY: { baseRange: 5, reconRange: 8, identifyFactor: 1.0, decayPerRound: 22, sensorLabel: 'Eyes-on / battalion scouts' },
  COMMANDO: { baseRange: 7, reconRange: 11, identifyFactor: 1.2, decayPerRound: 16, sensorLabel: 'Deep recce patrols' },
  GUARDS: { baseRange: 5, reconRange: 8, identifyFactor: 1.0, decayPerRound: 20, sensorLabel: 'Air-assault recce screen' },
  ARMOUR: { baseRange: 5, reconRange: 7, identifyFactor: 0.95, decayPerRound: 24, sensorLabel: 'Vehicle optics / thermal' },
  ARTILLERY: { baseRange: 3, reconRange: 5, identifyFactor: 0.8, decayPerRound: 26, sensorLabel: 'Gun-line observation only' },
  ENGINEER: { baseRange: 4, reconRange: 6, identifyFactor: 0.85, decayPerRound: 25, sensorLabel: 'Route and obstacle recce' },
  RECON: { baseRange: 9, reconRange: 14, identifyFactor: 1.4, decayPerRound: 10, sensorLabel: 'Ground sensors, EW and UAV feed' },
  FRIGATE: { baseRange: 8, reconRange: 11, identifyFactor: 1.15, decayPerRound: 15, sensorLabel: 'Naval surveillance radar' },
  CORVETTE: { baseRange: 7, reconRange: 9, identifyFactor: 1.05, decayPerRound: 18, sensorLabel: 'Littoral surface search' },
};

/**
 * Reach of a SPECIAL_OP, in tiles, by formation. Both task forces field one
 * elite manoeuvre battalion that can mount one: SABRE's commandos insert
 * deepest (raid / deep probe), VANGUARD's Guards go in by helicopter as a
 * formed rifle sub-unit and so land closer to the friendly line.
 */
export const SPECIAL_OP_RANGE = 6;
export const SPECIAL_OP_RANGE_BY_TYPE: Partial<Record<FormationType, number>> = {
  COMMANDO: 6,
  GUARDS: 4,
};
/** Formation types that may mount a SPECIAL_OP at all. */
export const SPECIAL_OP_TYPES: FormationType[] = ['COMMANDO', 'GUARDS'];

/**
 * What a side knows about one enemy formation. Stored per player on the server.
 * `type` / `shortName` are populated ONLY at the rung that legitimately reveals
 * them — fog.ts refuses to put anything else on the wire.
 */
export interface Contact {
  formationId: string;
  owner: PlayerId;
  /** Current rung of the ladder. Never 'UNKNOWN' — those contacts are deleted. */
  level: DetectionLevel;
  /** 0-100. Rises with better/repeated observation, decays once sight is lost. */
  confidence: number;
  /** Last known position (NOT updated while contact is lost). */
  x: number;
  y: number;
  /** True when at least one friendly formation is observing it right now. */
  live: boolean;
  /** Round of the most recent live observation. */
  lastSeenTurn: number;
  /**
   * Round the confidence decay was last applied from. Separate from
   * lastSeenTurn so decay ticks exactly ONCE per round however many times the
   * spotting pass runs, while "last seen" stays truthful for the UI.
   */
  decayAnchorRound: number;
  /** Round in which confidence was last allowed to rise (once per round). */
  lastRiseRound: number;
  /** Confidence ceiling the best current observer can support. */
  ceiling: number;
  /** Confidence lost per round while contact is lost. */
  decayPerRound: number;
  /** Arm — present only at IDENTIFIED or better. */
  type?: FormationType;
  /** Short designation of the observing formation, for the contact report. */
  spottedBy?: string;
  /** How it was detected, e.g. "Visual contact", "ISR sweep". */
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
  /** Attacker's share of the total combat power after the roll, 0..1. This is
   *  the single number the whole result is derived from — see combat.ts. */
  share: number;
  /** True when this was a close assault (the only engagement that takes ground). */
  closeAssault: boolean;
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
/**
 * Victory-point threshold. Raised 200 -> 280 in phase 5: objectives on the
 * axis of advance are now worth two to three times a rear-area objective (see
 * mapgen "contested VP"), so a round of holding ground pays roughly 40% more
 * than it used to. Without the matching rise games ended around round 9-10 and
 * the second half of the operation never happened.
 */
export const VP_WIN_THRESHOLD = 280;
export const MAX_ROUNDS = 24;

export interface PlayerState {
  id: PlayerId;
  ap: number;
  vp: number;
  airSorties: number;
  contacts: Record<string, Contact>;
}

/**
 * One line of the operations log. `audience` is what makes the log safe to
 * broadcast: an entry describing a formation's own orders is only ever sent to
 * that side, while genuinely public events (turn changes, objective changes,
 * air strikes both sides watched) go to 'ALL'. Before phase 4b the log was a
 * plain string array sent verbatim to both players, which quietly narrated
 * every enemy move over the wire.
 */
export interface LogEntry {
  text: string;
  audience: PlayerId | 'ALL';
}

export interface GameState {
  round: number;
  activePlayer: PlayerId;
  /**
   * Which side had the initiative (moved first) this operation — rolled from
   * the map seed at setup. A round runs initiative-holder first, then the other
   * side; the round boundary, and with it VP scoring and victory adjudication,
   * therefore falls after the SECOND player's turn whichever side that is.
   */
  initiative: PlayerId;
  tiles: Tile[][]; // [y][x]
  formations: Record<string, Formation>;
  objectives: Objective[];
  players: Record<PlayerId, PlayerState>;
  log: LogEntry[];
  phase: 'PLAYING' | 'TURN_HANDOFF' | 'GAME_OVER';
  winner: PlayerId | 'DRAW' | null;
  lastBattleReport: BattleReport | null;
}
