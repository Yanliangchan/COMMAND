// ============================================================================
// COMMAND — Movement model (phase 4a).
//
// ONE pure description of how a formation moves: what its range is, what a
// tile costs it, which tiles it can reach, the exact path to a hovered tile,
// what that path costs, how much of it was road, how many movement actions it
// burns — and, when a destination is refused, WHY.
//
// Everything the player is shown about movement (the unit card's "Movement:
// 5 tiles", the reachable wash, the hover path preview, the invalid-move
// explanation, the Move Formation pacing) is computed here, so the preview can
// never disagree with what the server will actually allow. No React, no DOM.
// ============================================================================

import { FORMATION_DEFS, TERRAIN_DEFS } from './data';
import {
  AP_COSTS,
  COHESION_RADIUS,
  Formation,
  FormationType,
  GameState,
  GRID_SIZE,
  MOBILITY,
  Tile,
  WITHDRAW_MORALE_BANDS,
  WITHDRAW_RANGE_FRACTION,
  WITHDRAW_STRENGTH_THRESHOLD,
  gridRef,
  moraleBandFor,
  suppressionMultiplier,
} from './types';

// ---------------------------------------------------------------------------
// Geometry helpers (duplicated from engine.ts on purpose — engine.ts imports
// this module, so this one must not import back).
// ---------------------------------------------------------------------------

export function manhattan(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

function inBounds(x: number, y: number) {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

function neighbors(x: number, y: number): [number, number][] {
  const out: [number, number][] = [];
  if (inBounds(x + 1, y)) out.push([x + 1, y]);
  if (inBounds(x - 1, y)) out.push([x - 1, y]);
  if (inBounds(x, y + 1)) out.push([x, y + 1]);
  if (inBounds(x, y - 1)) out.push([x, y - 1]);
  return out;
}

function occupantAt(state: GameState, x: number, y: number): Formation | undefined {
  for (const f of Object.values(state.formations)) if (f.x === x && f.y === y) return f;
  return undefined;
}

// ---------------------------------------------------------------------------
// Zones of Control (phase 7)
//
// Every LAND formation except artillery projects a ZOC into its four
// orthogonally adjacent tiles (artillery is not a manoeuvre element and does
// not contest ground this way; naval formations neither project nor are
// affected by ZOC — it is a land-warfare concept). An enemy formation MOVING
// through a ZOC tile has its bound end there — it may still enter and stop on
// a ZOC tile, but the search below refuses to use it as a step to anywhere
// else. Leaving a ZOC tile the mover STARTED in (disengaging) costs a full
// movement action's worth of points instead of the tile's ordinary price.
// ---------------------------------------------------------------------------

/** Tiles under enemy Zone of Control, from `mover`'s point of view. Empty for naval formations. */
export function zocTilesFor(state: GameState, mover: Formation): Set<string> {
  const out = new Set<string>();
  if (FORMATION_DEFS[mover.type].isNaval) return out;
  for (const o of Object.values(state.formations)) {
    if (o.owner === mover.owner) continue;
    const oDef = FORMATION_DEFS[o.type];
    if (oDef.isNaval || o.type === 'ARTILLERY') continue;
    for (const [nx, ny] of neighbors(o.x, o.y)) out.add(`${nx},${ny}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/** A readiness modifier applied to a formation's range, with its label. */
export interface RangeModifier {
  label: string;
  multiplier: number;
}

export interface MovementProfile {
  /** Published base range in tiles for ONE movement action. */
  baseRange: number;
  /** Range after readiness modifiers, in tiles (1 dp). */
  effectiveRange: number;
  /** Tiles the same action would cover following a road the whole way. */
  roadRange: number;
  /** Movement actions per round, and how many are left. */
  movesMax: number;
  movesLeft: number;
  /** Everything that is currently reducing the range, for the unit card. */
  modifiers: RangeModifier[];
  /** Total points available across every remaining movement action. */
  roundBudget: number;
  mobilityLabel: string;
  roughMultiplier: number;
  roadCost: number;
}

/**
 * Readiness still modulates range, but only in one coarse, published step that
 * is named on the unit card — never a smooth hidden fudge. The same unit on the
 * same ground always gets the same number. (Supply was removed in phase 6.)
 */
function rangeModifiers(f: Formation): RangeModifier[] {
  const mods: RangeModifier[] = [];
  if (f.readiness < 50) mods.push({ label: `Low readiness (${Math.round(f.readiness)}%)`, multiplier: 0.75 });
  if (f.suppression > 0) {
    const mult = suppressionMultiplier(f.suppression);
    mods.push({ label: `Suppressed (${Math.round(f.suppression)}%)`, multiplier: mult });
  }
  return mods;
}

export function movementProfile(f: Formation): MovementProfile {
  const m = MOBILITY[f.type];
  const mods = rangeModifiers(f);
  const effective = mods.reduce((r, mod) => r * mod.multiplier, m.moveRange);
  const effectiveRange = Math.round(effective * 10) / 10;
  const movesLeft = Math.max(0, f.movesMax - f.movesUsed);
  return {
    baseRange: m.moveRange,
    effectiveRange,
    roadRange: Math.floor(effectiveRange / m.roadCost),
    movesMax: f.movesMax,
    movesLeft,
    modifiers: mods,
    roundBudget: effectiveRange * movesLeft,
    mobilityLabel: m.mobilityLabel,
    roughMultiplier: m.roughMultiplier,
    roadCost: m.roadCost,
  };
}

// ---------------------------------------------------------------------------
// Tile cost
// ---------------------------------------------------------------------------

const ROUGH: Partial<Record<Tile['terrain'], true>> = { FOREST: true, URBAN: true, INDUSTRIAL: true };

/** True when this formation may occupy / cross the tile at all. */
export function crossable(state: GameState, f: Formation, tile: Tile): boolean {
  const def = FORMATION_DEFS[f.type];
  if (tile.terrain === 'WATER') {
    if (def.isNaval) return tile.navigable === true;
    return tile.bridge === true; // land units cross water only on a bridge
  }
  return !def.isNaval; // ships cannot go ashore
}

/**
 * Cost of stepping from `from` into `to`. Deterministic and terrain-only —
 * the whole model is: terrain cost, x rough surcharge for heavy formations,
 * REPLACED by the flat road cost on a road, + a climb surcharge uphill.
 */
export function stepCost(f: Formation, from: Tile, to: Tile): number {
  const m = MOBILITY[f.type];
  if (to.terrain === 'WATER') return to.bridge ? m.roadCost : 1; // bridge decks are roads; open water is flat-rate for ships
  if (to.road) return m.roadCost;
  let cost = TERRAIN_DEFS[to.terrain].moveCost;
  if (ROUGH[to.terrain]) cost *= m.roughMultiplier;
  const climb = to.elevation - from.elevation;
  if (climb > 0) cost += climb * 0.5;
  return cost;
}

// ---------------------------------------------------------------------------
// Reachability + pathfinding
// ---------------------------------------------------------------------------

export interface PathNode {
  x: number;
  y: number;
  cost: number;
}

interface SearchResult {
  cost: Map<string, number>;
  parent: Map<string, string>;
}

/**
 * Dijkstra out from the formation, bounded by `budget` movement points.
 * Returns the cost of reaching every tile inside the budget plus the parent
 * links needed to reconstruct the exact path the preview draws.
 *
 * Zones of Control (phase 7), unless `opts.ignoreZoc`: an enemy ZOC tile is a
 * dead end — it is reachable (you may stop there) but the search never
 * expands FROM it, so it can never be used as a step to somewhere else.
 * Leaving a ZOC tile the formation started this search in (disengaging) costs
 * a full movement action's worth of points on its very first step.
 */
function search(
  state: GameState,
  f: Formation,
  budget: number,
  opts: { ignoreZoc?: boolean; noDisengageSurcharge?: boolean } = {}
): SearchResult {
  const cost = new Map<string, number>();
  const parent = new Map<string, string>();
  const start = `${f.x},${f.y}`;
  cost.set(start, 0);
  if (budget <= 0) return { cost, parent };
  const zoc = opts.ignoreZoc ? EMPTY_ZOC : zocTilesFor(state, f);
  const startInZoc = zoc.has(start);
  const disengageCost = movementProfile(f).effectiveRange;
  // Small maps + small budgets: a sorted array frontier is plenty and keeps
  // this dependency-free.
  const frontier: PathNode[] = [{ x: f.x, y: f.y, cost: 0 }];
  while (frontier.length) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].cost < frontier[bi].cost) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    const curKey = `${cur.x},${cur.y}`;
    if ((cost.get(curKey) ?? Infinity) < cur.cost) continue;
    // A ZOC tile is a stopping point, not a thoroughfare — refuse to expand
    // past it (the start tile is exempt: standing in ZOC does not stop you
    // moving, it just makes the FIRST step out of it expensive, below).
    if (curKey !== start && zoc.has(curKey)) continue;
    const curTile = state.tiles[cur.y][cur.x];
    for (const [nx, ny] of neighbors(cur.x, cur.y)) {
      const tile = state.tiles[ny][nx];
      if (!crossable(state, f, tile)) continue;
      const occ = occupantAt(state, nx, ny);
      if (occ && occ.owner !== f.owner) continue; // never move through or onto an enemy
      let stepC = stepCost(f, curTile, tile);
      if (curKey === start && startInZoc && !opts.noDisengageSurcharge) stepC = Math.max(stepC, disengageCost);
      const next = cur.cost + stepC;
      if (next > budget + 1e-9) continue;
      const key = `${nx},${ny}`;
      if (next < (cost.get(key) ?? Infinity) - 1e-9) {
        cost.set(key, next);
        parent.set(key, curKey);
        frontier.push({ x: nx, y: ny, cost: next });
      }
    }
  }
  return { cost, parent };
}

const EMPTY_ZOC: Set<string> = new Set();

/**
 * Total movement points a formation may spend this round, capped by the AP its
 * side can still pay for (one movement action = 1 AP). This is what the
 * reachable wash on the map shows: everywhere you could actually get to.
 */
export function roundBudget(state: GameState, f: Formation): { budget: number; actionsAffordable: number; range: number } {
  const prof = movementProfile(f);
  const ap = state.players[f.owner]?.ap ?? 0;
  const actionsAffordable = Math.min(prof.movesLeft, Math.floor(ap / AP_COSTS.MOVE));
  return { budget: prof.effectiveRange * actionsAffordable, actionsAffordable, range: prof.effectiveRange };
}

/** Every tile the formation can reach this round, keyed "x,y" -> movement cost. */
export function computeReachable(state: GameState, formationId: string): Map<string, number> {
  const f = state.formations[formationId];
  const out = new Map<string, number>();
  if (!f) return out;
  const { budget } = roundBudget(state, f);
  if (budget <= 0) return out;
  const { cost } = search(state, f, budget);
  cost.forEach((v, k) => {
    if (k === `${f.x},${f.y}`) return;
    const [x, y] = k.split(',').map(Number);
    const occ = occupantAt(state, x, y);
    if (occ) return; // a friendly may be crossed but not stacked on
    out.set(k, v);
  });
  return out;
}

/** Is (x, y) reachable overland at all, ignoring movement budget? */
function connected(state: GameState, f: Formation, x: number, y: number): boolean {
  const seen = new Set<string>([`${f.x},${f.y}`]);
  const queue: [number, number][] = [[f.x, f.y]];
  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++];
    if (cx === x && cy === y) return true;
    for (const [nx, ny] of neighbors(cx, cy)) {
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      const tile = state.tiles[ny][nx];
      if (!crossable(state, f, tile)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move plan — what the hover preview and the invalid-move explanation use
// ---------------------------------------------------------------------------

export type MoveRefusal =
  | 'NO_MOVES'
  | 'NO_AP'
  | 'SAME_TILE'
  | 'OFF_MAP'
  | 'IMPASSABLE'
  | 'WRONG_ELEMENT'
  | 'ENEMY_HELD'
  | 'OCCUPIED'
  | 'TOO_FAR'
  | 'ZOC_BLOCKED'
  | 'NOT_YOUR_TURN';

export interface MovePlan {
  ok: boolean;
  /** Refusal code, null when the move is legal. */
  refusal: MoveRefusal | null;
  /** Player-facing explanation. Always set when ok === false. */
  reason: string;
  gridRef: string;
  /** Tiles walked, excluding the starting tile. Empty when the move is illegal. */
  path: { x: number; y: number }[];
  /** Straight-line (Manhattan) distance in tiles. */
  distance: number;
  /** Movement points the path costs. */
  cost: number;
  /** What the same path would have cost with no roads on it. */
  costWithoutRoads: number;
  /** Points saved by the roads along the path (costWithoutRoads - cost). */
  roadBonus: number;
  /** How many of the path's tiles were road. */
  roadTiles: number;
  /** Coarse label for the going: Easy / Moderate / Hard / Severe. */
  terrainCostLabel: string;
  /** Movement actions this move consumes. */
  actionsRequired: number;
  apCost: number;
  /** Set when the formation starts this move inside an enemy Zone of Control —
   *  disengaging costs a full movement action's worth of points (phase 7). */
  zocNote: string | null;
}

function terrainLabel(cost: number, tiles: number): string {
  if (tiles <= 0) return 'None';
  const per = cost / tiles;
  if (per <= 0.8) return 'Easy';
  if (per <= 1.3) return 'Moderate';
  if (per <= 2.2) return 'Hard';
  return 'Severe';
}

function refusal(code: MoveRefusal, reason: string, x: number, y: number): MovePlan {
  return {
    ok: false,
    refusal: code,
    reason,
    gridRef: gridRef(x, y),
    path: [],
    distance: 0,
    cost: 0,
    costWithoutRoads: 0,
    roadBonus: 0,
    roadTiles: 0,
    terrainCostLabel: 'None',
    actionsRequired: 0,
    apCost: 0,
    zocNote: null,
  };
}

/**
 * The full answer to "what happens if I send this formation to (x, y)?" —
 * either a costed path, or a refusal with a reason the player can act on.
 * A destination is NEVER silently refused.
 */
export function planMove(state: GameState, f: Formation, x: number, y: number, budgetOverride?: number): MovePlan {
  if (!inBounds(x, y)) return refusal('OFF_MAP', 'Off the map sheet.', x, y);
  if (f.x === x && f.y === y) return refusal('SAME_TILE', 'The formation is already here.', x, y);

  const prof = movementProfile(f);
  const def = FORMATION_DEFS[f.type];
  const tile = state.tiles[y][x];

  if (state.activePlayer !== f.owner) return refusal('NOT_YOUR_TURN', 'Not your turn.', x, y);
  if (prof.movesLeft <= 0)
    return refusal('NO_MOVES', `No movement actions left this round (${f.movesUsed} / ${f.movesMax} used).`, x, y);
  if ((state.players[f.owner]?.ap ?? 0) < AP_COSTS.MOVE)
    return refusal('NO_AP', `Not enough AP — a movement action costs ${AP_COSTS.MOVE} AP.`, x, y);

  if (!crossable(state, f, tile)) {
    if (def.isNaval) return refusal('WRONG_ELEMENT', 'Warships cannot go ashore — this formation cannot enter this terrain.', x, y);
    if (tile.terrain === 'WATER')
      return refusal(
        'IMPASSABLE',
        tile.river
          ? 'Terrain impassable — a river crossing. Bring engineers up to bridge it.'
          : 'Terrain impassable — open water. Land formations cannot enter this terrain.',
        x,
        y
      );
    return refusal('IMPASSABLE', 'This formation cannot enter this terrain.', x, y);
  }

  const occ = occupantAt(state, x, y);
  if (occ && occ.owner !== f.owner)
    return refusal('ENEMY_HELD', `Enemy-controlled position — attack it instead of moving onto it.`, x, y);
  if (occ) return refusal('OCCUPIED', `Tile already occupied by ${occ.shortName}.`, x, y);

  const rb = roundBudget(state, f);
  const budget = budgetOverride ?? rb.budget;
  const { cost, parent } = search(state, f, budget);
  const key = `${x},${y}`;
  if (!cost.has(key)) {
    // Distinguish "too far" from "genuinely unreachable" so the message is
    // honest. Connectivity is a plain BFS (no costs) — this runs on every
    // hover, so it must stay linear.
    const reachableAtAll = connected(state, f, x, y);
    if (reachableAtAll) {
      // Was it ZOC specifically that cut this off? Re-run the same search
      // ignoring ZOC — if THAT reaches the tile inside the same budget, the
      // enemy's Zone of Control is the reason, and the player is told so
      // rather than left with a generic "too far".
      const { cost: freeCost } = search(state, f, budget, { ignoreZoc: true });
      if (freeCost.has(key)) {
        return refusal(
          'ZOC_BLOCKED',
          `Blocked by an enemy Zone of Control — an enemy formation adjacent to the route stops movement passing through it. You may move onto the Zone of Control tile itself and stop there, or route around it.`,
          x,
          y
        );
      }
    }
    return refusal(
      'TOO_FAR',
      reachableAtAll
        ? `Too far — ${gridRef(x, y)} is beyond this formation's ${budget.toFixed(1)}-point movement allowance for the round.`
        : `No route — ${gridRef(x, y)} cannot be reached overland from here.`,
      x,
      y
    );
  }

  // Reconstruct the path.
  const path: { x: number; y: number }[] = [];
  let cur = key;
  const start = `${f.x},${f.y}`;
  while (cur !== start) {
    const [px, py] = cur.split(',').map(Number);
    path.unshift({ x: px, y: py });
    const p = parent.get(cur);
    if (!p) break;
    cur = p;
  }

  // Cost the same path again with roads switched off, to quote the road bonus.
  let bare = 0;
  let roadTiles = 0;
  let prev = state.tiles[f.y][f.x];
  const m = MOBILITY[f.type];
  for (const step of path) {
    const t = state.tiles[step.y][step.x];
    if (t.road || t.bridge) roadTiles += 1;
    if (t.terrain === 'WATER') {
      bare += 1;
    } else {
      let c = TERRAIN_DEFS[t.terrain].moveCost;
      if (ROUGH[t.terrain]) c *= m.roughMultiplier;
      const climb = t.elevation - prev.elevation;
      if (climb > 0) c += climb * 0.5;
      bare += c;
    }
    prev = t;
  }

  const total = cost.get(key)!;
  const actionsRequired = Math.max(1, Math.ceil((total - 1e-9) / Math.max(0.1, prof.effectiveRange)));
  const zoc = zocTilesFor(state, f);
  const zocNote = zoc.has(`${f.x},${f.y}`)
    ? `Disengaging from an enemy Zone of Control — this bound spends a full movement action's worth of points (${prof.effectiveRange.toFixed(1)}) just to break contact.`
    : null;
  return {
    ok: true,
    refusal: null,
    reason: '',
    gridRef: gridRef(x, y),
    path,
    distance: manhattan(f.x, f.y, x, y),
    cost: Math.round(total * 10) / 10,
    costWithoutRoads: Math.round(bare * 10) / 10,
    roadBonus: Math.round(Math.max(0, bare - total) * 10) / 10,
    roadTiles,
    terrainCostLabel: terrainLabel(total, path.length),
    actionsRequired,
    apCost: actionsRequired * AP_COSTS.MOVE,
    zocNote,
  };
}

// ---------------------------------------------------------------------------
// Formation cohesion (movement-side awareness)
// ---------------------------------------------------------------------------

export const MANOEUVRE_TYPES: FormationType[] = ['INFANTRY', 'ARMOUR', 'COMMANDO', 'GUARDS', 'RECON'];
export const SUPPORT_TYPES: FormationType[] = ['ARTILLERY', 'ENGINEER'];

export function isSupportType(t: FormationType) {
  return SUPPORT_TYPES.includes(t);
}

export interface NearbyFriendly {
  id: string;
  shortName: string;
  type: FormationType;
  distance: number;
  gridRef: string;
}

/** Friendly formations within `radius`, nearest first. */
export function nearbyFriendlies(state: GameState, f: Formation, radius = COHESION_RADIUS): NearbyFriendly[] {
  return Object.values(state.formations)
    .filter((o) => o.owner === f.owner && o.id !== f.id && FORMATION_DEFS[o.type].isNaval === FORMATION_DEFS[f.type].isNaval)
    .map((o) => ({
      id: o.id,
      shortName: o.shortName,
      type: o.type,
      distance: manhattan(f.x, f.y, o.x, o.y),
      gridRef: gridRef(o.x, o.y),
    }))
    .filter((o) => o.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/** The manoeuvre formation a support element is currently working with, if any. */
export function supportedFormation(state: GameState, f: Formation): Formation | null {
  if (!isSupportType(f.type)) return null;
  let best: Formation | null = null;
  let bestD = Infinity;
  for (const o of Object.values(state.formations)) {
    if (o.owner !== f.owner || o.id === f.id) continue;
    if (!MANOEUVRE_TYPES.includes(o.type) || FORMATION_DEFS[o.type].isNaval) continue;
    const d = manhattan(f.x, f.y, o.x, o.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export interface CohesionAdvisory {
  /** Advisory text; the move is always still allowed. */
  message: string;
  severity: 'info' | 'warn';
}

/**
 * Movement-side cohesion advisory for sending `f` to (x, y). Advisory only —
 * it never blocks a move, it just tells the player what they are about to do.
 * Two cases:
 *   - a SUPPORT element walking out of range of the manoeuvre unit it supports
 *   - a MANOEUVRE element walking away from a support element that is with it
 */
export function cohesionAdvisory(
  state: GameState,
  f: Formation,
  x: number,
  y: number,
  /** Formations moving alongside `f` (a Move Formation group) — never counted as left behind. */
  movingWith: Set<string> = new Set()
): CohesionAdvisory | null {
  if (FORMATION_DEFS[f.type].isNaval) return null;

  if (isSupportType(f.type)) {
    const partner = supportedFormation(state, f);
    if (!partner) return null;
    const before = manhattan(f.x, f.y, partner.x, partner.y);
    const after = manhattan(x, y, partner.x, partner.y);
    if (after > COHESION_RADIUS && after > before)
      return {
        message: `${f.shortName} is becoming separated from supported formation ${partner.shortName} — ${after} tiles after the move (cohesion range ${COHESION_RADIUS}).`,
        severity: before <= COHESION_RADIUS ? 'warn' : 'info',
      };
    return null;
  }

  // Manoeuvre element: warn if it is about to leave a support element behind.
  const stranded = Object.values(state.formations)
    .filter((o) => o.owner === f.owner && isSupportType(o.type) && !movingWith.has(o.id))
    .map((o) => ({ o, before: manhattan(f.x, f.y, o.x, o.y), after: manhattan(x, y, o.x, o.y) }))
    .filter((r) => r.before <= COHESION_RADIUS && r.after > COHESION_RADIUS)
    // Only if that support element has no other manoeuvre unit to fall in with.
    .filter((r) => {
      const others = Object.values(state.formations).filter(
        (q) =>
          q.owner === f.owner &&
          q.id !== f.id &&
          MANOEUVRE_TYPES.includes(q.type) &&
          !FORMATION_DEFS[q.type].isNaval &&
          manhattan(q.x, q.y, r.o.x, r.o.y) <= COHESION_RADIUS
      );
      return others.length === 0;
    });
  if (!stranded.length) return null;
  const names = stranded.map((r) => r.o.shortName).join(', ');
  return {
    message: `${names} ${stranded.length === 1 ? 'is' : 'are'} becoming separated from supported formation — ${f.shortName} is moving beyond cohesion range ${COHESION_RADIUS}.`,
    severity: 'warn',
  };
}

// ---------------------------------------------------------------------------
// Move Formation — grouped movement, paced to the slowest participant
// ---------------------------------------------------------------------------

export interface GroupMemberPlan {
  id: string;
  shortName: string;
  /** Where this member will actually end up (may be near, not on, the target). */
  x: number;
  y: number;
  gridRef: string;
  cost: number;
  ok: boolean;
  reason: string;
}

export interface GroupMovePlan {
  ok: boolean;
  reason: string;
  /** Movement points every member is limited to — the slowest member's range. */
  pace: number;
  /** The formation that set the pace. */
  pacedBy: string;
  members: GroupMemberPlan[];
  /** Members excluded before planning (no movement actions left, etc). */
  excluded: { shortName: string; reason: string }[];
  apCost: number;
  targetRef: string;
  advisories: string[];
}

/**
 * Plan a grouped move. Every participant is paced to the SLOWEST participant's
 * single-action range, so the group arrives together instead of the armour
 * running off and leaving the guns on the start line. Each participant spends
 * exactly one of its own movement actions and 1 AP; nothing is free, and a
 * formation with no movement actions left is reported, never silently dropped.
 */
export function planGroupMove(state: GameState, ids: string[], x: number, y: number): GroupMovePlan {
  const excluded: { shortName: string; reason: string }[] = [];
  const participants: Formation[] = [];

  for (const id of ids) {
    const f = state.formations[id];
    if (!f) continue;
    if (f.owner !== state.activePlayer) {
      excluded.push({ shortName: f.shortName, reason: 'not yours to order' });
      continue;
    }
    if (f.movesUsed >= f.movesMax) {
      excluded.push({ shortName: f.shortName, reason: `no movement actions left (${f.movesUsed} / ${f.movesMax} used)` });
      continue;
    }
    participants.push(f);
  }

  const base: GroupMovePlan = {
    ok: false,
    reason: '',
    pace: 0,
    pacedBy: '',
    members: [],
    excluded,
    apCost: 0,
    targetRef: gridRef(x, y),
    advisories: [],
  };

  if (participants.length < 2) {
    base.reason =
      participants.length === 0
        ? 'No formation in the group can move — every member has spent its movement actions.'
        : 'Move Formation needs at least two formations that can still move.';
    return base;
  }

  const ap = state.players[state.activePlayer].ap;
  if (ap < participants.length * AP_COSTS.MOVE) {
    base.reason = `Not enough AP — moving ${participants.length} formations costs ${participants.length * AP_COSTS.MOVE} AP, you have ${ap}.`;
    return base;
  }

  // Pace = the slowest member's effective single-action range.
  let pace = Infinity;
  let pacedBy = '';
  for (const f of participants) {
    const r = movementProfile(f).effectiveRange;
    if (r < pace) {
      pace = r;
      pacedBy = f.shortName;
    }
  }

  // Assign destinations: closest-to-target first, each claiming a distinct tile.
  const claimed = new Set<string>();
  Object.values(state.formations).forEach((o) => {
    if (!participants.some((p) => p.id === o.id)) claimed.add(`${o.x},${o.y}`);
  });

  const ordered = [...participants].sort(
    (a, b) => manhattan(a.x, a.y, x, y) - manhattan(b.x, b.y, x, y)
  );

  const members: GroupMemberPlan[] = [];
  for (const f of ordered) {
    const { cost } = search(state, f, pace);
    let bestKey: string | null = null;
    let bestScore = Infinity;
    cost.forEach((c, key) => {
      if (claimed.has(key)) return;
      const [tx, ty] = key.split(',').map(Number);
      // Get as close to the objective tile as possible; break ties by cheapness
      // so the group stays compact instead of fanning out.
      const score = manhattan(tx, ty, x, y) * 10 + c;
      if (score < bestScore) {
        bestScore = score;
        bestKey = key;
      }
    });
    if (!bestKey || bestKey === `${f.x},${f.y}`) {
      members.push({
        id: f.id,
        shortName: f.shortName,
        x: f.x,
        y: f.y,
        gridRef: gridRef(f.x, f.y),
        cost: 0,
        ok: false,
        reason: 'no closer position within the group pace',
      });
      continue;
    }
    const [tx, ty] = (bestKey as string).split(',').map(Number);
    claimed.add(bestKey);
    members.push({
      id: f.id,
      shortName: f.shortName,
      x: tx,
      y: ty,
      gridRef: gridRef(tx, ty),
      cost: Math.round(cost.get(bestKey)! * 10) / 10,
      ok: true,
      reason: '',
    });
  }

  const movers = members.filter((m) => m.ok);
  base.pace = Math.round(pace * 10) / 10;
  base.pacedBy = pacedBy;
  base.members = members;
  base.apCost = movers.length * AP_COSTS.MOVE;
  base.ok = movers.length > 0;
  if (!base.ok) base.reason = 'No member of the group can reach any position closer to the objective.';

  // Cohesion advisories for the group as a whole. Members moving together are
  // never reported as separating from one another.
  const groupIds = new Set(participants.map((p) => p.id));
  const seen = new Set<string>();
  for (const m of movers) {
    const f = state.formations[m.id];
    const adv = cohesionAdvisory(state, f, m.x, m.y, groupIds);
    if (adv && !seen.has(adv.message)) {
      seen.add(adv.message);
      base.advisories.push(adv.message);
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// RETREAT / WITHDRAW (phase 12 §1) — see the AP-cost comment block on
// WITHDRAW_RANGE_FRACTION in types.ts for the full comparison against an
// ordinary ZOC-disengaging Move.
// ---------------------------------------------------------------------------

/**
 * True when `f` reads as "disengaging from contact" rather than just
 * repositioning: adjacent to an enemy this side has actually DETECTED (its
 * own contact table — fog-of-war correct), standing inside an enemy Zone of
 * Control, or badly enough hurt (strength or morale) that pulling back is the
 * honest move regardless of what is nearby right now.
 */
export function isThreatened(state: GameState, f: Formation): boolean {
  if (zocTilesFor(state, f).has(`${f.x},${f.y}`)) return true;
  const contacts = state.players[f.owner]?.contacts ?? {};
  for (const c of Object.values(contacts)) {
    if (c.level === 'UNKNOWN') continue;
    if (manhattan(c.x, c.y, f.x, f.y) <= 1) return true;
  }
  if (f.strength < WITHDRAW_STRENGTH_THRESHOLD) return true;
  if ((WITHDRAW_MORALE_BANDS as readonly string[]).includes(moraleBandFor(f.moraleValue))) return true;
  return false;
}

/** Positions to retreat AWAY from — this side's own detected contacts near `f`, falling back to any truly-adjacent enemy (the ZOC case). */
function threatPositions(state: GameState, f: Formation): { x: number; y: number }[] {
  const contacts = state.players[f.owner]?.contacts ?? {};
  const near = Object.values(contacts)
    .filter((c) => c.level !== 'UNKNOWN')
    .filter((c) => manhattan(c.x, c.y, f.x, f.y) <= Math.max(6, MOBILITY[f.type].moveRange * 2))
    .map((c) => ({ x: c.x, y: c.y }));
  if (near.length) return near;
  // Fallback (e.g. a ZOC tile from an enemy this side has somehow not put in
  // its own contact table yet, which should be rare — adjacency all but
  // guarantees passive detection): use the true adjacent enemy positions, the
  // same ground truth the ZOC check itself already reads.
  return Object.values(state.formations)
    .filter((o) => o.owner !== f.owner && manhattan(o.x, o.y, f.x, f.y) <= 1)
    .map((o) => ({ x: o.x, y: o.y }));
}

export interface WithdrawPlan {
  ok: boolean;
  reason: string;
  path: { x: number; y: number }[];
  destX: number;
  destY: number;
  cost: number;
  distance: number;
}

/**
 * Plan a Withdraw: a short bound, AWAY from the nearest threat direction,
 * that does NOT pay the ZOC disengagement surcharge (see `search`'s
 * `noDisengageSurcharge`) but otherwise obeys every normal movement rule —
 * impassable terrain, friendly/enemy occupancy, a ZOC tile still being a
 * dead end to expand past. Picks the reachable tile that maximises distance
 * from the nearest threat, tie-broken by the cheapest path.
 */
export function planWithdraw(state: GameState, f: Formation): WithdrawPlan {
  const fail = (reason: string): WithdrawPlan => ({ ok: false, reason, path: [], destX: f.x, destY: f.y, cost: 0, distance: 0 });
  if (!isThreatened(state, f)) return fail('Not in a threatening situation — nothing to withdraw from.');
  const movesLeft = Math.max(0, f.movesMax - f.movesUsed);
  if (movesLeft <= 0) return fail('No movement actions left this round.');
  const threats = threatPositions(state, f);
  if (!threats.length) return fail('No detected threat to withdraw from.');

  const prof = movementProfile(f);
  const budget = prof.effectiveRange * WITHDRAW_RANGE_FRACTION;
  const { cost, parent } = search(state, f, budget, { noDisengageSurcharge: true });
  const start = `${f.x},${f.y}`;

  let bestKey: string | null = null;
  let bestScore = -Infinity;
  cost.forEach((c, key) => {
    if (key === start) return;
    const [x, y] = key.split(',').map(Number);
    const occ = occupantAt(state, x, y);
    if (occ) return; // never stack, even on a friendly
    const minD = Math.min(...threats.map((t) => manhattan(x, y, t.x, t.y)));
    const score = minD * 1000 - c; // maximise distance from the nearest threat, cheapest path breaks ties
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  });
  if (!bestKey) return fail('No tile to fall back to within withdrawal range.');
  const destKey: string = bestKey;

  const path: { x: number; y: number }[] = [];
  let cur: string = destKey;
  while (cur !== start) {
    const [px, py] = cur.split(',').map(Number);
    path.unshift({ x: px, y: py });
    const p = parent.get(cur);
    if (!p) break;
    cur = p;
  }
  const [dx, dy] = destKey.split(',').map(Number);
  return {
    ok: true,
    reason: '',
    path,
    destX: dx,
    destY: dy,
    cost: Math.round(cost.get(destKey)! * 10) / 10,
    distance: manhattan(f.x, f.y, dx, dy),
  };
}
