// ============================================================================
// COMMAND — Pure game engine. No rendering / DOM here.
// All functions take a GameState and mutate-then-return it (caller is
// expected to clone the state before calling a mutator, see store.ts).
// ============================================================================

import { FORMATION_DEFS, MORALE_MULTIPLIER, TERRAIN_DEFS } from './data';
import { generateBattlefield } from './mapgen';
import {
  AP_COSTS,
  AP_PER_TURN,
  AIR_SORTIES_PER_TURN,
  ActionKind,
  BattleFactor,
  BattleReport,
  Contact,
  Formation,
  FormationType,
  GameState,
  GRID_SIZE,
  LossLevel,
  Morale,
  Objective,
  PlayerId,
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

const ROSTER: { type: FormationType; name: string }[] = [
  { type: 'INFANTRY', name: '1st Infantry Coy' },
  { type: 'INFANTRY', name: '2nd Infantry Coy' },
  { type: 'COMMANDO', name: 'Commando Det.' },
  { type: 'ARMOUR', name: 'Armour Sqn' },
  { type: 'ARTILLERY', name: 'Artillery Bty' },
  { type: 'ENGINEER', name: 'Engineer Det.' },
  { type: 'RECON', name: 'Recon Det.' },
  { type: 'LOGISTICS', name: 'Log. Element' },
];

function makeFormation(owner: PlayerId, type: FormationType, name: string, x: number, y: number): Formation {
  return {
    id: nextId('f'),
    owner,
    type,
    name,
    x,
    y,
    strength: 100,
    morale: 'Steady',
    readiness: 100,
    supply: 100,
    ammo: 100,
    hasActedThisTurn: false,
    fortified: false,
    lastOrder: 'Deployed',
  };
}

export function initGame(seed = 1337): GameState {
  const map = generateBattlefield(seed);
  const formations: Record<string, Formation> = {};

  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((side) => {
    const zones = map.startZones[side];
    ROSTER.forEach((r, i) => {
      const pos = zones[i % zones.length];
      const f = makeFormation(side, r.type, `${side === 'BLUEFOR' ? 'BF' : 'RF'} ${r.name}`, pos.x, pos.y);
      formations[f.id] = f;
    });
    const port = map.ports.find((p) => p.owner === side)!;
    const naval = makeFormation(side, 'NAVAL_TRANSPORT', `${side === 'BLUEFOR' ? 'BF' : 'RF'} Naval Transport`, port.x, port.y);
    const frigate = makeFormation(side, 'FRIGATE', `${side === 'BLUEFOR' ? 'BF' : 'RF'} Frigate`, port.x, port.y + 1);
    formations[naval.id] = naval;
    formations[frigate.id] = frigate;
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
    log: ['Operation begins. BLUEFOR moves first.'],
    phase: 'PLAYING',
    winner: null,
    lastBattleReport: null,
  };

  refreshFogOfWar(state, 'BLUEFOR');
  refreshFogOfWar(state, 'REDFOR');
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tileAt(state: GameState, x: number, y: number): Tile | undefined {
  return state.tiles[y]?.[x];
}

export function formationAt(state: GameState, x: number, y: number): Formation | undefined {
  return Object.values(state.formations).find((f) => f.x === x && f.y === y && !f.embarkedOn);
}

function inBounds(x: number, y: number) {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

function neighbors(x: number, y: number): [number, number][] {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].filter(([nx, ny]) => inBounds(nx, ny)) as [number, number][];
}

export function distance(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

function moraleMult(m: Morale) {
  return MORALE_MULTIPLIER[m];
}

function crossable(state: GameState, formation: Formation, tile: Tile): boolean {
  const def = FORMATION_DEFS[formation.type];
  if (tile.terrain === 'WATER') {
    if (tile.bridge) return true;
    return def.isNaval; // naval units can enter open water freely
  }
  if (def.isNaval) return false; // naval units restricted to water + port tiles they start on
  return true;
}

/** Dijkstra-style reachable-tile search bounded by the formation's move range. */
export function computeReachable(state: GameState, formationId: string): Map<string, number> {
  const f = state.formations[formationId];
  const result = new Map<string, number>();
  if (!f || f.hasActedThisTurn) return result;
  const def = FORMATION_DEFS[f.type];
  const budget = def.moveRange * (f.readiness < 50 ? 0.6 : 1) * (f.supply < 30 ? 0.6 : 1);
  const visited = new Map<string, number>();
  const frontier: { x: number; y: number; cost: number }[] = [{ x: f.x, y: f.y, cost: 0 }];
  visited.set(`${f.x},${f.y}`, 0);
  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    for (const [nx, ny] of neighbors(cur.x, cur.y)) {
      const tile = state.tiles[ny][nx];
      if (!crossable(state, f, tile)) continue;
      const occupant = formationAt(state, nx, ny);
      if (occupant && occupant.owner !== f.owner) continue; // can't move through/onto enemy
      const terrainDef = TERRAIN_DEFS[tile.terrain];
      let cost = tile.terrain === 'WATER' ? 1 : terrainDef.moveCost;
      if (tile.road && tile.terrain !== 'WATER') cost = 0.5;
      const newCost = cur.cost + cost;
      if (newCost > budget) continue;
      const key = `${nx},${ny}`;
      if (!visited.has(key) || visited.get(key)! > newCost) {
        visited.set(key, newCost);
        frontier.push({ x: nx, y: ny, cost: newCost });
      }
    }
  }
  visited.delete(`${f.x},${f.y}`);
  visited.forEach((v, k) => result.set(k, v));
  return result;
}

// ---------------------------------------------------------------------------
// AP / action gating
// ---------------------------------------------------------------------------

export function canAfford(state: GameState, kind: ActionKind): boolean {
  return state.players[state.activePlayer].ap >= AP_COSTS[kind];
}

function spendAP(state: GameState, kind: ActionKind) {
  state.players[state.activePlayer].ap -= AP_COSTS[kind];
}

function log(state: GameState, msg: string) {
  state.log.unshift(msg);
  if (state.log.length > 60) state.log.pop();
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export function moveFormation(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!canAfford(state, 'MOVE')) return state;
  const reachable = computeReachable(state, formationId);
  if (!reachable.has(`${x},${y}`)) return state;
  spendAP(state, 'MOVE');
  f.x = x;
  f.y = y;
  f.fortified = false;
  f.hasActedThisTurn = true;
  f.lastOrder = `Moved to (${x},${y})`;
  log(state, `${f.name} moved to (${x}, ${y}).`);
  refreshFogOfWar(state, state.activePlayer);
  return state;
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

export function refreshFogOfWar(state: GameState, player: PlayerId) {
  const ps = state.players[player];
  const enemy = otherPlayer(player);
  const visibleNow = new Set<string>();

  Object.values(state.formations)
    .filter((f) => f.owner === player && !f.embarkedOn)
    .forEach((f) => {
      const def = FORMATION_DEFS[f.type];
      Object.values(state.formations)
        .filter((e) => e.owner === enemy && !e.embarkedOn)
        .forEach((e) => {
          if (distance(f.x, f.y, e.x, e.y) <= def.sightRadius) {
            visibleNow.add(e.id);
          }
        });
    });

  visibleNow.forEach((id) => {
    const e = state.formations[id];
    ps.contacts[id] = {
      formationId: id,
      owner: e.owner,
      type: e.type,
      x: e.x,
      y: e.y,
      confidence: 100,
      lastSeenTurn: state.round,
      source: 'Visual Contact',
    };
  });

  // Decay confidence on contacts not currently visible.
  Object.values(ps.contacts).forEach((c) => {
    if (!visibleNow.has(c.formationId)) {
      const turnsSince = state.round - c.lastSeenTurn;
      c.confidence = Math.max(0, 100 - turnsSince * 20);
      if (c.confidence <= 0) delete ps.contacts[c.formationId];
    }
  });
}

export function reconAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!canAfford(state, 'RECON')) return state;
  spendAP(state, 'RECON');
  const def = FORMATION_DEFS[f.type];
  const enemy = otherPlayer(f.owner);
  const ps = state.players[f.owner];
  const source = f.type === 'COMMANDO' ? 'Commando Recon' : 'Recon Sweep';
  Object.values(state.formations)
    .filter((e) => e.owner === enemy)
    .forEach((e) => {
      if (distance(f.x, f.y, e.x, e.y) <= def.reconRadius) {
        ps.contacts[e.id] = {
          formationId: e.id,
          owner: e.owner,
          type: e.type,
          x: e.x,
          y: e.y,
          confidence: f.type === 'COMMANDO' ? 100 : 90,
          lastSeenTurn: state.round,
          source,
        };
      }
    });
  f.hasActedThisTurn = true;
  f.lastOrder = 'Conducted recon sweep';
  log(state, `${f.name} conducted a recon sweep.`);
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

export function isInSupplyRange(state: GameState, f: Formation): boolean {
  // In range if within a road-connected radius of a friendly depot, or adjacent
  // to a friendly Logistics formation.
  const depotTiles = state.tiles.flat().filter((t) => t.isDepot && t.depotOwner === f.owner);
  for (const d of depotTiles) {
    if (distance(f.x, f.y, d.x, d.y) <= 10) return true;
  }
  const logi = Object.values(state.formations).find(
    (o) => o.owner === f.owner && o.type === 'LOGISTICS' && distance(o.x, o.y, f.x, f.y) <= 3
  );
  return !!logi;
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
  f.lastOrder = `Built a bridge at (${x},${y})`;
  log(state, `${f.name} threw a temporary bridge across the river at (${x}, ${y}).`);
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
  f.lastOrder = `Cleared obstacles at (${x},${y})`;
  log(state, `${f.name} cleared obstacles/fortifications at (${x}, ${y}).`);
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

function isRevealed(state: GameState, attacker: PlayerId, target: Formation): boolean {
  const c = state.players[attacker].contacts[target.id];
  return !!c && c.confidence >= 40;
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
  opts: { revealed?: boolean; artillerySupport?: boolean; airSupport?: boolean } = {}
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

  if (role === 'attack' && opts.revealed === false) {
    power *= 0.6;
    factors.push({ label: 'Target not fully revealed by recon', positive: false, magnitude: 40 });
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

function applyMoraleShift(f: Formation, won: boolean, lossLevel: LossLevel) {
  const order: Morale[] = ['Broken', 'Shaken', 'Stressed', 'Steady', 'Elite'];
  let idx = order.indexOf(f.morale);
  if (!won || lossLevel === 'Heavy' || lossLevel === 'Destroyed') idx = Math.max(0, idx - 1);
  else if (won && (lossLevel === 'None' || lossLevel === 'Light')) idx = Math.min(order.length - 1, idx + (Math.random() < 0.3 ? 1 : 0));
  f.morale = order[idx];
}

export function attackAction(state: GameState, attackerId: string, targetId: string): GameState {
  const attacker = state.formations[attackerId];
  const target = state.formations[targetId];
  if (!attacker || !target) return state;
  if (attacker.owner !== state.activePlayer || attacker.hasActedThisTurn) return state;
  if (target.owner === attacker.owner) return state;
  if (!canAfford(state, 'ATTACK')) return state;

  const isArtillery = attacker.type === 'ARTILLERY';
  const range = isArtillery ? 6 : 1;
  const d = distance(attacker.x, attacker.y, target.x, target.y);
  if (d > range) return state;
  if (!isArtillery && d !== 1) return state; // non-artillery must be adjacent (orthogonal range=1 via distance metric covers diagonal too loosely, acceptable for prototype)

  spendAP(state, 'ATTACK');

  const attackerFactors: BattleFactor[] = [];
  const defenderFactors: BattleFactor[] = [];
  const revealed = isRevealed(state, attacker.owner, target);
  const attackerTile = state.tiles[attacker.y][attacker.x];
  const defenderTile = state.tiles[target.y][target.x];

  const attackerPower = computePower(state, attacker, 'attack', attackerTile, attackerFactors, { revealed });
  const defenderPower = computePower(state, target, 'defense', defenderTile, defenderFactors);

  const roll = Math.round((Math.random() * 2 - 1) * 15); // -15..+15
  const rollMult = 1 + roll / 100;
  const finalAttacker = attackerPower * rollMult;

  const factors = [...attackerFactors, ...defenderFactors, { label: `Combat roll ${roll >= 0 ? '+' : ''}${roll}%`, positive: roll >= 0, magnitude: Math.abs(roll) }];

  const ratio = finalAttacker / (defenderPower + finalAttacker);
  // ratio near 1 = attacker dominates, near 0 = defender dominates.
  let outcome: BattleReport['outcome'];
  let attackerDelta = 0;
  let defenderDelta = 0;
  let captured = false;

  if (ratio > 0.65) {
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
  applyMoraleShift(attacker, outcome === 'Position Captured' || outcome === 'Defender Repelled', attackerLoss);
  applyMoraleShift(target, false, defenderLoss);

  let destroyedTarget = false;
  if (target.strength <= 0 || captured) {
    destroyedTarget = target.strength <= 0;
    if (captured || destroyedTarget) {
      delete state.formations[target.id];
      if (captured && !destroyedTarget) {
        // survives but retreats off the tile — simplified as removal from board for prototype clarity
      }
      attacker.x = target.x;
      attacker.y = target.y;
    }
  }
  if (attacker.strength <= 0) {
    delete state.formations[attacker.id];
  }

  attacker.hasActedThisTurn = true;
  attacker.fortified = false;
  attacker.lastOrder = `Attacked ${target.name}`;

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
  };
  state.lastBattleReport = report;
  log(state, `${report.attackerName} attacked ${report.defenderName}: ${outcome}.`);
  refreshFogOfWar(state, state.activePlayer);
  refreshFogOfWar(state, otherPlayer(state.activePlayer));
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
  if (d > 6) return state;
  const target = formationAt(state, x, y);
  if (!target || target.owner === f.owner) return state;
  spendAP(state, 'ARTILLERY');
  f.ammo = Math.max(0, f.ammo - 25);
  f.hasActedThisTurn = true;
  f.lastOrder = `Fire mission on (${x},${y})`;

  const factors: BattleFactor[] = [];
  const power = computePower(state, f, 'attack', state.tiles[f.y][f.x], factors) * 0.5;
  const delta = -Math.min(35, 10 + power);
  target.strength = Math.max(0, target.strength + delta);
  applyMoraleShift(target, false, lossFromDelta(delta));
  log(state, `${f.name} fire mission struck ${target.name} at (${x}, ${y}) — ${lossFromDelta(delta)} losses.`);
  if (target.strength <= 0) delete state.formations[target.id];
  refreshFogOfWar(state, otherPlayer(f.owner));
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
  applyMoraleShift(target, false, lossFromDelta(delta));
  log(state, `Air strike (F-15SG/F-16 flight) hit ${target.name} at (${x}, ${y}) — ${lossFromDelta(delta)} losses.`);
  if (target.strength <= 0) delete state.formations[target.id];
  refreshFogOfWar(state, otherPlayer(state.activePlayer));
  return state;
}

export function specialOpAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || f.type !== 'COMMANDO') return state;
  if (!canAfford(state, 'SPECIAL_OP')) return state;
  const d = distance(f.x, f.y, x, y);
  const def = FORMATION_DEFS['COMMANDO'];
  if (d > def.reconRadius) return state;
  spendAP(state, 'SPECIAL_OP');
  f.hasActedThisTurn = true;
  const target = formationAt(state, x, y);
  if (target && target.owner !== f.owner) {
    const delta = -(18 + Math.random() * 15);
    target.strength = Math.max(0, target.strength + delta);
    applyMoraleShift(target, false, lossFromDelta(delta));
    f.lastOrder = `Special op raid on (${x},${y})`;
    log(state, `${f.name} conducted a special-ops raid on ${target.name} — ${lossFromDelta(delta)} losses.`);
    if (target.strength <= 0) delete state.formations[target.id];
  } else {
    const enemy = otherPlayer(f.owner);
    const ps = state.players[f.owner];
    Object.values(state.formations)
      .filter((e) => e.owner === enemy && distance(e.x, e.y, x, y) <= 3)
      .forEach((e) => {
        ps.contacts[e.id] = { formationId: e.id, owner: e.owner, type: e.type, x: e.x, y: e.y, confidence: 100, lastSeenTurn: state.round, source: 'Commando Recon' };
      });
    f.lastOrder = `Deep recon at (${x},${y})`;
    log(state, `${f.name} conducted a deep-recon special operation near (${x}, ${y}).`);
  }
  refreshFogOfWar(state, otherPlayer(f.owner));
  return state;
}

export function amphibiousAction(state: GameState, transportId: string, cargoId: string, x: number, y: number): GameState {
  const transport = state.formations[transportId];
  const cargo = state.formations[cargoId];
  if (!transport || !cargo) return state;
  if (transport.owner !== state.activePlayer || transport.type !== 'NAVAL_TRANSPORT') return state;
  if (!canAfford(state, 'AMPHIBIOUS')) return state;
  const destTile = tileAt(state, x, y);
  if (!destTile || (destTile.terrain !== 'PORT' && distance(x, y, transport.x, transport.y) > 1)) return state;
  spendAP(state, 'AMPHIBIOUS');
  cargo.x = x;
  cargo.y = y;
  cargo.embarkedOn = undefined;
  cargo.hasActedThisTurn = true;
  transport.hasActedThisTurn = true;
  transport.lastOrder = `Landed ${cargo.name} at (${x},${y})`;
  log(state, `${transport.name} landed ${cargo.name} at (${x}, ${y}).`);
  refreshFogOfWar(state, state.activePlayer);
  return state;
}

// ---------------------------------------------------------------------------
// Objectives, logistics tick, turn management
// ---------------------------------------------------------------------------

function tickObjectives(state: GameState) {
  state.objectives.forEach((o) => {
    const occupants = Object.values(state.formations).filter((f) => distance(f.x, f.y, o.x, o.y) <= 1 && !f.embarkedOn);
    const sides = new Set(occupants.map((f) => f.owner));
    if (sides.size === 1) {
      const side = [...sides][0];
      if (o.controlledBy !== side) {
        o.controlledBy = side;
        log(state, `${side} secured objective: ${o.name}.`);
      }
    }
    if (o.controlledBy) {
      state.players[o.controlledBy].vp += o.vpPerTurn;
    }
  });
}

function tickSupply(state: GameState) {
  Object.values(state.formations).forEach((f) => {
    if (isInSupplyRange(state, f)) {
      f.supply = Math.min(100, f.supply + 15);
      f.readiness = Math.min(100, f.readiness + 10);
    } else {
      f.supply = Math.max(0, f.supply - 12);
      f.readiness = Math.max(20, f.readiness - 8);
      if (f.supply < 20) {
        f.morale = f.morale === 'Elite' ? 'Steady' : f.morale === 'Steady' ? 'Stressed' : f.morale;
      }
    }
  });
}

function checkVictory(state: GameState) {
  const b = state.players.BLUEFOR.vp;
  const r = state.players.REDFOR.vp;
  if (b >= 150 || r >= 150) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'BLUEFOR' : 'REDFOR';
    log(state, `Victory point threshold reached. Winner: ${state.winner}.`);
  } else if (state.round >= 20) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'BLUEFOR' : 'REDFOR';
    log(state, `Final round complete. Winner: ${state.winner}.`);
  }
}

export function endTurn(state: GameState): GameState {
  const finishing = state.activePlayer;
  tickObjectives(state);
  if (finishing === 'REDFOR') {
    tickSupply(state);
    state.round += 1;
  }
  Object.values(state.formations).forEach((f) => {
    if (f.owner === finishing) f.hasActedThisTurn = false;
  });
  const nextPlayer = otherPlayer(finishing);
  const carry = Math.min(25, state.players[nextPlayer].ap + AP_PER_TURN);
  state.players[nextPlayer].ap = carry;
  state.players[nextPlayer].airSorties = AIR_SORTIES_PER_TURN;
  state.activePlayer = nextPlayer;
  refreshFogOfWar(state, nextPlayer);
  checkVictory(state);
  if (state.phase !== 'GAME_OVER') state.phase = 'TURN_HANDOFF';
  log(state, `Turn passed to ${nextPlayer}. Round ${state.round}.`);
  return state;
}

export function beginPlayerTurn(state: GameState): GameState {
  state.phase = 'PLAYING';
  return state;
}
