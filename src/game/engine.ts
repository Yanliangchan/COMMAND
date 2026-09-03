// ============================================================================
// COMMAND — Pure game engine. No rendering / DOM here.
// All functions take a GameState and mutate-then-return it (caller is
// expected to clone the state before calling a mutator, see store.ts).
// ============================================================================

import { EXERCISE_NAME, FACTION_NAMES, FORMATION_DEFS, ORDERS_OF_BATTLE } from './data';
import {
  COMBAT_ROLL_PCT,
  STANDOFF_RETURN_FIRE,
  attackPower,
  defencePower,
  lossFromDelta,
  lossesFromShare,
  predictEngagement,
} from './combat';
import { generateBattlefield } from './mapgen';
import {
  computeReachable as computeReachableTiles,
  cohesionAdvisory,
  planGroupMove,
  planMove,
} from './movement';
import { deepProbe, reconSweep, refreshAllSpotting, refreshSpotting } from './detection';
import {
  AMMO_REGEN_PER_ROUND,
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
  PlayerId,
  SPECIAL_OP_RANGE,
  SPECIAL_OP_RANGE_BY_TYPE,
  SPECIAL_OP_TYPES,
  Tile,
  otherPlayer,
} from './types';

/** Deterministic, well-mixed coin flip on the map seed (murmur3 finaliser). */
function initiativeRoll(seed: number): boolean {
  let h = seed >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h & 1) === 1;
}

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
    ammo: def.maxAmmo ?? 0,
    lastFiredRound: 0,
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

  (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((side) => {
    const landSlots = [...map.startZones[side]];
    const seaSlots = [...map.navalSpawns[side]];
    ORDERS_OF_BATTLE[side].forEach((profile, i) => {
      const naval = FORMATION_DEFS[profile.type].isNaval;
      const pos = naval ? seaSlots.shift() ?? seaSlots[0] : landSlots.shift() ?? landSlots[landSlots.length - 1];
      const f = makeFormation(side, i, pos.x, pos.y);
      formations[f.id] = f;
    });
  });

  // ---- Initiative ---------------------------------------------------------
  // Phase 5. Moving first in a sequential turn-based game is worth something:
  // the side with the initiative reaches the contested ground first and makes
  // the other side attack into it. Measured over seeded bot-vs-bot games that
  // tempo is worth roughly +22 VP a game to whoever has it — a real, permanent
  // advantage if one named side always gets it.
  //
  // So initiative is ROLLED, deterministically from the map seed, exactly the
  // way a wargame rolls for it. Neither task force is systematically the
  // attacker, and because the server already assigns seats by a coin flip, no
  // human player is affected either way.
  const first: PlayerId = initiativeRoll(seed) ? 'VANGUARD' : 'SABRE';

  const state: GameState = {
    round: 1,
    activePlayer: first,
    initiative: first,
    tiles: map.tiles,
    formations,
    objectives: map.objectives,
    players: {
      SABRE: { id: 'SABRE', ap: AP_PER_TURN, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {} },
      VANGUARD: { id: 'VANGUARD', ap: AP_PER_TURN, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {} },
    },
    log: [{ text: `${EXERCISE_NAME} begins. ${FACTION_NAMES[first]} has the initiative.`, audience: 'ALL' as const }],
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
 * surrounded) first, then gradual recovery back toward the
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
// Fortify / Ammunition / Engineer ops
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

/**
 * AMMUNITION (phase 6). Artillery and naval formations carry a small number of
 * ready rounds; everything else has none and needs none. Spending one is the
 * only cost of a fire mission, and a formation that holds its fire for a round
 * gets one back. There is no depot, no radius and no logistics order.
 */
export function maxAmmo(f: Formation): number {
  return FORMATION_DEFS[f.type].maxAmmo ?? 0;
}

export function usesAmmo(f: Formation): boolean {
  return FORMATION_DEFS[f.type].maxAmmo !== null;
}

/** True when this formation is able to shoot right now. */
export function hasAmmo(f: Formation): boolean {
  return !usesAmmo(f) || f.ammo > 0;
}

function spendRound(state: GameState, f: Formation) {
  if (!usesAmmo(f)) return;
  f.ammo = Math.max(0, f.ammo - 1);
  f.lastFiredRound = state.round;
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

/**
 * How well the attacker actually knows what it is attacking. Passive spotting
 * means you can nearly always SEE the enemy you are next to; the ladder is
 * what decides whether you are attacking a known formation or a shape in the
 * treeline.
 *
 * Phase 6: this NO LONGER changes the attack's power. Attacking a target you
 * have merely identified used to cost 40% of your combat power, which is not
 * how anything works — if you can see well enough to engage, you fight just as
 * well. The rung now decides only how PREDICTABLE the engagement is: see
 * combat.ts `predictEngagement`. Recon buys certainty, not firepower.
 */
function intelLevel(state: GameState, attacker: PlayerId, target: Formation): DetectionLevel {
  const c = state.players[attacker].contacts[target.id];
  return c ? c.level : 'UNKNOWN';
}

/**
 * The odds preview the UI draws when Attack is armed and a target is hovered.
 * Exported so the client, the bot and the engine all read the same numbers —
 * this function IS the promise the pre-attack preview makes, and `attackAction`
 * below resolves the very same chain with a live roll.
 */
export function previewAttack(state: GameState, attackerId: string, targetId: string) {
  const attacker = state.formations[attackerId];
  const target = state.formations[targetId];
  if (!attacker || !target) return null;
  const def = FORMATION_DEFS[attacker.type];
  const d = distance(attacker.x, attacker.y, target.x, target.y);
  if (d < 1 || d > def.attackRange) return null;
  const closeAssault = d === 1 && !def.isNaval;
  // On the client this reads the fog-filtered state, so `intel` is derived from
  // the viewer's own contact table; on the server it is the true one.
  const known = intelLevel(state, attacker.owner, target);
  // On the client the enemy's own contact table is blanked by fog.ts, so fall
  // back to the redaction flag the wire object carries.
  const intel: DetectionLevel = known !== 'UNKNOWN' ? known : target.redacted ? 'IDENTIFIED' : 'CONFIRMED';
  return predictEngagement(state, attacker, target, closeAssault, intel);
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
  // Ships and guns shoot with ammunition; everyone else fights with what they
  // carry. No depot, no radius — just a round spent and a round regained.
  if (!hasAmmo(attacker)) {
    log(state, `${attacker.name} has no ready rounds — hold fire for a round to replenish.`);
    return state;
  }

  spendAP(state, 'ATTACK');

  const attackerTile = state.tiles[attacker.y][attacker.x];
  const defenderTile = state.tiles[target.y][target.x];

  // ---- The formula (combat.ts). Both sides' full multiplicative chains, then
  // one bounded roll, then losses proportional to the opponent's share.
  const atk = attackPower(state, attacker, target, defenderTile, closeAssault);
  const dfn = defencePower(state, target, defenderTile);
  const roll = Math.round((Math.random() * 2 - 1) * COMBAT_ROLL_PCT);
  const finalAttacker = atk.power * (1 + roll / 100);
  const share = finalAttacker / (finalAttacker + dfn.power);
  const res = lossesFromShare(share, closeAssault);

  const factors: BattleFactor[] = [
    ...atk.factors.map((f) => ({ ...f, side: 'attacker' as const })),
    ...dfn.factors.map((f) => ({ ...f, side: 'defender' as const })),
  ];
  if (!closeAssault) {
    factors.push({
      label: 'Standoff fire — no return engagement, ground not taken',
      positive: true,
      magnitude: (1 - STANDOFF_RETURN_FIRE) * 100,
      side: 'attacker',
    });
  }
  factors.push({
    label: `Combat roll ${roll >= 0 ? '+' : ''}${roll}%`,
    positive: roll >= 0,
    magnitude: Math.abs(roll),
    side: 'attacker',
  });

  const outcome = res.outcome;
  const attackerDelta = res.attacker;
  const defenderDelta = res.defender;
  const captured = res.captured;

  attacker.strength = Math.max(0, Math.min(100, attacker.strength + attackerDelta));
  target.strength = Math.max(0, Math.min(100, target.strength + defenderDelta));
  spendRound(state, attacker);
  // A fight costs readiness — that is what readiness now measures, with supply
  // gone: how fit this formation is to do it again right away.
  attacker.readiness = Math.max(25, attacker.readiness - (closeAssault ? 10 : 5));
  target.readiness = Math.max(25, target.readiness - 8);

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
    defenderPower: dfn.power,
    roll,
    share,
    factors,
    attackerLoss,
    defenderLoss,
    attackerStrengthDelta: attackerDelta,
    defenderStrengthDelta: defenderDelta,
    captured,
    closeAssault,
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
  if (!hasAmmo(f)) {
    log(state, `${f.name} has no ready rounds — hold fire for a round to replenish.`);
    return state;
  }
  const d = distance(f.x, f.y, x, y);
  if (d > FORMATION_DEFS.ARTILLERY.attackRange) return state;
  const target = formationAt(state, x, y);
  if (!target || target.owner === f.owner) return state;
  spendAP(state, 'ARTILLERY');
  spendRound(state, f);
  f.hasActedThisTurn = true;
  f.lastOrder = `Fire mission on grid ${gridRef(x, y)} — ${f.ammo}/${maxAmmo(f)} rounds left`;

  // A fire mission is the same standoff engagement the ATTACK path resolves,
  // just reached by a different order, so it uses the same chain and the same
  // preview numbers.
  const defenderTile = state.tiles[target.y][target.x];
  const atk = attackPower(state, f, target, defenderTile, false);
  const dfn = defencePower(state, target, defenderTile);
  const roll = Math.round((Math.random() * 2 - 1) * COMBAT_ROLL_PCT);
  const share = (atk.power * (1 + roll / 100)) / (atk.power * (1 + roll / 100) + dfn.power);
  const res = lossesFromShare(share, false);
  const delta = res.defender;
  target.strength = Math.max(0, target.strength + delta);
  target.lastEngagedRound = state.round;
  target.readiness = Math.max(25, target.readiness - 6);
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
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn || !SPECIAL_OP_TYPES.includes(f.type)) return state;
  if (!canAfford(state, 'SPECIAL_OP')) return state;
  const d = distance(f.x, f.y, x, y);
  // Commandos insert deepest; the Guards go in by helicopter as a formed
  // sub-unit and so land closer to the friendly line.
  if (d > (SPECIAL_OP_RANGE_BY_TYPE[f.type] ?? SPECIAL_OP_RANGE)) return state;
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
// Objectives, condition tick, turn management
// ---------------------------------------------------------------------------

/**
 * Resolve objective control, then pay `scoringSide` for the objectives it holds
 * at this instant. `endTurn` calls it once per turn with the side that did NOT
 * just move, so each side banks once per round, measured after an enemy turn.
 *
 * Phase 5 — side-balance fix. Until now control was resolved at the end of
 * every turn but VP were paid to BOTH sides once per round, at the end of the
 * *second* player's turn. That handed the second player the last word on every
 * scoring tick: it could take or retake ground and bank it immediately, while
 * anything the first player captured had to survive a full enemy turn before it
 * paid out. Measured over seeded bot-vs-bot games this was worth roughly 20 VP
 * a game and a 8/22 win split (see README, "Side balance").
 *
 * Paying each side at the end of its OWN turn instead simply mirrors the bug:
 * measured the same way it hands the FIRST player a ~+30 VP edge, because
 * whoever acts most recently before a scoring evaluation owns the contested
 * ground at that instant.
 *
 * So each side is paid at the end of the OPPONENT's turn, for what it still
 * holds once the opponent has had its reply. That is symmetric in the one way
 * that matters — both sides' scoring is measured immediately after an enemy
 * turn, so neither ever gets the last word on its own payout — and it is also
 * the rule the design wants: an objective has to be HELD, not merely touched.
 * Ground taken and lost again before the enemy finishes its reply never pays.
 */
function tickObjectives(state: GameState, scoringSide: PlayerId) {
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
        log(state, `${FACTION_NAMES[side]} secured objective: ${o.name} (grid ${gridRef(o.x, o.y)}).`, 'ALL');
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
    if (o.controlledBy === scoringSide) {
      state.players[scoringSide].vp += o.vpPerTurn;
    }
  });
}

/**
 * End-of-round condition tick (phase 6 — this replaced the supply tick).
 *
 * READINESS is now purely a formation's own state: it falls when it fights and
 * climbs back when it does not. There is no geography in it and nothing to
 * manage — a formation that has been in contact is less fit to attack again
 * next round, and that is the whole rule.
 *
 * AMMUNITION regenerates for the guns and the ships that held their fire. Both
 * numbers are on the unit card.
 */
function tickCondition(state: GameState, owner: PlayerId) {
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== owner) return;
    const engaged = f.lastEngagedRound === state.round;
    f.readiness = engaged ? Math.max(25, f.readiness - 4) : Math.min(100, f.readiness + 12);
    if (usesAmmo(f) && f.lastFiredRound !== state.round) {
      f.ammo = Math.min(maxAmmo(f), f.ammo + AMMO_REGEN_PER_ROUND);
    }
  });
}

/**
 * Victory is only adjudicated at a ROUND boundary — after the SECOND player's
 * turn, whichever side that is this operation (see GameState.initiative) — so
 * both sides have always banked the same number of scoring turns. Otherwise
 * the side with the initiative would cross the threshold half a round early
 * every single game. (The scoring itself is symmetric; see tickObjectives.)
 */
function winnerLabel(w: GameState['winner']): string {
  return w === 'DRAW' || w === null ? 'Draw' : FACTION_NAMES[w];
}

function checkVictory(state: GameState, roundComplete: boolean) {
  if (!roundComplete) return;
  const b = state.players.SABRE.vp;
  const r = state.players.VANGUARD.vp;
  if (b >= VP_WIN_THRESHOLD || r >= VP_WIN_THRESHOLD) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'SABRE' : 'VANGUARD';
    log(state, `Victory point threshold reached. Winner: ${winnerLabel(state.winner)}.`, 'ALL');
  } else if (state.round > MAX_ROUNDS) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'SABRE' : 'VANGUARD';
    log(state, `Final round complete. Winner: ${winnerLabel(state.winner)}.`, 'ALL');
  }
}

export function endTurn(state: GameState): GameState {
  const finishing = state.activePlayer;
  tickObjectives(state, otherPlayer(finishing));
  tickCondition(state, finishing);
  tickMorale(state, finishing);
  const roundComplete = finishing === otherPlayer(state.initiative);
  if (roundComplete) state.round += 1;
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
  checkVictory(state, roundComplete);
  if (state.phase !== 'GAME_OVER') state.phase = 'TURN_HANDOFF';
  log(state, `Turn passed to ${FACTION_NAMES[nextPlayer]}. Round ${state.round}.`, 'ALL');
  return state;
}

export function beginPlayerTurn(state: GameState): GameState {
  // Never resurrect a finished game — endTurn() may have just declared a
  // winner, and the server calls this immediately afterwards.
  if (state.phase === 'GAME_OVER') return state;
  state.phase = 'PLAYING';
  return state;
}
