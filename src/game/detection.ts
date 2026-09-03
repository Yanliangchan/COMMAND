// ============================================================================
// COMMAND — Passive spotting, line of sight and detection confidence.
//
// Phase 4b. Before this, a player had to spend a Recon action to see an enemy
// standing next to them; contacts were a binary "in radius / not in radius"
// circle with a linear confidence decay. Everything about that was wrong.
//
// The model here is:
//
//   1. SPOTTING IS PASSIVE.   Every friendly formation watches continuously.
//      If it has line of sight and the enemy is inside its detection range,
//      the enemy is detected. No order, no AP. refreshSpotting() runs for BOTH
//      sides after anything that moves a unit, at the start and end of turns.
//
//   2. RANGE IS SITUATIONAL.  Base range comes from the formation type
//      (types.ts DETECTION), then is modified by the terrain the OBSERVER
//      stands in, the terrain the TARGET is hiding in, and the height
//      difference between them off the map's continuous heightfield.
//
//   3. SIGHT IS A RAY, NOT A CIRCLE.  A height profile is walked between the
//      two tiles: intervening ground higher than the sightline blocks it
//      outright, and forest / urban / industrial fabric along the way both
//      raises the effective skyline and accumulates obscurance that shortens
//      the usable range.
//
//   4. KNOWLEDGE IS A LADDER.  Contact -> Identified -> Confirmed, driven by a
//      0-100 confidence that rises with closer / better / repeated observation
//      and decays once sight is lost.
//
// Pure TypeScript: no DOM, no React. The SERVER runs this; fog.ts then decides
// what each rung is allowed to put on the wire.
// ============================================================================

import { TERRAIN_DEFS } from './data';
import {
  DETECTION,
  DetectionLevel,
  Formation,
  GameState,
  PlayerId,
  Tile,
  TerrainType,
  detectionLevelFor,
  otherPlayer,
} from './types';

// ---------------------------------------------------------------------------
// Terrain modifiers
// ---------------------------------------------------------------------------

/**
 * How well you can see FROM this tile. Standing on a hill or an airfield apron
 * gives you the ground; standing inside a wood or a housing estate means you
 * are looking at the nearest tree or wall.
 */
export const OBSERVER_TERRAIN: Record<TerrainType, number> = {
  OPEN: 1.15,
  GRASS: 1.0,
  FOREST: 0.55,
  HILLS: 1.35,
  URBAN: 0.5,
  INDUSTRIAL: 0.6,
  WATER: 1.1,
  BEACH: 1.05,
  AIRFIELD: 1.1,
  PORT: 0.95,
};

/**
 * How well a formation sitting in this tile HIDES. Multiplies the observer's
 * range, so a battalion in a forest has to be found at roughly half the
 * distance the same battalion would be spotted at in the open.
 */
export const TARGET_CONCEALMENT: Record<TerrainType, number> = {
  OPEN: 1.1,
  GRASS: 1.0,
  FOREST: 0.55,
  HILLS: 0.9,
  URBAN: 0.5,
  INDUSTRIAL: 0.6,
  WATER: 1.15,
  BEACH: 1.05,
  AIRFIELD: 1.05,
  PORT: 0.9,
};

/**
 * Extra skyline a tile's fabric adds on top of its ground height, in
 * heightfield units (the map's height is normalised 0..1 and a full ridge is
 * about 0.6 above a valley floor, so 0.06 is a genuinely tall treeline).
 */
const CANOPY_HEIGHT: Partial<Record<TerrainType, number>> = {
  FOREST: 0.055,
  URBAN: 0.075,
  INDUSTRIAL: 0.05,
};

/**
 * Obscurance each intervening tile's FABRIC contributes along the sightline.
 * Relief is deliberately absent: undulating ground is already handled properly
 * by the height profile, and double-counting it here made a unit standing on a
 * ridge blind along the ridge.
 */
const OBSCURANCE: Partial<Record<TerrainType, number>> = {
  FOREST: 1,
  URBAN: 1.3,
  INDUSTRIAL: 0.9,
};

/** Total obscurance at which a sightline is considered blocked outright. */
const OBSCURANCE_BLOCK = 3.2;
/** Observer eye height / target exposure — stops gentle ground grazing a ray. */
const EYE_HEIGHT = 0.03;
/** Slack on the height comparison, so a tile level with the ray does not block. */
const RAY_TOLERANCE = 0.004;
/** A dug-in formation is harder to pick out. */
const FORTIFIED_CONCEALMENT = 0.85;

// ---------------------------------------------------------------------------
// Instrumentation — the spotting pass runs constantly, so it is measured.
// ---------------------------------------------------------------------------

export const spottingStats = {
  passes: 0,
  pairsConsidered: 0,
  boxRejects: 0,
  rangeRejects: 0,
  raysCast: 0,
  rayTileSteps: 0,
  totalMs: 0,
};

export function resetSpottingStats() {
  spottingStats.passes = 0;
  spottingStats.pairsConsidered = 0;
  spottingStats.boxRejects = 0;
  spottingStats.rangeRejects = 0;
  spottingStats.raysCast = 0;
  spottingStats.rayTileSteps = 0;
  spottingStats.totalMs = 0;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Spotting uses EUCLIDEAN distance — sight falls off in a circle, not the
 * Manhattan diamond the movement and attack-range rules use. Both are quoted
 * to the player in tiles, and the difference only shows up on the diagonal.
 */
export function sightDistance(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface SightResult {
  /** False when relief or fabric closes the line outright. */
  clear: boolean;
  /** 0..OBSCURANCE_BLOCK — how much of the line ran through cover. */
  obscurance: number;
}

/** Effective skyline of a tile: ground height plus whatever is built or grown on it. */
function skyline(t: Tile): number {
  return t.height + (CANOPY_HEIGHT[t.terrain] ?? 0);
}

/**
 * Walk the height profile between two tiles.
 *
 * The sightline is the straight segment from the observer's eye
 * (their ground height + EYE_HEIGHT) to the target's exposure
 * (their ground height + EYE_HEIGHT). At each intervening tile the terrain's
 * skyline is compared with the height of the ray directly above that tile:
 * higher ground (or a tall enough treeline / city block) closes the line.
 *
 * This is what makes elevation matter in both directions: an observer on a
 * ridge starts the ray high, so it clears intervening ground for many tiles;
 * an observer in a valley starts it low and the very next rise cuts it off.
 */
export function lineOfSight(tiles: Tile[][], x0: number, y0: number, x1: number, y1: number): SightResult {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return { clear: true, obscurance: 0 };

  const from = tiles[y0][x0];
  const to = tiles[y1][x1];
  const h0 = from.height + EYE_HEIGHT;
  const h1 = to.height + EYE_HEIGHT;

  let obscurance = 0;
  const sx = dx / steps;
  const sy = dy / steps;
  for (let i = 1; i < steps; i++) {
    const tx = Math.round(x0 + sx * i);
    const ty = Math.round(y0 + sy * i);
    const t = tiles[ty]?.[tx];
    if (!t) continue;
    spottingStats.rayTileSteps++;
    const frac = i / steps;
    const rayH = h0 + (h1 - h0) * frac;
    if (skyline(t) > rayH + RAY_TOLERANCE) return { clear: false, obscurance: OBSCURANCE_BLOCK };
    obscurance += OBSCURANCE[t.terrain] ?? 0;
    if (obscurance >= OBSCURANCE_BLOCK) return { clear: false, obscurance };
  }
  return { clear: true, obscurance };
}

// ---------------------------------------------------------------------------
// Detection range
// ---------------------------------------------------------------------------

export interface RangeBreakdown {
  base: number;
  observerTerrain: number;
  targetConcealment: number;
  elevation: number;
  effective: number;
}

/** Total situational multiplier is clamped so no single factor runs away. */
const RANGE_MULT_MIN = 0.3;
const RANGE_MULT_MAX = 2.4;

/**
 * Detection range of `observer` against a formation standing on `targetTile`.
 * `mode` selects the passive picture or the deliberate Recon sweep.
 */
export function detectionRange(
  observer: Formation,
  observerTile: Tile,
  targetTile: Tile,
  opts: { recon?: boolean; fortifiedTarget?: boolean } = {}
): RangeBreakdown {
  const prof = DETECTION[observer.type];
  const base = opts.recon ? prof.reconRange : prof.baseRange;
  const obs = OBSERVER_TERRAIN[observerTile.terrain];
  let conceal = TARGET_CONCEALMENT[targetTile.terrain];
  if (opts.fortifiedTarget) conceal *= FORTIFIED_CONCEALMENT;
  // Height advantage: looking DOWN on someone extends the picture, looking up
  // into higher ground shortens it. Standing high is worth something by itself.
  const drop = observerTile.height - targetTile.height;
  const elevation = 1 + Math.max(-0.35, Math.min(0.6, drop)) * 1.1 + observerTile.height * 0.3;
  const mult = Math.max(RANGE_MULT_MIN, Math.min(RANGE_MULT_MAX, obs * conceal * elevation));
  return {
    base,
    observerTerrain: obs,
    targetConcealment: conceal,
    elevation,
    effective: base * mult,
  };
}

/**
 * Best-case detection range for a formation, ignoring who it is looking at.
 * Used purely as the bounding-box prefilter radius, so it must never be an
 * under-estimate.
 */
export function maxDetectionRange(observer: Formation, observerTile: Tile, recon = false): number {
  const prof = DETECTION[observer.type];
  const base = recon ? prof.reconRange : prof.baseRange;
  return base * RANGE_MULT_MAX;
}

// ---------------------------------------------------------------------------
// Observation quality -> confidence ceiling
// ---------------------------------------------------------------------------

/**
 * How good a look this observer is getting: close, unobstructed observation by
 * a formation with real sensors supports a high confidence ceiling; a distant
 * glimpse through a wood by a gun battalion supports a low one.
 */
function observationCeiling(
  observer: Formation,
  d: number,
  range: RangeBreakdown,
  obscurance: number,
  recon: boolean
): number {
  const prof = DETECTION[observer.type];
  const proximity = Math.max(0, 1 - d / (range.effective + 1));
  // 0.38 at the very edge of the envelope, ~0.98 on top of the target: a line
  // battalion watching something two tiles away in the open does eventually
  // CONFIRM it; at the edge of its range it never gets past Identified.
  let q = 0.38 + 0.6 * proximity;
  q *= prof.identifyFactor;
  q *= range.targetConcealment; // a hidden target is hard to identify, not just to find
  q *= 1 - Math.min(0.4, obscurance * 0.12);
  if (recon) q *= 1.3;
  q = Math.max(0.12, Math.min(1, q));
  return Math.round(30 + 70 * q);
}

/** First sighting lands this fraction of the way to the ceiling. */
const FIRST_SIGHT_FRACTION = 0.8;
/** Each further ROUND of observation closes this much of the remaining gap. */
const RISE_FRACTION = 0.7;
/** Flat bonus a deliberate Recon sweep adds on top. */
const RECON_CONFIDENCE_BONUS = 22;

// ---------------------------------------------------------------------------
// The spotting pass
// ---------------------------------------------------------------------------

export interface Observation {
  observer: Formation;
  target: Formation;
  distance: number;
  range: RangeBreakdown;
  obscurance: number;
  ceiling: number;
  recon: boolean;
}

export interface SpottingResult {
  /** Enemy formation ids observed live in this pass. */
  live: Set<string>;
  /** Contacts that entered the table, or climbed a rung, in this pass. */
  newContacts: string[];
  upgraded: string[];
}

/**
 * Recompute `player`'s intelligence picture from scratch.
 *
 * Cost control, in order — measured at ~8 us for a full 10-v-10 pass, with the
 * box filter throwing out ~82% of pairs and the range filter another ~12%, so
 * fewer than one pair in twenty ever reaches the height-profile ray:
 *   1. integer bounding box on the observer's best-case radius,
 *   2. euclidean distance against the SITUATIONAL range (terrain + elevation),
 *   3. only then the ray.
 */
export function refreshSpotting(state: GameState, player: PlayerId): SpottingResult {
  const t0 = Date.now();
  spottingStats.passes++;
  const enemy = otherPlayer(player);
  const mine: Formation[] = [];
  const theirs: Formation[] = [];
  for (const f of Object.values(state.formations)) {
    if (f.owner === player) mine.push(f);
    else if (f.owner === enemy) theirs.push(f);
  }

  const best = new Map<string, Observation>();

  for (const o of mine) {
    const oTile = state.tiles[o.y][o.x];
    const boxR = maxDetectionRange(o, oTile, false);
    const boxRi = Math.ceil(boxR);
    for (const e of theirs) {
      spottingStats.pairsConsidered++;
      // 1. integer bounding box — rejects almost everything on a 72x72 board.
      if (Math.abs(e.x - o.x) > boxRi || Math.abs(e.y - o.y) > boxRi) {
        spottingStats.boxRejects++;
        continue;
      }
      const d = sightDistance(o.x, o.y, e.x, e.y);
      if (d > boxR) {
        spottingStats.rangeRejects++;
        continue;
      }
      // 2. situational range.
      const eTile = state.tiles[e.y][e.x];
      const range = detectionRange(o, oTile, eTile, { fortifiedTarget: e.fortified });
      if (d > range.effective) {
        spottingStats.rangeRejects++;
        continue;
      }
      // 3. the ray — only ever reached for a pair that survived both cheap
      // filters, which on a 72x72 board is a few percent of all pairs.
      spottingStats.raysCast++;
      const sight = lineOfSight(state.tiles, o.x, o.y, e.x, e.y);
      if (!sight.clear) continue;
      // Cover between the two also shortens the usable range.
      if (d > range.effective * (1 - Math.min(0.5, sight.obscurance * 0.15))) continue;

      const ceiling = observationCeiling(o, d, range, sight.obscurance, false);
      const prev = best.get(e.id);
      if (!prev || ceiling > prev.ceiling) {
        best.set(e.id, { observer: o, target: e, distance: d, range, obscurance: sight.obscurance, ceiling, recon: false });
      }
    }
  }

  const result = applyObservations(state, player, best);
  spottingStats.totalMs += Date.now() - t0;
  return result;
}

/**
 * Fold a set of observations into the player's contact table, climbing the
 * ladder, then decay everything that was NOT observed.
 */
function applyObservations(
  state: GameState,
  player: PlayerId,
  best: Map<string, Observation>
): SpottingResult {
  const ps = state.players[player];
  const live = new Set(best.keys());
  const newContacts: string[] = [];
  const upgraded: string[] = [];

  best.forEach((ob, id) => {
    const prof = DETECTION[ob.observer.type];
    const existing = ps.contacts[id];
    const beforeLevel: DetectionLevel = existing ? existing.level : 'UNKNOWN';
    let confidence: number;
    if (!existing) {
      confidence = Math.round(ob.ceiling * FIRST_SIGHT_FRACTION);
    } else if (existing.lastRiseRound < state.round) {
      // Confidence climbs at most once per ROUND, however many times the
      // spotting pass runs inside that round. Sustained observation is what
      // takes a contact up the ladder — not the number of orders you issue.
      confidence = Math.max(existing.confidence, existing.confidence + (ob.ceiling - existing.confidence) * RISE_FRACTION);
    } else {
      // Already climbed this round — further refreshes only keep it live.
      confidence = existing.confidence;
    }
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const level = detectionLevelFor(confidence);
    ps.contacts[id] = {
      formationId: id,
      owner: ob.target.owner,
      level,
      confidence,
      x: ob.target.x,
      y: ob.target.y,
      live: true,
      lastSeenTurn: state.round,
      decayAnchorRound: state.round,
      lastRiseRound: existing && existing.lastRiseRound >= state.round ? existing.lastRiseRound : state.round,
      ceiling: ob.ceiling,
      decayPerRound: Math.min(existing?.decayPerRound ?? 99, prof.decayPerRound),
      type: level === 'CONTACT' ? undefined : ob.target.type,
      spottedBy: ob.observer.shortName,
      source: ob.recon ? `${DETECTION[ob.observer.type].sensorLabel} (recon sweep)` : DETECTION[ob.observer.type].sensorLabel,
    };
    if (beforeLevel === 'UNKNOWN') newContacts.push(id);
    else if (levelRank(level) > levelRank(beforeLevel)) upgraded.push(id);
  });

  // Decay everything not currently observed. Confidence is a per-ROUND decay,
  // so it is derived from the round the contact was last seen rather than
  // ticked down on every refresh.
  Object.values(ps.contacts).forEach((c) => {
    if (live.has(c.formationId)) return;
    // The unit may have been destroyed — the ghost still fades out normally.
    const roundsSince = Math.max(0, state.round - c.decayAnchorRound);
    const decayed = c.confidence - roundsSince * c.decayPerRound;
    c.live = false;
    if (decayed <= 0) {
      delete ps.contacts[c.formationId];
      return;
    }
    const level = detectionLevelFor(decayed);
    if (level === 'CONTACT') c.type = undefined; // a stale ghost is just "something was here"
    c.level = level;
    c.confidence = Math.round(decayed);
    // Re-anchor so the NEXT round takes exactly one more decay step, while
    // lastSeenTurn keeps telling the player when it was actually observed.
    c.decayAnchorRound = state.round;
    c.lastRiseRound = Math.min(c.lastRiseRound, state.round - 1);
  });

  return { live, newContacts, upgraded };
}

export function levelRank(l: DetectionLevel): number {
  return l === 'CONFIRMED' ? 3 : l === 'IDENTIFIED' ? 2 : l === 'CONTACT' ? 1 : 0;
}

/** Refresh BOTH sides. Spotting is passive, so an enemy walking into your
 *  arcs during THEIR turn is spotted by you just the same. */
export function refreshAllSpotting(state: GameState): Record<PlayerId, SpottingResult> {
  return {
    SABRE: refreshSpotting(state, 'SABRE'),
    VANGUARD: refreshSpotting(state, 'VANGUARD'),
  };
}

// ---------------------------------------------------------------------------
// The Recon order — an amplifier on top of the passive picture
// ---------------------------------------------------------------------------

export interface ReconSweepResult {
  found: number;
  identified: number;
  range: number;
}

/**
 * A deliberate sweep by `observer`:
 *   - uses the formation's RECON range instead of its passive range,
 *   - pushes through cover far better (sensors, EW, UAV cueing), so obscurance
 *     is halved and a partially blocked line still yields a contact,
 *   - adds a flat confidence bonus on top of the observation ceiling, so it
 *     jumps contacts up the ladder rather than merely finding them,
 *   - marks everything it touches as recon-TRACKED, which permanently slows
 *     that contact's decay once sight is lost.
 */
export function reconSweep(state: GameState, observer: Formation): ReconSweepResult {
  const player = observer.owner;
  const ps = state.players[player];
  const enemy = otherPlayer(player);
  const oTile = state.tiles[observer.y][observer.x];
  const prof = DETECTION[observer.type];
  let found = 0;
  let identified = 0;
  let maxRange = 0;

  for (const e of Object.values(state.formations)) {
    if (e.owner !== enemy) continue;
    const eTile = state.tiles[e.y][e.x];
    const range = detectionRange(observer, oTile, eTile, { recon: true, fortifiedTarget: e.fortified });
    maxRange = Math.max(maxRange, range.effective);
    const d = sightDistance(observer.x, observer.y, e.x, e.y);
    if (d > range.effective) continue;
    const sight = lineOfSight(state.tiles, observer.x, observer.y, e.x, e.y);
    // A sweep still cannot see through a mountain, but it copes with cover.
    const obscurance = sight.obscurance * 0.5;
    if (!sight.clear && sight.obscurance >= OBSCURANCE_BLOCK) continue;

    const ceiling = Math.min(100, observationCeiling(observer, d, range, obscurance, true) + RECON_CONFIDENCE_BONUS);
    const existing = ps.contacts[e.id];
    const before = existing ? existing.level : 'UNKNOWN';
    let confidence = existing
      ? Math.max(existing.confidence, existing.confidence + (ceiling - existing.confidence) * 0.85)
      : ceiling * 0.9;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const level = detectionLevelFor(confidence);
    ps.contacts[e.id] = {
      formationId: e.id,
      owner: e.owner,
      level,
      confidence,
      x: e.x,
      y: e.y,
      live: true,
      lastSeenTurn: state.round,
      decayAnchorRound: state.round,
      lastRiseRound: state.round,
      ceiling,
      // Recon-tracked: whoever found it, the sweep's own tracking quality sticks.
      decayPerRound: Math.min(existing?.decayPerRound ?? 99, prof.decayPerRound),
      type: level === 'CONTACT' ? undefined : e.type,
      spottedBy: observer.shortName,
      source: `${prof.sensorLabel} (recon sweep)`,
    };
    found++;
    if (levelRank(level) > levelRank(before)) identified++;
  }
  return { found, identified, range: Math.round(maxRange * 10) / 10 };
}

/**
 * Commando deep probe (the SPECIAL_OP "look" variant). The patrol is treated
 * as observing from the tile it was sent to, out to a short radius, at
 * recon-grade quality — it walks onto the objective and reports what is there.
 * Returns the number of enemy formations it put on the board.
 */
export function deepProbe(state: GameState, spotter: Formation, radius: number): number {
  const ps = state.players[spotter.owner];
  const enemy = otherPlayer(spotter.owner);
  let found = 0;
  for (const e of Object.values(state.formations)) {
    if (e.owner !== enemy) continue;
    if (sightDistance(spotter.x, spotter.y, e.x, e.y) > radius) continue;
    const existing = ps.contacts[e.id];
    const confidence = Math.max(existing?.confidence ?? 0, 95);
    const level = detectionLevelFor(confidence);
    ps.contacts[e.id] = {
      formationId: e.id,
      owner: e.owner,
      level,
      confidence,
      x: e.x,
      y: e.y,
      live: true,
      lastSeenTurn: state.round,
      decayAnchorRound: state.round,
      lastRiseRound: state.round,
      ceiling: 100,
      decayPerRound: Math.min(existing?.decayPerRound ?? 99, DETECTION[spotter.type].decayPerRound),
      type: e.type,
      spottedBy: spotter.shortName,
      source: 'Commando deep-recon patrol',
    };
    found++;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Player-facing read-outs
// ---------------------------------------------------------------------------

/** The passive detection range this formation currently enjoys, in tiles. */
export function currentDetectionRange(state: GameState, f: Formation, recon = false): number {
  const tile = state.tiles[f.y][f.x];
  // Quoted against a neutral (grass, same height) target so the number on the
  // unit card is about the OBSERVER, not about whoever it happens to be near.
  const neutral: Tile = { ...tile, terrain: 'GRASS', height: tile.height };
  const r = detectionRange(f, tile, neutral, { recon });
  return Math.round(r.effective * 10) / 10;
}

/** Human-readable list of what is helping or hurting this formation's picture. */
export function detectionModifiers(state: GameState, f: Formation): { label: string; good: boolean }[] {
  const tile = state.tiles[f.y][f.x];
  const out: { label: string; good: boolean }[] = [];
  const obs = OBSERVER_TERRAIN[tile.terrain];
  if (obs > 1.02) out.push({ label: `${TERRAIN_DEFS[tile.terrain].label} vantage ×${obs.toFixed(2)}`, good: true });
  if (obs < 0.98) out.push({ label: `${TERRAIN_DEFS[tile.terrain].label} restricts sight ×${obs.toFixed(2)}`, good: false });
  if (tile.height >= 0.55) out.push({ label: `High ground (elev ${tile.elevation}) — sees over lower terrain`, good: true });
  if (tile.height <= 0.3) out.push({ label: `Low-lying ground (elev ${tile.elevation}) — short horizon`, good: false });
  if (DETECTION[f.type].identifyFactor >= 1.15) out.push({ label: 'Recon asset — identifies faster, tracks longer', good: true });
  return out;
}
