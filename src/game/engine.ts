// ============================================================================
// COMMAND — Pure game engine. No rendering / DOM here.
// All functions take a GameState and mutate-then-return it (caller is
// expected to clone the state before calling a mutator, see store.ts).
// ============================================================================

import { FORMATION_DEFS, MORALE_MULTIPLIER, ORDERS_OF_BATTLE, TERRAIN_DEFS } from './data';
import { generateBattlefield } from './mapgen';
import {
  computeReachable as computeReachableTiles,
  cohesionAdvisory,
  planGroupMove,
  planMove,
} from './movement';
import { deepProbe, reconSweep, refreshAllSpotting, refreshSpotting } from './detection';
import {
  COHESION_RADIUS,
  MORALE_BASELINE,
  MORALE_CASUALTY_DEADZONE,
  MORALE_CASUALTY_SCALE,
  MORALE_ELAN_CEILING,
  MORALE_RECOVERY,
  MORALE_SHOCKS,
  gridRef,
  moraleBandFor,
  AP_CAP,
  AP_COSTS,
  AP_PER_TURN,
  AIR_SORTIES_PER_TURN,
  MAX_ROUNDS,
  VP_WIN_THRESHOLD,
  ActionKind,
  BattleFactor,
  BattleReport,
  DetectionLevel,
  Formation,
  GameState,
  LossLevel,
  Morale,
  Objective,
  PlayerId,
  SPECIAL_OP_RANGE,
  Tile,
  otherPlayer,
} from './types';

let idCounter = 0;
function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeFormation(owner: PlayerId, profileIndex: number, x: number, y: number): Formation {
  const p = ORDERS_OF_BATTLE[owner][profileIndex];
  const def = FORMATION_DEFS[p.type];
  return {
    id: nextId('f'),
    owner,
    type: p.type,
    name: p.name,
    shortName: p.shortName,
    echelon: p.echelon,
    arm: p.arm,
    equipment: p.equipment,
    x,
    y,
    strength: 100,
    morale: moraleBandFor(MORALE_BASELINE[p.type]),
    moraleValue: MORALE_BASELINE[p.type],
    moraleBaseline: MORALE_BASELINE[p.type],
    lastEngagedRound: 0,
    readiness: 100,
    supply: 100,
    ammo: 100,
    movesUsed: 0,
    movesMax: def.movesPerRound,
    hasActedThisTurn: false,
    fortified: false,
    lastOrder: 'Deployed',
  };
}

export function initGame(seed = 1337): GameState {
  const map = generateBattlefield(seed);
  const formations: Record<string, Formation> = {};

  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((side) => {
    const landSlots = [...map.startZones[side]];
    const seaSlots = [...map.navalSpawns[side]];
    ORDERS_OF_BATTLE[side].forEach((profile, i) => {
      const naval = FORMATION_DEFS[profile.type].isNaval;
      const pos = naval ? seaSlots.shift() ?? seaSlots[0] : landSlots.shift() ?? landSlots[landSlots.length - 1];
      const f = makeFormation(side, i, pos.x, pos.y);
      formations[f.id] = f;
    });
  });

  const state: GameState = {
    round: 1,
    activePlayer: 'BLUEFOR',
    tiles: map.tiles,
    formations,
    objectives: map.objectives,
    players: {
      BLUEFOR: { id: 'BLUEFOR', ap: AP_PER_TURN, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {} },
      REDFOR: { id: 'REDFOR', ap: AP_PER_TURN, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {} },
    },
    log: [{ text: 'Operation begins. BLUEFOR moves first.', audience: 'ALL' as const }],
    phase: 'PLAYING',
    winner: null,
    lastBattleReport: null,
  };

  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tileAt(state: GameState, x: number, y: number): Tile | undefined {
  return state.tiles[y]?.[x];
}

export function formationAt(state: GameState, x: number, y: number): Formation | undefined {
  return Object.values(state.formations).find((f) => f.x === x && f.y === y);
}

export function distance(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

function moraleMult(m: Morale) {
  return MORALE_MULTIPLIER[m];
}

/** Movement actions this formation still has left this round. */
export function movesRemaining(f: Formation): number {
  return Math.max(0, f.movesMax - f.movesUsed);
}

export function canMove(state: GameState, f: Formation): boolean {
  return f.owner === state.activePlayer && movesRemaining(f) > 0 && canAfford(state, 'MOVE');
}

/**
 * Tiles this formation can reach this round. The whole movement model (range,
 * road bonus, rough-going surcharge, climb cost, per-round budget) lives in
 * movement.ts so the client preview and the server rules are literally the
 * same code.
 */
export const computeReachable = computeReachableTiles;

// ---------------------------------------------------------------------------
// AP / action gating
// ---------------------------------------------------------------------------

export function canAfford(state: GameState, kind: ActionKind): boolean {
  return state.players[state.activePlayer].ap >= AP_COSTS[kind];
}

function spendAP(state: GameState, kind: ActionKind) {
  state.players[state.activePlayer].ap -= AP_COSTS[kind];
}

/**
 * Append an operations-log line. `audience` defaults to the side that acted —
 * fog.ts only sends a player the entries addressed to them or to 'ALL', so the
 * log can never narrate an enemy move the player has not detected.
 */
function log(state: GameState, msg: string, audience: PlayerId | 'ALL' = state.activePlayer) {
  state.log.unshift({ text: msg, audience });
  if (state.log.length > 60) state.log.pop();
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export function moveFormation(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer) return state;
  const plan = planMove(state, f, x, y);
  if (!plan.ok) return state;
  // A long bound may consume more than one of the formation's movement actions
  // (and one AP each) — the client preview states exactly how many before the
  // player commits, so the accounting is never a surprise.
  if (plan.actionsRequired > movesRemaining(f)) return state;
  if (state.players[f.owner].ap < plan.apCost) return state;

  const advisory = cohesionAdvisory(state, f, x, y);
  state.players[state.activePlayer].ap -= plan.apCost;
  f.x = x;
  f.y = y;
  f.fortified = false;
  f.movesUsed += plan.actionsRequired;
  const ref = gridRef(x, y);
  f.lastOrder = `Moved to grid ${ref} — bound ${f.movesUsed}/${f.movesMax}`;
  log(state, `${f.shortName} moved to grid ${ref} [${f.movesUsed}/${f.movesMax} bounds].`);
  if (advisory) log(state, advisory.message);
  refreshAllSpotting(state);
  return state;
}

/**
 * Move Formation — an OPTIONAL grouped order. Every participant is paced to the
 * slowest member's single-action range so the group arrives together, each
 * spends one of its own movement actions and 1 AP, and destination tiles are
 * resolved around the objective so nothing stacks illegally.
 * Single-unit movement is untouched by this.
 */
export function moveGroup(state: GameState, formationIds: string[], x: number, y: number): GameState {
  const plan = planGroupMove(state, formationIds, x, y);
  if (!plan.ok) return state;
  const movers = plan.members.filter((m) => m.ok);
  if (state.players[state.activePlayer].ap < plan.apCost) return state;
  state.players[state.activePlayer].ap -= plan.apCost;
  const names: string[] = [];
  for (const m of movers) {
    const f = state.formations[m.id];
    if (!f) continue;
    f.x = m.x;
    f.y = m.y;
    f.fortified = false;
    f.movesUsed += 1;
    f.lastOrder = `Moved with formation to grid ${m.gridRef} — bound ${f.movesUsed}/${f.movesMax}`;
    names.push(f.shortName);
  }
  log(
    state,
    `Formation move on grid ${plan.targetRef}: ${names.join(', ')} advanced together at ${plan.pacedBy}'s pace (${plan.pace} pts, ${plan.apCost} AP).`
  );
  plan.advisories.forEach((a) => log(state, a));
  plan.excluded.forEach((e) => log(state, `${e.shortName} could not join the formation move — ${e.reason}.`));
  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// Morale (phase 4a)
//
// Morale is a slow-moving battlefield condition carried as a 0..100 number that
// drifts back toward each formation's baseline. Only the named shocks in
// MORALE_SHOCKS and genuinely heavy casualties move it off that baseline;
// routine movement and small engagements move it not at all. The five named
// bands are derived from the number and still drive combat power.
// ---------------------------------------------------------------------------

function setMorale(f: Formation, value: number) {
  f.moraleValue = Math.max(0, Math.min(100, Math.round(value * 10) / 10));
  f.morale = moraleBandFor(f.moraleValue);
}

/** Apply a named morale shock. Returns true if the band actually changed. */
export function applyMoraleShock(state: GameState, f: Formation, points: number, reason: string): boolean {
  if (points === 0) return false;
  let applied = points;
  if (points > 0 && f.moraleValue > f.moraleBaseline) {
    const over = f.moraleValue - f.moraleBaseline;
    applied = points * Math.max(0.15, 1 - over / MORALE_ELAN_CEILING);
  }
  const before = f.morale;
  setMorale(f, f.moraleValue + applied);
  if (f.morale !== before) {
    log(state, `${f.shortName} morale ${before} → ${f.morale} (${reason}).`, f.owner);
    return true;
  }
  return false;
}

/**
 * Morale cost of taking casualties. Has a deliberate dead zone: anything up to
 * MORALE_CASUALTY_DEADZONE strength lost is a routine engagement and costs no
 * morale at all. Indirect fire (artillery, air, raids) carries a lighter
 * weight than a stand-up assault.
 */
function casualtyShock(delta: number, weight = 1): number {
  const lost = Math.abs(Math.min(0, delta));
  return -Math.max(0, lost - MORALE_CASUALTY_DEADZONE) * MORALE_CASUALTY_SCALE * weight;
}

/** Everyone on `owner`'s side within COHESION_RADIUS of (x, y). */
function friendsNear(state: GameState, owner: PlayerId, x: number, y: number, radius = COHESION_RADIUS): Formation[] {
  return Object.values(state.formations).filter((f) => f.owner === owner && distance(f.x, f.y, x, y) <= radius);
}

/** Losing a battalion shakes everyone who watched it happen. */
function mourn(state: GameState, lost: Formation) {
  friendsNear(state, lost.owner, lost.x, lost.y).forEach((f) => {
    if (f.id === lost.id) return;
    applyMoraleShock(state, f, MORALE_SHOCKS.KEY_FORMATION_LOST, `${lost.shortName} destroyed nearby`);
  });
}

/**
 * End-of-round morale tick for one side: positional shocks (isolated,
 * surrounded, out of supply) first, then gradual recovery back toward the
 * formation's baseline for anyone who was not in a fight this round.
 */
function tickMorale(state: GameState, owner: PlayerId) {
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== owner) return;
    const friends = friendsNear(state, owner, f.x, f.y).filter((o) => o.id !== f.id);
    const enemiesClose = Object.values(state.formations).filter(
      (o) => o.owner !== owner && distance(o.x, o.y, f.x, f.y) <= 3
    ).length;

    let shock = 0;
    const reasons: string[] = [];
    if (friends.length === 0) {
      shock += MORALE_SHOCKS.ISOLATED;
      reasons.push('isolated');
    }
    if (enemiesClose >= 2 && enemiesClose > friends.length) {
      shock += MORALE_SHOCKS.SURROUNDED;
      reasons.push('surrounded');
    }
    if (!FORMATION_DEFS[f.type].isNaval) {
      if (f.supply < 20) {
        shock += MORALE_SHOCKS.SUPPLY_CRITICAL;
        reasons.push('supply critical');
      } else if (f.supply < 40) {
        shock += MORALE_SHOCKS.SUPPLY_LOW;
        reasons.push('supply running low');
      }
    }
    if (shock < 0) applyMoraleShock(state, f, shock, reasons.join(', '));

    const engaged = f.lastEngagedRound === state.round;
    if (engaged) return; // a formation in contact does not reorganise

    if (f.moraleValue > f.moraleBaseline) {
      // Elan above the baseline fades slowly rather than being banked forever.
      setMorale(f, Math.max(f.moraleBaseline, f.moraleValue - MORALE_RECOVERY.ABOVE_BASELINE_DECAY));
      return;
    }
    if (f.moraleValue >= f.moraleBaseline) return;

    let recovery = MORALE_RECOVERY.BASE;
    if (FORMATION_DEFS[f.type].isNaval || isInSupplyRange(state, f)) recovery += MORALE_RECOVERY.IN_SUPPLY;
    if (f.movesUsed === 0 || f.fortified) recovery += MORALE_RECOVERY.HELD_POSITION;
    if (friends.length > 0) recovery += MORALE_RECOVERY.NEAR_FRIENDS;
    if (friends.length === 0) recovery = recovery / 2; // nobody to reorganise around
    const before = f.morale;
    setMorale(f, Math.min(f.moraleBaseline, f.moraleValue + recovery));
    if (f.morale !== before) log(state, `${f.shortName} morale recovered to ${f.morale}.`, f.owner);
  });
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

/**
 * Passive spotting refresh for one side. Kept under the old name so every
 * existing call site still reads correctly, but the work now lives in
 * detection.ts: line of sight over the heightfield, situational detection
 * range, and the four-rung confidence ladder.
 */
export function refreshFogOfWar(state: GameState, player: PlayerId) {
  refreshSpotting(state, player);
}

/**
 * Spotting is PASSIVE and symmetric: whatever moved, both sides re-look. This
 * is the function every action calls, and the server calls it again after any
 * action as a backstop.
 */
export function refreshAllFog(state: GameState) {
  refreshAllSpotting(state);
}

/**
 * The Recon order. It is no longer how you see the enemy — passive spotting
 * already does that — it is how you see FURTHER, SOONER and with CERTAINTY.
 */
export function reconAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!canAfford(state, 'RECON')) return state;
  spendAP(state, 'RECON');
  const res = reconSweep(state, f);
  f.hasActedThisTurn = true;
  f.lastOrder = `Recon sweep — ${res.found} contact${res.found === 1 ? '' : 's'} out to ${res.range} tiles`;
  if (res.found === 0) {
    log(state, `${f.name} swept out to ${res.range} tiles — no enemy found.`);
  } else {
    log(
      state,
      `${f.name} recon sweep (${res.range} tiles): ${res.found} contact${res.found === 1 ? '' : 's'}` +
        (res.identified ? `, ${res.identified} upgraded on the detection ladder.` : '.')
    );
  }
  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// Fortify / Resupply / Engineer ops
// ---------------------------------------------------------------------------

export function fortifyAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!canAfford(state, 'FORTIFY')) return state;
  spendAP(state, 'FORTIFY');
  f.fortified = true;
  f.hasActedThisTurn = true;
  f.lastOrder = 'Dug in (fortified)';
  log(state, `${f.name} dug in and fortified its position.`);
  return state;
}

/** Radius each kind of supply source projects. */
export const SUPPLY_RADIUS = 14;

/**
 * Supply is a POSITIONAL modifier, not a logistics mini-game: a formation is
 * in supply if it sits inside the radius of one of its side's supply sources —
 * its depots, or any Port / Airfield / Supply Depot objective it currently
 * holds. There are no supply convoys or transport routes to shepherd; pushing
 * your front line beyond your held rear areas is what costs you supply.
 */
export function supplySources(state: GameState, owner: PlayerId): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const row of state.tiles) {
    for (const t of row) {
      if (t.isDepot && t.depotOwner === owner) out.push({ x: t.x, y: t.y });
    }
  }
  for (const o of state.objectives) {
    if (o.controlledBy !== owner) continue;
    if (o.kind === 'Port' || o.kind === 'Airfield' || o.kind === 'Supply Depot') out.push({ x: o.x, y: o.y });
  }
  return out;
}

export function isInSupplyRange(state: GameState, f: Formation): boolean {
  return supplySources(state, f.owner).some((s) => distance(f.x, f.y, s.x, s.y) <= SUPPLY_RADIUS);
}

export function resupplyAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!canAfford(state, 'RESUPPLY')) return state;
  if (!isInSupplyRange(state, f)) {
    log(state, `${f.name} attempted to resupply but is out of supply range.`);
    return state;
  }
  spendAP(state, 'RESUPPLY');
  f.supply = 100;
  f.ammo = 100;
  f.readiness = Math.min(100, f.readiness + 20);
  f.hasActedThisTurn = true;
  f.lastOrder = 'Resupplied';
  applyMoraleShock(state, f, MORALE_SHOCKS.RESUPPLIED, 'resupplied and reorganised');
  log(state, `${f.name} resupplied — ammo and supply restored.`);
  return state;
}

export function engineerBridgeAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || f.type !== 'ENGINEER') return state;
  if (!canAfford(state, 'ENGINEER_BRIDGE')) return state;
  const tile = tileAt(state, x, y);
  if (!tile || tile.terrain !== 'WATER' || !tile.river) return state;
  if (distance(f.x, f.y, x, y) > 1) return state;
  spendAP(state, 'ENGINEER_BRIDGE');
  tile.bridge = true;
  tile.road = true;
  f.hasActedThisTurn = true;
  f.lastOrder = `Built a bridge at grid ${gridRef(x, y)}`;
  log(state, `${f.name} threw a temporary bridge across the river at grid ${gridRef(x, y)}.`);
  return state;
}

export function engineerClearAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || f.type !== 'ENGINEER') return state;
  if (!canAfford(state, 'ENGINEER_CLEAR')) return state;
  const tile = tileAt(state, x, y);
  if (!tile || distance(f.x, f.y, x, y) > 1) return state;
  spendAP(state, 'ENGINEER_CLEAR');
  const target = formationAt(state, x, y);
  if (target && target.owner !== f.owner) {
    target.fortified = false; // clearing enemy fortification/obstacles
  }
  f.hasActedThisTurn = true;
  f.lastOrder = `Cleared obstacles at grid ${gridRef(x, y)}`;
  log(state, `${f.name} cleared obstacles/fortifications at grid ${gridRef(x, y)}.`);
  return state;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

function lossFromDelta(delta: number): LossLevel {
  const d = Math.abs(delta);
  if (d < 2) return 'None';
  if (d < 12) return 'Light';
  if (d < 25) return 'Moderate';
  if (d < 45) return 'Heavy';
  return 'Destroyed';
}

/**
 * How well the attacker actually knows what it is attacking. Passive spotting
 * means you can nearly always SEE the enemy you are next to; the ladder is
 * what decides whether you are attacking a known formation or a shape in the
 * treeline. Recon is what buys the top rung.
 */
function intelLevel(state: GameState, attacker: PlayerId, target: Formation): DetectionLevel {
  const c = state.players[attacker].contacts[target.id];
  return c ? c.level : 'UNKNOWN';
}

function hasSupportingUnits(state: GameState, f: Formation): { infantry: boolean; armour: boolean; recon: boolean } {
  const near = Object.values(state.formations).filter(
    (o) => o.owner === f.owner && o.id !== f.id && distance(o.x, o.y, f.x, f.y) <= 1
  );
  return {
    infantry: near.some((o) => o.type === 'INFANTRY'),
    armour: near.some((o) => o.type === 'ARMOUR'),
    recon: near.some((o) => o.type === 'RECON'),
  };
}

export function computePower(
  state: GameState,
  f: Formation,
  role: 'attack' | 'defense',
  tile: Tile,
  factors: BattleFactor[],
  opts: { intel?: DetectionLevel; artillerySupport?: boolean; airSupport?: boolean } = {}
): number {
  const def = FORMATION_DEFS[f.type];
  const base = role === 'attack' ? def.baseAttack : def.baseDefense;
  let power = base * (f.strength / 100);
  factors.push({ label: `${def.label} base ${role}`, positive: true, magnitude: base });

  const mm = moraleMult(f.morale);
  power *= mm;
  if (mm !== 1) factors.push({ label: `Morale (${f.morale})`, positive: mm > 1, magnitude: Math.abs((mm - 1) * 100) });

  const readinessMult = 0.5 + (f.readiness / 100) * 0.5;
  power *= readinessMult;
  if (f.readiness < 70) factors.push({ label: `Low readiness (${Math.round(f.readiness)}%)`, positive: false, magnitude: (1 - readinessMult) * 100 });

  const supplyMult = f.supply < 30 ? 0.6 : f.supply < 60 ? 0.85 : 1;
  power *= supplyMult;
  if (supplyMult < 1) factors.push({ label: `Supply shortage (${Math.round(f.supply)}%)`, positive: false, magnitude: (1 - supplyMult) * 100 });

  if (def.maxAmmo !== null) {
    const ammoMult = f.ammo < 20 ? 0.5 : f.ammo < 50 ? 0.8 : 1;
    power *= ammoMult;
    if (ammoMult < 1) factors.push({ label: `Ammo shortage (${Math.round(f.ammo)}%)`, positive: false, magnitude: (1 - ammoMult) * 100 });
  }

  if (role === 'defense') {
    const terrainDef = TERRAIN_DEFS[tile.terrain];
    if (terrainDef.defenseBonus !== 0) {
      power *= 1 + terrainDef.defenseBonus;
      factors.push({ label: `${terrainDef.label} terrain`, positive: terrainDef.defenseBonus > 0, magnitude: Math.abs(terrainDef.defenseBonus) * 100 });
    }
    if (f.fortified) {
      power *= 1.3;
      factors.push({ label: 'Fortified position', positive: true, magnitude: 30 });
    }
  }

  if (role === 'attack' && opts.intel) {
    // Attacking what you have merely *detected* is materially worse than
    // attacking a formation you have identified, or confirmed with recon.
    if (opts.intel === 'CONTACT' || opts.intel === 'UNKNOWN') {
      power *= 0.6;
      factors.push({ label: 'Target unidentified — contact only', positive: false, magnitude: 40 });
    } else if (opts.intel === 'IDENTIFIED') {
      power *= 0.88;
      factors.push({ label: 'Target identified but not confirmed', positive: false, magnitude: 12 });
    } else {
      factors.push({ label: 'Target confirmed by reconnaissance', positive: true, magnitude: 0 });
    }
  }

  const support = hasSupportingUnits(state, f);
  if (f.type !== 'RECON' && ((support.infantry && support.armour) || (support.recon && (support.infantry || support.armour)))) {
    power *= 1.15;
    factors.push({ label: 'Combined-arms support', positive: true, magnitude: 15 });
  }

  if (opts.artillerySupport) {
    power *= 1.2;
    factors.push({ label: 'Artillery support fire', positive: true, magnitude: 20 });
  }
  if (opts.airSupport) {
    power *= 1.25;
    factors.push({ label: 'Air support strike', positive: true, magnitude: 25 });
  }

  return Math.max(0.1, power);
}

export function attackAction(state: GameState, attackerId: string, targetId: string): GameState {
  const attacker = state.formations[attackerId];
  const target = state.formations[targetId];
  if (!attacker || !target) return state;
  if (attacker.owner !== state.activePlayer || attacker.hasActedThisTurn) return state;
  if (target.owner === attacker.owner) return state;
  if (!canAfford(state, 'ATTACK')) return state;

  const attackerDef = FORMATION_DEFS[attacker.type];
  const range = attackerDef.attackRange;
  const d = distance(attacker.x, attacker.y, target.x, target.y);
  if (d < 1 || d > range) return state;
  // Only a close assault (range-1 engagement) can take ground; standoff fire
  // from a ship or a gun battalion damages but does not occupy.
  const closeAssault = d === 1 && !attackerDef.isNaval;

  spendAP(state, 'ATTACK');

  const attackerFactors: BattleFactor[] = [];
  const defenderFactors: BattleFactor[] = [];
  const intel = intelLevel(state, attacker.owner, target);
  const attackerTile = state.tiles[attacker.y][attacker.x];
  const defenderTile = state.tiles[target.y][target.x];

  const attackerPower = computePower(state, attacker, 'attack', attackerTile, attackerFactors, { intel });
  const defenderPower = computePower(state, target, 'defense', defenderTile, defenderFactors);

  const roll = Math.round((Math.random() * 2 - 1) * 15); // -15..+15
  const rollMult = 1 + roll / 100;
  const finalAttacker = attackerPower * rollMult;

  const factors: BattleFactor[] = [
    ...attackerFactors.map((f) => ({ ...f, side: 'attacker' as const })),
    ...defenderFactors.map((f) => ({ ...f, side: 'defender' as const })),
    { label: `Combat roll ${roll >= 0 ? '+' : ''}${roll}%`, positive: roll >= 0, magnitude: Math.abs(roll), side: 'attacker' as const },
  ];

  const ratio = finalAttacker / (defenderPower + finalAttacker);
  // ratio near 1 = attacker dominates, near 0 = defender dominates.
  let outcome: BattleReport['outcome'];
  let attackerDelta = 0;
  let defenderDelta = 0;
  let captured = false;

  if (ratio > 0.65 && closeAssault) {
    outcome = 'Position Captured';
    defenderDelta = -(20 + (ratio - 0.65) * 80);
    attackerDelta = -(5 + (1 - ratio) * 20);
    captured = true;
  } else if (ratio > 0.5) {
    outcome = 'Defender Repelled';
    defenderDelta = -(10 + (ratio - 0.5) * 60);
    attackerDelta = -(8 + (1 - ratio) * 15);
  } else if (ratio > 0.35) {
    outcome = 'Mutual Attrition';
    defenderDelta = -(8 + ratio * 10);
    attackerDelta = -(12 + (0.5 - ratio) * 30);
  } else {
    outcome = 'Attack Repulsed';
    attackerDelta = -(20 + (0.35 - ratio) * 60);
    defenderDelta = -(4 + ratio * 10);
  }

  attackerDelta = Math.max(-60, attackerDelta);
  defenderDelta = Math.max(-60, defenderDelta);

  attacker.strength = Math.max(0, Math.min(100, attacker.strength + attackerDelta));
  target.strength = Math.max(0, Math.min(100, target.strength + defenderDelta));
  if (FORMATION_DEFS[attacker.type].maxAmmo !== null) attacker.ammo = Math.max(0, attacker.ammo - 15);

  const attackerLoss = lossFromDelta(attackerDelta);
  const defenderLoss = lossFromDelta(defenderDelta);

  // --- Morale. Routine engagements cost nothing; only heavy casualties, a
  // major failed attack, or being driven off ground register as shocks.
  attacker.lastEngagedRound = state.round;
  target.lastEngagedRound = state.round;
  applyMoraleShock(state, attacker, casualtyShock(attackerDelta), 'casualties in the assault');
  applyMoraleShock(state, target, casualtyShock(defenderDelta), 'casualties under attack');
  if (outcome === 'Attack Repulsed' && attackerLoss !== 'None' && attackerLoss !== 'Light') {
    applyMoraleShock(state, attacker, MORALE_SHOCKS.ATTACK_REPULSED, 'major attack repulsed');
  }
  if (captured) {
    applyMoraleShock(state, attacker, MORALE_SHOCKS.ASSAULT_SUCCESS, 'position taken by assault');
    applyMoraleShock(state, target, MORALE_SHOCKS.POSITION_LOST, 'driven off its position');
  }

  let destroyedTarget = false;
  if (target.strength <= 0 || captured) {
    destroyedTarget = target.strength <= 0;
    if (captured || destroyedTarget) {
      if (destroyedTarget) mourn(state, target);
      delete state.formations[target.id];
      if (captured && !destroyedTarget) {
        // survives but retreats off the tile — simplified as removal from board for prototype clarity
      }
      if (closeAssault) {
        attacker.x = target.x;
        attacker.y = target.y;
      }
    }
  }
  if (attacker.strength <= 0) {
    mourn(state, attacker);
    delete state.formations[attacker.id];
  }

  attacker.hasActedThisTurn = true;
  attacker.fortified = false;
  attacker.lastOrder = closeAssault ? `Assaulted ${target.shortName}` : `Engaged ${target.shortName} at range`;

  const report: BattleReport = {
    id: nextId('battle'),
    attackerId,
    defenderId: targetId,
    attackerName: attacker.name ?? 'Unknown',
    defenderName: target.name ?? 'Unknown',
    outcome,
    attackerPower: finalAttacker,
    defenderPower,
    roll,
    factors,
    attackerLoss,
    defenderLoss,
    attackerStrengthDelta: attackerDelta,
    defenderStrengthDelta: defenderDelta,
    captured,
    attackerX: attackerTile.x,
    attackerY: attackerTile.y,
    defenderX: defenderTile.x,
    defenderY: defenderTile.y,
  };
  state.lastBattleReport = report;
  log(state, `${report.attackerName} attacked ${report.defenderName}: ${outcome}.`, 'ALL');
  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// Artillery / Air / Special ops / Amphibious
// ---------------------------------------------------------------------------

export function artilleryAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || f.type !== 'ARTILLERY') return state;
  if (!canAfford(state, 'ARTILLERY')) return state;
  if (f.ammo < 10) {
    log(state, `${f.name} lacks ammunition for a fire mission.`);
    return state;
  }
  const d = distance(f.x, f.y, x, y);
  if (d > FORMATION_DEFS.ARTILLERY.attackRange) return state;
  const target = formationAt(state, x, y);
  if (!target || target.owner === f.owner) return state;
  spendAP(state, 'ARTILLERY');
  f.ammo = Math.max(0, f.ammo - 25);
  f.hasActedThisTurn = true;
  f.lastOrder = `Fire mission on grid ${gridRef(x, y)}`;

  const factors: BattleFactor[] = [];
  const power = computePower(state, f, 'attack', state.tiles[f.y][f.x], factors) * 0.5;
  const delta = -Math.min(35, 10 + power);
  target.strength = Math.max(0, target.strength + delta);
  target.lastEngagedRound = state.round;
  // Indirect fire is harassing: it carries half the morale weight of a
  // stand-up assault, and a light stonk carries none at all.
  applyMoraleShock(state, target, casualtyShock(delta, 0.5), 'under artillery fire');
  log(state, `${f.name} fire mission struck ${target.name} at grid ${gridRef(x, y)} — ${lossFromDelta(delta)} losses.`, 'ALL');
  if (target.strength <= 0) {
    mourn(state, target);
    delete state.formations[target.id];
  }
  refreshAllSpotting(state);
  return state;
}

export function airStrikeAction(state: GameState, x: number, y: number): GameState {
  const ps = state.players[state.activePlayer];
  if (!canAfford(state, 'AIR') || ps.airSorties < 1) return state;
  const target = formationAt(state, x, y);
  if (!target || target.owner === state.activePlayer) return state;
  spendAP(state, 'AIR');
  ps.airSorties -= 1;
  const delta = -(15 + Math.random() * 20);
  target.strength = Math.max(0, target.strength + delta);
  target.lastEngagedRound = state.round;
  applyMoraleShock(state, target, casualtyShock(delta, 0.5), 'under air attack');
  log(state, `Air strike (F-15SG/F-16 flight) hit ${target.name} at grid ${gridRef(x, y)} — ${lossFromDelta(delta)} losses.`, 'ALL');
  if (target.strength <= 0) {
    mourn(state, target);
    delete state.formations[target.id];
  }
  refreshAllSpotting(state);
  return state;
}

export function specialOpAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || f.type !== 'COMMANDO') return state;
  if (!canAfford(state, 'SPECIAL_OP')) return state;
  const d = distance(f.x, f.y, x, y);
  if (d > SPECIAL_OP_RANGE) return state;
  spendAP(state, 'SPECIAL_OP');
  f.hasActedThisTurn = true;
  const target = formationAt(state, x, y);
  if (target && target.owner !== f.owner) {
    const delta = -(18 + Math.random() * 15);
    target.strength = Math.max(0, target.strength + delta);
    target.lastEngagedRound = state.round;
    applyMoraleShock(state, target, casualtyShock(delta, 0.5), 'raided behind the lines');
    f.lastOrder = `Special op raid on grid ${gridRef(x, y)}`;
    log(state, `${f.name} conducted a special-ops raid on ${target.name} — ${lossFromDelta(delta)} losses.`, 'ALL');
    if (target.strength <= 0) {
      mourn(state, target);
      delete state.formations[target.id];
    }
  } else {
    // A deep probe: the patrol is treated as observing from the target tile,
    // so it confirms whatever is around the objective it was sent to look at.
    const spotter: Formation = { ...f, x, y };
    const res = deepProbe(state, spotter, 3);
    f.lastOrder = `Deep recon at grid ${gridRef(x, y)} — ${res} contact${res === 1 ? '' : 's'}`;
    log(state, `${f.name} conducted a deep-recon special operation near grid ${gridRef(x, y)}.`);
  }
  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// Objectives, supply tick, turn management
// ---------------------------------------------------------------------------

function tickObjectives(state: GameState, awardVp: boolean) {
  state.objectives.forEach((o) => {
    const occupants = Object.values(state.formations).filter((f) => {
      if (distance(f.x, f.y, o.x, o.y) > 1) return false;
      // A maritime objective is contested by warships; a land objective by
      // ground forces. A frigate cannot "hold" a bridge.
      return FORMATION_DEFS[f.type].isNaval === !!o.maritime;
    });
    const sides = new Set(occupants.map((f) => f.owner));
    if (sides.size === 1) {
      const side = [...sides][0];
      if (o.controlledBy !== side) {
        const previous = o.controlledBy;
        o.controlledBy = side;
        log(state, `${side} secured objective: ${o.name} (grid ${gridRef(o.x, o.y)}).`, 'ALL');
        // Taking ground lifts the units that took it; losing an objective you
        // held is one of the few things that genuinely knocks a force back.
        occupants
          .filter((f) => f.owner === side)
          .forEach((f) => applyMoraleShock(state, f, MORALE_SHOCKS.OBJECTIVE_TAKEN, `captured ${o.name}`));
        if (previous) {
          friendsNear(state, previous, o.x, o.y).forEach((f) =>
            applyMoraleShock(state, f, MORALE_SHOCKS.OBJECTIVE_LOST, `${o.name} lost`)
          );
        }
      }
    }
    // VP are paid out once per ROUND, to both holders at once, at the end of
    // the round. Paying each side at the end of its own turn would give the
    // first player half a round of free scoring every single round.
    if (awardVp && o.controlledBy) {
      state.players[o.controlledBy].vp += o.vpPerTurn;
    }
  });
}

function tickSupply(state: GameState, owner: PlayerId) {
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== owner) return;
    if (FORMATION_DEFS[f.type].isNaval) {
      // Warships carry their own stores — no shore logistics to babysit.
      f.supply = Math.min(100, f.supply + 10);
      f.readiness = Math.min(100, f.readiness + 8);
      return;
    }
    if (isInSupplyRange(state, f)) {
      f.supply = Math.min(100, f.supply + 15);
      f.readiness = Math.min(100, f.readiness + 10);
    } else {
      f.supply = Math.max(0, f.supply - 12);
      f.readiness = Math.max(20, f.readiness - 8);
      // Morale is NOT touched here — supply pressure feeds the morale tick as a
      // named, gradual shock instead of a per-turn band demotion.
    }
  });
}

/**
 * Victory is only adjudicated at a ROUND boundary (after REDFOR's turn), so
 * both sides have banked the same number of scoring turns — otherwise BLUEFOR,
 * who always scores first, would cross the threshold half a round early every
 * single game.
 */
function checkVictory(state: GameState, roundComplete: boolean) {
  if (!roundComplete) return;
  const b = state.players.BLUEFOR.vp;
  const r = state.players.REDFOR.vp;
  if (b >= VP_WIN_THRESHOLD || r >= VP_WIN_THRESHOLD) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'BLUEFOR' : 'REDFOR';
    log(state, `Victory point threshold reached. Winner: ${state.winner}.`, 'ALL');
  } else if (state.round > MAX_ROUNDS) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'BLUEFOR' : 'REDFOR';
    log(state, `Final round complete. Winner: ${state.winner}.`, 'ALL');
  }
}

export function endTurn(state: GameState): GameState {
  const finishing = state.activePlayer;
  tickObjectives(state, finishing === 'REDFOR');
  tickSupply(state, finishing);
  tickMorale(state, finishing);
  if (finishing === 'REDFOR') state.round += 1;
  // Reset the finishing side's per-round budgets so everything is fresh when
  // control comes back to them.
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== finishing) return;
    f.hasActedThisTurn = false;
    f.movesUsed = 0;
  });
  const nextPlayer = otherPlayer(finishing);
  const carry = Math.min(AP_CAP, state.players[nextPlayer].ap + AP_PER_TURN);
  state.players[nextPlayer].ap = carry;
  state.players[nextPlayer].airSorties = AIR_SORTIES_PER_TURN;
  state.activePlayer = nextPlayer;
  refreshAllSpotting(state);
  checkVictory(state, finishing === 'REDFOR');
  if (state.phase !== 'GAME_OVER') state.phase = 'TURN_HANDOFF';
  log(state, `Turn passed to ${nextPlayer}. Round ${state.round}.`, 'ALL');
  return state;
}

export function beginPlayerTurn(state: GameState): GameState {
  // Never resurrect a finished game — endTurn() may have just declared a
  // winner, and the server calls this immediately afterwards.
  if (state.phase === 'GAME_OVER') return state;
  state.phase = 'PLAYING';
  return state;
}
