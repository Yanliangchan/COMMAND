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

// moveRange values are the per-action movement-point budget (see movement.ts) —
// each spent against terrain cost / roadCost, not a flat tile count. All nine
// were cut 10% at the user's request (e.g. infantry 4 -> 3.6) to slow the
// overall pace of manoeuvre uniformly; relative mobility between unit types
// is unchanged since every value scaled by the same factor.
export const MOBILITY: Record<FormationType, MobilityProfile> = {
  INFANTRY: { moveRange: 3.6, movesPerRound: 2, roadCost: 0.65, roughMultiplier: 1, mobilityLabel: 'Foot / motorised' },
  COMMANDO: { moveRange: 5.4, movesPerRound: 3, roadCost: 0.7, roughMultiplier: 1, mobilityLabel: 'Light / heliborne' },
  GUARDS: { moveRange: 5.4, movesPerRound: 3, roadCost: 0.7, roughMultiplier: 1, mobilityLabel: 'Air-assault / heliborne' },
  ARMOUR: { moveRange: 4.5, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.5, mobilityLabel: 'Tracked / mechanised' },
  ARTILLERY: { moveRange: 3.6, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.25, mobilityLabel: 'Self-propelled / towed' },
  ENGINEER: { moveRange: 3.6, movesPerRound: 2, roadCost: 0.5, roughMultiplier: 1.25, mobilityLabel: 'Mechanised plant' },
  RECON: { moveRange: 5.4, movesPerRound: 3, roadCost: 0.5, roughMultiplier: 1, mobilityLabel: 'Wheeled recce' },
  FRIGATE: { moveRange: 6.3, movesPerRound: 2, roadCost: 1, roughMultiplier: 1, mobilityLabel: 'Blue-water' },
  CORVETTE: { moveRange: 7.2, movesPerRound: 3, roadCost: 1, roughMultiplier: 1, mobilityLabel: 'Littoral' },
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
   * OVERWATCH (phase 7). Set true at the end of a round in which this
   * formation did NOT spend its major action (it may still have moved) —
   * see MORALE_RECOVERY-style end-of-round ticks in engine.ts `endTurn`.
   * While true, during the OPPONENT'S following turn the formation may fire
   * one reduced-power reaction shot at an enemy that moves into its
   * detection range and line of sight (see engine.ts `triggerOverwatch`).
   * Cleared at the start of this formation's own next turn, or immediately
   * once it spends its major action.
   */
  onAlert: boolean;
  /** True once this formation has spent its one reaction shot for the
   *  opponent's current turn. Reset whenever `onAlert` is (re)armed. */
  reactionFired: boolean;
  /**
   * SUPPRESSION (phase 7). 0-100, separate from strength/morale/readiness.
   * Applied by artillery, naval standoff fire and (at a smaller amount)
   * direct attacks; reduces this formation's OWN attack power and movement
   * range for as long as it lingers (see combat.ts / movement.ts). Never
   * causes strength loss by itself. Decays a fixed amount each round it is
   * not re-suppressed, faster in cover, slower in the open.
   */
  suppression: number;
  /** Round suppression was last applied (0 = never) — gates the decay tick. */
  lastSuppressedRound: number;
  /** Round this formation last used Reorganize (0 = never) — cooldown gate. */
  lastReorganizedRound: number;
  /**
   * PREPARED-DEFENCE TIERS (phase 9). 0 = Hasty (the base fortified bonus,
   * unchanged from before this phase), 1 = Prepared, 2 = Entrenched — see
   * FORTIFY_TIER_NAMES / FORTIFY_TIER_DEFENCE_MULT. Only meaningful while
   * `fortified` is true; climbs one tier per further consecutive round spent
   * doing nothing at all while already dug in, and is thrown back to 0 the
   * moment the formation moves (which also clears `fortified`, see
   * moveFormation), attacks, or spends its major action on anything else.
   */
  fortifyTier: number;
  /**
   * True for the round in which THIS formation issued Fortify (fresh dig-in
   * or a deliberate re-dig). Distinguishes "just fortified" (tier holds,
   * does not climb yet) from "held fortified doing nothing" (tier climbs) —
   * both leave `hasActedThisTurn` true, which alone cannot tell them apart.
   * Reset to false at the start of the formation's own next turn.
   */
  fortifiedThisRound: boolean;
  /**
   * VERTICAL INSERTION (phase 9). How many times this formation has used the
   * Vertical Insertion order this GAME (not per round) — capped at
   * VERTICAL_INSERT_MAX_USES. Commandos and Guards only.
   */
  verticalInsertsUsed: number;
  /**
   * LAST STAND (phase 11 §5). Fires ONCE per formation per game, the first
   * time its strength drops below LAST_STAND_THRESHOLD: a cornered unit
   * fights hardest, not just bleeds out. `lastStandTriggered` is the
   * permanent one-shot gate (never re-arms, even if strength later climbs
   * back above the threshold via Reorganize and then falls below it again).
   * `lastStandUntilRound` is the round through which the temporary combat
   * bonus (see combat.ts attackPower/defencePower) remains live — 0 when
   * never triggered or once it has lapsed. Both are ordinary intelligence:
   * redacted like fortifyTier at the IDENTIFIED rung (see fog.ts).
   */
  lastStandTriggered: boolean;
  lastStandUntilRound: number;
  /**
   * Set by fog.ts on ENEMY formations only: the rung of the detection ladder
   * this viewer has reached. Undefined on your own formations. When it is
   * 'IDENTIFIED' the numeric fields above are REDACTED placeholders (-1) and
   * the identity strings are generic — never render them as facts.
   */
  intel?: DetectionLevel;
  /** True when this object was redacted for the viewer (intel below CONFIRMED). */
  redacted?: boolean;
  /**
   * CONCEALMENT FROM STASIS (phase 12 §3). Consecutive ROUNDS this formation
   * has ended without spending a movement action — ticked in engine.ts
   * `endTurn` for the side finishing its turn, reset to 0 the instant the
   * formation actually moves (moveFormation / moveGroup / verticalInsert /
   * withdraw). detection.ts turns this into a further concealment multiplier
   * on top of terrain (see STATIONARY_CONCEALMENT_*) — a unit that has held
   * still is meaningfully harder to spot, never invisible. Intelligence like
   * everything else on this interface: redacted on an enemy formation below
   * CONFIRMED (see fog.ts), so the opponent never sees this number.
   */
  roundsStationary: number;
}

// ---------------------------------------------------------------------------
// LAST STAND (phase 11 §5)
// ---------------------------------------------------------------------------

/** Strength floor that arms the one-time last-stand bonus. */
export const LAST_STAND_THRESHOLD = 20;
/** Rounds (inclusive of the triggering round) the bonus remains live. */
export const LAST_STAND_DURATION_ROUNDS = 3;
/** Flat multiplier applied to BOTH attack and defence power while active. */
export const LAST_STAND_POWER_MULT = 1.22;

/** True while `f`'s one-time cornered-and-fighting-hard bonus is still live. */
export function isLastStandActive(f: Pick<Formation, 'lastStandUntilRound'>, round: number): boolean {
  return f.lastStandUntilRound > 0 && round <= f.lastStandUntilRound;
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
  /** Suppression applied to the defender by this engagement (phase 7), 0 if none. */
  suppressionApplied: number;
  /** Defender's fortify tier AT THE TIME of this engagement (phase 9), -1 when not fortified. */
  defenderFortifyTier: number;
  /** True when this was a clean, low-cost decisive win — see EXPLOITATION_AP_REBATE. */
  breakthroughBonus: boolean;
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
  | 'SPECIAL_OP'
  | 'REORGANIZE'
  | 'VERTICAL_INSERT'
  | 'UAV_RECON'
  | 'WITHDRAW';

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
  // Phase 7. Restores more than Fortify (dig in) and costs the same as a
  // committed Attack — it is a deliberate stand-down, not a free heal.
  REORGANIZE: 2,
  // Phase 9. A genuine leap over the whole board and over Zones of Control —
  // costed noticeably above SPECIAL_OP (3) so it reads as a rare, weighty
  // commitment rather than a fancier move order.
  VERTICAL_INSERT: 4,
  // Phase 9. Same tier as AIR (3) — a rare, player-level strategic asset in
  // the same weight class as calling in an air sortie, not a routine order
  // like RECON (1).
  UAV_RECON: 3,
  // Phase 12 §1. Deliberately the CHEAPEST movement-family order — see
  // "RETREAT / WITHDRAW" below for the full cost comparison against an
  // ordinary ZOC-disengaging Move.
  WITHDRAW: 1,
};

// ---------------------------------------------------------------------------
// RETREAT / WITHDRAW (phase 12 §1) — a real, honest way to pull a threatened
// formation out of a bad fight, distinct from ordinary Move.
//
// THE COST COMPARISON THE WHOLE ORDER EXISTS FOR:
//
// An ordinary Move that starts inside an enemy Zone of Control pays a
// "disengagement surcharge" on its very first step: that first step alone
// costs the formation's ENTIRE single-action movement budget
// (movement.ts `search`'s `disengageCost = movementProfile(f).effectiveRange`).
// Since one movement action buys exactly `effectiveRange` points, spending all
// of them on the first step leaves 0 points for that action to go any further
// — any actual repositioning beyond the immediate tile therefore needs a
// SECOND movement action, i.e. 2 x AP_COSTS.MOVE = 2 AP, to go anywhere at
// all. A formation with only one movement action left (movesMax 1, or none
// left this round) can be left unable to disengage by more than the
// surcharge-tile itself — trapped, exactly the trap this order exists to fix.
//
// WITHDRAW instead costs a single flat AP_COSTS.WITHDRAW (1 AP — cheaper than
// the 2 AP a ZOC-disengaging Move typically needs for the same repositioning)
// for a bounded retreat of up to WITHDRAW_RANGE_FRACTION of the formation's
// normal single-action range: shorter than a free move (this is breaking
// contact, not manoeuvring at will), but it explicitly does NOT pay the ZOC
// disengagement surcharge — see movement.ts `planWithdraw`. It still consumes
// one of the formation's movement actions for the round (movesUsed += 1,
// gated by movesRemaining exactly like Move) and it still walks the path
// tile by tile through `triggerOverwatch`, so a covering enemy formation gets
// its reaction shot regardless — this is a costed disengagement, not a free
// teleport out of danger.
// ---------------------------------------------------------------------------

/** Fraction of a formation's normal single-action movement range a Withdraw may use. */
export const WITHDRAW_RANGE_FRACTION = 0.6;
/** Strength below which a formation counts as "in a threatening situation" even with no enemy adjacent. */
export const WITHDRAW_STRENGTH_THRESHOLD = 35;
/** Morale bands that alone justify a Withdraw. */
export const WITHDRAW_MORALE_BANDS: readonly Morale[] = ['Shaken', 'Broken'];

// ---------------------------------------------------------------------------
// CONCEALMENT FROM STASIS (phase 12 §3) — a formation that has held its
// ground gets progressively harder to spot, layered into detection.ts as a
// further multiplier on TARGET_CONCEALMENT alongside terrain. Capped so a
// dug-in unit is meaningfully harder to find, never invisible.
// ---------------------------------------------------------------------------

/** Concealment bonus per consecutive round stationary (fraction of detection range cut). */
export const STATIONARY_CONCEALMENT_PER_ROUND = 0.06;
/** Rounds stationary at which the bonus caps — 4 rounds x 6% = 24% range reduction, floor 0.76. */
export const STATIONARY_CONCEALMENT_MAX_ROUNDS = 4;
/** Rounds a formation must have held still before the concealment bonus starts applying at all. */
export const STATIONARY_CONCEALMENT_MIN_ROUNDS = 1;

/** Detection-range multiplier from a target having held still for `rounds` consecutive rounds. */
export function stationaryConcealmentMultiplier(rounds: number): number {
  if (rounds < STATIONARY_CONCEALMENT_MIN_ROUNDS) return 1;
  const capped = Math.min(rounds, STATIONARY_CONCEALMENT_MAX_ROUNDS);
  return 1 - capped * STATIONARY_CONCEALMENT_PER_ROUND;
}

// ---------------------------------------------------------------------------
// REORGANIZE (phase 7) — a light restorative action, distinct from the
// supply/depot system removed in phase 6. It does not reintroduce logistics:
// there is no depot, no radius, nothing to manage. It is a battalion standing
// down for a round to reconstitute — replacements, maintenance, rest — at the
// cost of an action, gated so it cannot be spammed to erase combat losses.
// ---------------------------------------------------------------------------

/** Rounds that must pass after using Reorganize before the same formation can use it again. */
export const REORGANIZE_COOLDOWN_ROUNDS = 3;
/**
 * Restore values (phase 9 buff). Raised from the phase-7 baseline (25/12/6)
 * on direct user request for meaningfully higher numbers — see README
 * "Reorganize" for the before/after simulation that confirms the cooldown
 * (3 rounds) and the no-movement gate, not these numbers, remain the actual
 * constraint on how often a formation can shrug off combat losses.
 */
export const REORGANIZE_READINESS = 38;
/** Morale points restored (via the normal shock/diminishing-returns path). */
export const REORGANIZE_MORALE = 20;
/** Strength restored — representing replacements, still well short of a full heal. */
export const REORGANIZE_STRENGTH = 12;

/**
 * MUTUAL REORGANIZE (phase 9). When two ADJACENT friendly formations both
 * use Reorganize in the same round — in either order — each gets this extra
 * flat bump on top of its own solo restore values above. A flat bonus (over
 * e.g. halving the AP cost of the second one issued) because it composes
 * cleanly regardless of ordering and needs no AP refund bookkeeping — see
 * engine.ts `reorganizeAction`.
 */
export const MUTUAL_REORGANIZE_READINESS_BONUS = 10;
export const MUTUAL_REORGANIZE_MORALE_BONUS = 6;

// ---------------------------------------------------------------------------
// PREPARED-DEFENCE TIERS on Fortify (phase 9)
// ---------------------------------------------------------------------------

export const FORTIFY_TIER_NAMES = ['Hasty', 'Prepared', 'Entrenched'] as const;
export const FORTIFY_TIER_MAX = FORTIFY_TIER_NAMES.length - 1; // 2 = Entrenched
/** Defence multiplier by tier — tier 0 (Hasty) is the unchanged pre-phase-9 value. */
export const FORTIFY_TIER_DEFENCE_MULT: readonly number[] = [1.3, 1.45, 1.6];
/** Extra suppression-decay multiplier by tier — an entrenched position recovers composure faster. */
export const FORTIFY_TIER_SUPPRESSION_DECAY_MULT: readonly number[] = [1.0, 1.15, 1.3];

// ---------------------------------------------------------------------------
// EXPLOITATION BONUS (phase 9) — a clean, low-cost decisive win frees up a
// little more of the attacker's turn. Chosen as a 1 AP rebate rather than a
// bonus movement action because it is a one-line change against the shared
// AP pool, with no per-formation movesMax exception for the UI, the bot, or
// computeReachable to special-case.
// ---------------------------------------------------------------------------
export const EXPLOITATION_AP_REBATE = 1;

// ---------------------------------------------------------------------------
// VERTICAL / HELI INSERTION (phase 9) — Commandos and Guards only.
// ---------------------------------------------------------------------------

/** Manhattan-tile leap radius — deliberately wide: a genuine envelopment, not an extended move. */
export const VERTICAL_INSERT_RADIUS = 14;
/** Uses per formation, for the whole game (not per round). */
export const VERTICAL_INSERT_MAX_USES = 2;

// ---------------------------------------------------------------------------
// UAV RECON (phase 9) — a capped, player-level consumable, not a formation
// order. Flavoured as Heron 1 / Hermes 450 sorties (see data.ts).
// ---------------------------------------------------------------------------

/** Sorties per side, for the whole game. Does not regenerate. */
export const UAV_CHARGES_PER_GAME = 3;
/** Radius revealed by one sweep. */
export const UAV_SWEEP_RADIUS = 7;
/**
 * Confidence a sweep sets (floor, never lowers an existing higher value).
 * Comfortably above IDENTIFIED (55) so the arm is always revealed, but below
 * CONFIRMED (85) so a UAV pass alone does not hand the player a fully solved
 * board — it identifies reliably, the way the spec asks, without making
 * ground recon or Recon sweeps redundant.
 */
export const UAV_SWEEP_CONFIDENCE = 78;
/** How fast a UAV-sourced contact decays once the sweep round has passed. */
export const UAV_DECAY_PER_ROUND = 20;

// ---------------------------------------------------------------------------
// OVERWATCH / REACTION FIRE (phase 7)
// ---------------------------------------------------------------------------

/** Reaction fire's power multiplier vs. a normal attack — a snap shot, not a planned one. */
export const REACTION_FIRE_POWER_MULT = 0.55;
/** Reaction shots one on-alert formation may fire per opponent turn. */
export const REACTION_FIRE_MAX_PER_TURN = 1;

// ---------------------------------------------------------------------------
// SUPPRESSION (phase 7)
// ---------------------------------------------------------------------------

/** Suppression applied by a standoff hit (artillery fire mission, naval gunfire, air strike). */
export const SUPPRESSION_HIT_INDIRECT = 30;
/** Suppression applied by a direct attack (close assault) — a smaller, secondary effect. */
export const SUPPRESSION_HIT_DIRECT = 12;
/** Suppression lost per round it is not refreshed, on ordinary (non-cover, non-fortified) ground. */
export const SUPPRESSION_DECAY_BASE = 25;
/** Decay multiplier in cover (forest / urban / industrial) or while dug in — recovers faster. */
export const SUPPRESSION_DECAY_COVER_MULT = 1.5;
/** Decay multiplier in the open (open ground / beach) — lingers longer. */
export const SUPPRESSION_DECAY_OPEN_MULT = 0.7;
/** Ceiling on how much suppression can cut attack power / movement range (at 100 suppression). */
export const SUPPRESSION_MAX_PENALTY = 0.5;

/** Attack-power / movement-range multiplier for a given suppression level (0-100). */
export function suppressionMultiplier(suppression: number): number {
  const s = Math.max(0, Math.min(100, suppression));
  return 1 - (s / 100) * SUPPRESSION_MAX_PENALTY;
}

/**
 * AP economy (phase-1 rebalance): ten formations a side, each with 1-3
 * movement actions plus one major action, is roughly a 26-32 AP appetite per
 * round. 26 AP/turn keeps the budget slightly *under* the appetite so choices
 * matter, while making it very hard to sit on unspent AP.
 *
 * Phase 8: an eleventh formation (the second armour battalion, 48 SAR /
 * 42 SAR) adds roughly one more 2-move-plus-major-action appetite (~3-4 AP)
 * on top of that. Bumped 26 -> 28 (and the carry cap 34 -> 36, same +2
 * margin) to absorb it — a small, proportional lift that keeps the budget
 * under the new appetite rather than erasing the scarcity the AP pool is
 * for. Re-verified against the side-balance sim (see README) rather than
 * assumed.
 *
 * Phase 9: a twelfth formation (a second C4I battalion, 12 C4I Bn /
 * 16 C4I Bn) is a light, cheap-to-run formation compared to the armour
 * battalion phase 8 added — mostly Move + Recon, rarely Attack — but it
 * still has its own AP appetite (at least a movement action and, when it has
 * something to resolve, a Recon sweep). Bumped 28 -> 30 (cap 36 -> 38), the
 * SAME +2 margin phase 8 used, on the same reasoning: keep the budget
 * slightly under the new roster's appetite rather than erase the scarcity
 * the AP pool exists for. Re-verified against the paired side-balance sim
 * (see README "Side balance") using phase 8's own before/after methodology.
 */
export const AP_PER_TURN = 30;
export const AP_CAP = 38;
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

// ---------------------------------------------------------------------------
// MATCH RULES (phase 11 §4) — per-room configuration for private-room hosts.
// A default-rules match (vs-Bot, Quick Match, or a Create Room host who
// changes nothing) uses exactly the constants above, unchanged. Every engine
// function that used to read AP_PER_TURN / AP_CAP / VP_WIN_THRESHOLD /
// MAX_ROUNDS directly now reads state.rules instead, so a custom room and the
// default path are the SAME code path with different numbers, never a fork.
// ---------------------------------------------------------------------------

export interface MatchRules {
  apPerTurn: number;
  apCap: number;
  vpToWin: number;
  roundLimit: number;
}

export const DEFAULT_RULES: MatchRules = {
  apPerTurn: AP_PER_TURN,
  apCap: AP_CAP,
  vpToWin: VP_WIN_THRESHOLD,
  roundLimit: MAX_ROUNDS,
};

/** Server-side (and client-side, for the create-room form) validation bounds. */
export const RULES_BOUNDS = {
  apPerTurn: { min: 10, max: 80 },
  vpToWin: { min: 50, max: 2000 },
  roundLimit: { min: 4, max: 60 },
};

export function validateMatchRules(input: Partial<MatchRules>): { ok: true; rules: MatchRules } | { ok: false; reason: string } {
  const apPerTurn = input.apPerTurn ?? DEFAULT_RULES.apPerTurn;
  const vpToWin = input.vpToWin ?? DEFAULT_RULES.vpToWin;
  const roundLimit = input.roundLimit ?? DEFAULT_RULES.roundLimit;
  if (!Number.isFinite(apPerTurn) || apPerTurn < RULES_BOUNDS.apPerTurn.min || apPerTurn > RULES_BOUNDS.apPerTurn.max) {
    return { ok: false, reason: `AP per turn must be between ${RULES_BOUNDS.apPerTurn.min} and ${RULES_BOUNDS.apPerTurn.max}.` };
  }
  if (!Number.isFinite(vpToWin) || vpToWin < RULES_BOUNDS.vpToWin.min || vpToWin > RULES_BOUNDS.vpToWin.max) {
    return { ok: false, reason: `VP victory threshold must be between ${RULES_BOUNDS.vpToWin.min} and ${RULES_BOUNDS.vpToWin.max}.` };
  }
  if (!Number.isFinite(roundLimit) || roundLimit < RULES_BOUNDS.roundLimit.min || roundLimit > RULES_BOUNDS.roundLimit.max) {
    return { ok: false, reason: `Round limit must be between ${RULES_BOUNDS.roundLimit.min} and ${RULES_BOUNDS.roundLimit.max}.` };
  }
  // AP cap tracks the same +8 margin the phase-8/9 balance passes used —
  // never configurable directly, always derived from apPerTurn.
  return { ok: true, rules: { apPerTurn, apCap: apPerTurn + 8, vpToWin, roundLimit } };
}

export interface PlayerState {
  id: PlayerId;
  ap: number;
  vp: number;
  airSorties: number;
  contacts: Record<string, Contact>;
  /** UAV recon sorties remaining this GAME (phase 9) — see UAV_CHARGES_PER_GAME. */
  uavCharges: number;
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
  /** Round this entry was logged in — lets the replay view (phase 9) filter the log per round. */
  round: number;
}

/**
 * A formation's destruction (phase 7). Carried on GameState so both sides get
 * a clear, brief "kill marker" on the map and a log line — but redacted the
 * same way a live formation is: the owner always sees the full record, the
 * OTHER side sees only what their detection of that formation had actually
 * established (fog.ts derives this from the surviving contact record, since a
 * destroyed formation's contact ages out normally rather than vanishing).
 */
export interface KillEvent {
  id: string;
  formationId: string;
  owner: PlayerId;
  /** Present only when the viewer's detection had reached IDENTIFIED or better. */
  type?: FormationType;
  /** Full title / short designation — present only at CONFIRMED. */
  name: string;
  shortName: string;
  x: number;
  y: number;
  round: number;
}

/**
 * MATCH REPLAY (phase 9) — a compact positions-only snapshot taken at the
 * start of every round, on top of the existing `log` / `killFeed` the replay
 * UI already had (see components/Replay.tsx). Deliberately NOT a full
 * GameState snapshot per round — just enough to redraw where everything was.
 */
export interface ReplaySnapshotEntry {
  id: string;
  owner: PlayerId;
  type: FormationType;
  shortName: string;
  x: number;
  y: number;
  strength: number;
}
export interface ReplayRound {
  round: number;
  entries: ReplaySnapshotEntry[];
}

/**
 * COMBAT EVENTS (phase 12 §5) — a short, capped record of resolved
 * engagements, on GameState the same way killFeed is: enough for the client
 * to render a brief on-map effect (tracer/muzzle-flash for direct fire,
 * shell-burst for standoff/overwatch fire) timed with the existing combat
 * sound cue, WITHOUT the client having to peek at anything beyond what fog.ts
 * hands it. `attackerId`/`defenderId` let fog.ts decide, per viewer, whether
 * the OTHER participant's position may be included — see fog.ts
 * `redactCombatEvent`: a viewer's own formation is always at its true
 * position, but the opposing participant's position is included only if that
 * viewer's side has actually detected it, exactly the same "have you
 * legitimately earned this" gate used everywhere else in fog.ts.
 */
export interface CombatEvent {
  id: string;
  kind: 'direct' | 'standoff' | 'overwatch';
  attackerId: string;
  attackerOwner: PlayerId;
  attackerX: number;
  attackerY: number;
  defenderId: string;
  defenderOwner: PlayerId;
  defenderX: number;
  defenderY: number;
  round: number;
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
  /**
   * WHY the game ended, set alongside `winner` by checkVictory() — the
   * authoritative source, so the UI never has to re-derive it from VP/round
   * numbers (which could drift out of sync with the engine's own logic).
   * null until GAME_OVER. Public information (not fog-redacted) — both
   * players already see the final VP and round in the same payload.
   */
  winReason: 'VP_THRESHOLD' | 'ROUND_LIMIT' | null;
  lastBattleReport: BattleReport | null;
  /** Recent destructions, newest first, capped short — see KillEvent. */
  killFeed: KillEvent[];
  /** Recent resolved engagements, newest first, capped short — see CombatEvent. */
  combatEvents: CombatEvent[];
  /** Positions snapshot at the start of every round, for the post-game replay view. */
  replay: ReplayRound[];
  /** Effective AP/VP/round-limit for this match — see MatchRules. */
  rules: MatchRules;
  /** Curated scenario name (phase 11 §1), e.g. "Battle of Kampong Bukit Chandu". */
  mapName: string;
  /** Curated scenario seed this map was generated from. */
  mapSeed: number;
  /**
   * Short shareable code (phase 11 §6) this match's replay was saved under
   * once the game ended — set by the server after GAME_OVER, null before
   * then and in any context (sandbox, standalone sim) that never saves one.
   */
  replayCode: string | null;
}
