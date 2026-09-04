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
  isCloseTerrain,
  lossFromDelta,
  lossesFromShare,
  predictEngagement,
  suppressionHitFor,
} from './combat';
import { generateBattlefield } from './mapgen';
import {
  computeReachable as computeReachableTiles,
  cohesionAdvisory,
  crossable,
  isThreatened,
  MoveRefusal,
  planGroupMove,
  planMove,
  planWithdraw,
} from './movement';
import { deepProbe, detectionRange, lineOfSight, reconSweep, refreshAllSpotting, refreshSpotting, sightDistance } from './detection';
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
  AP_COSTS,
  AIR_SORTIES_PER_TURN,
  DEFAULT_RULES,
  EXPLOITATION_AP_REBATE,
  FORTIFY_TIER_MAX,
  FORTIFY_TIER_SUPPRESSION_DECAY_MULT,
  GRID_SIZE,
  LAST_STAND_DURATION_ROUNDS,
  LAST_STAND_THRESHOLD,
  MatchRules,
  MUTUAL_REORGANIZE_MORALE_BONUS,
  MUTUAL_REORGANIZE_READINESS_BONUS,
  REACTION_FIRE_POWER_MULT,
  REORGANIZE_COOLDOWN_ROUNDS,
  REORGANIZE_MORALE,
  REORGANIZE_READINESS,
  REORGANIZE_STRENGTH,
  SUPPRESSION_DECAY_BASE,
  SUPPRESSION_DECAY_COVER_MULT,
  SUPPRESSION_DECAY_OPEN_MULT,
  UAV_CHARGES_PER_GAME,
  UAV_DECAY_PER_ROUND,
  UAV_SWEEP_CONFIDENCE,
  UAV_SWEEP_RADIUS,
  VERTICAL_INSERT_MAX_USES,
  VERTICAL_INSERT_RADIUS,
  ActionKind,
  BattleFactor,
  BattleReport,
  CombatEvent,
  DetectionLevel,
  Formation,
  GameState,
  KillEvent,
  PlayerId,
  ReplayRound,
  SPECIAL_OP_RANGE,
  SPECIAL_OP_RANGE_BY_TYPE,
  SPECIAL_OP_TYPES,
  Tile,
  detectionLevelFor,
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

/**
 * LAST STAND (phase 11 §5) — call after ANY strength mutation. Arms the
 * one-time cornered-and-fighting-hard bonus the first time (and only the
 * first time) a formation's strength crosses below LAST_STAND_THRESHOLD.
 * `lastStandTriggered` never resets, so Reorganize healing a formation back
 * above the floor and a later engagement dropping it below again does NOT
 * re-trigger the bonus — it is spent.
 */
function checkLastStand(state: GameState, f: Formation) {
  if (f.lastStandTriggered) return;
  if (f.strength >= LAST_STAND_THRESHOLD || f.strength <= 0) return;
  f.lastStandTriggered = true;
  f.lastStandUntilRound = state.round + LAST_STAND_DURATION_ROUNDS - 1;
  log(
    state,
    `${f.shortName} is fighting a last stand — strength below ${LAST_STAND_THRESHOLD}%, cornered and hitting back harder for ${LAST_STAND_DURATION_ROUNDS} rounds.`,
    f.owner
  );
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
    onAlert: false,
    reactionFired: false,
    suppression: 0,
    lastSuppressedRound: 0,
    lastReorganizedRound: 0,
    fortifyTier: 0,
    fortifiedThisRound: false,
    verticalInsertsUsed: 0,
    lastStandTriggered: false,
    lastStandUntilRound: 0,
    roundsStationary: 0,
  };
}

export function initGame(
  seed = 1337,
  opts: { rules?: Partial<MatchRules>; mapName?: string; initiative?: PlayerId } = {}
): GameState {
  const map = generateBattlefield(seed);
  const rules: MatchRules = { ...DEFAULT_RULES, ...opts.rules };
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
  const first: PlayerId = opts.initiative ?? (initiativeRoll(seed) ? 'VANGUARD' : 'SABRE');

  const state: GameState = {
    round: 1,
    activePlayer: first,
    initiative: first,
    tiles: map.tiles,
    formations,
    objectives: map.objectives,
    players: {
      SABRE: { id: 'SABRE', ap: rules.apPerTurn, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {}, uavCharges: UAV_CHARGES_PER_GAME },
      VANGUARD: { id: 'VANGUARD', ap: rules.apPerTurn, vp: 0, airSorties: AIR_SORTIES_PER_TURN, contacts: {}, uavCharges: UAV_CHARGES_PER_GAME },
    },
    log: [{ text: `${EXERCISE_NAME} begins. ${FACTION_NAMES[first]} has the initiative.`, audience: 'ALL' as const, round: 1 }],
    phase: 'PLAYING',
    winner: null,
    winReason: null,
    lastBattleReport: null,
    killFeed: [],
    combatEvents: [],
    replay: [],
    rules,
    mapName: opts.mapName ?? 'Unnamed Sector',
    mapSeed: seed,
    replayCode: null,
  };

  refreshAllSpotting(state);
  snapshotRound(state);
  return state;
}

/** Positions-only snapshot of every formation, for the replay view (phase 9). */
function snapshotRound(state: GameState) {
  const entries: ReplayRound['entries'] = Object.values(state.formations).map((f) => ({
    id: f.id,
    owner: f.owner,
    type: f.type,
    shortName: f.shortName,
    x: f.x,
    y: f.y,
    strength: f.strength,
  }));
  state.replay.push({ round: state.round, entries });
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
  state.log.unshift({ text: msg, audience, round: state.round });
  if (state.log.length > 60) state.log.pop();
}

// ---------------------------------------------------------------------------
// Overwatch / reaction fire (phase 7)
//
// A formation that ends its turn WITHOUT spending its major action (it may
// still have moved) goes "on alert" — see endTurn/beginPlayerTurn below.
// During the opponent's following turn, if an enemy formation moves into a
// tile within an on-alert formation's detection range AND line of sight (the
// exact model passive spotting uses — an alert unit only reacts to what it
// could legitimately see), it fires ONE reduced-power shot, at no AP or
// movement cost (that cost was already banked by not acting). Artillery is
// excluded — indirect fire is not a reaction weapon.
// ---------------------------------------------------------------------------

/** On-alert enemy formations that could react to `mover` standing at its current (x, y). */
function overwatchCandidates(state: GameState, mover: Formation): Formation[] {
  const enemy = otherPlayer(mover.owner);
  const tile = state.tiles[mover.y][mover.x];
  const out: Formation[] = [];
  for (const alert of Object.values(state.formations)) {
    if (alert.owner !== enemy || !alert.onAlert || alert.reactionFired) continue;
    if (alert.type === 'ARTILLERY') continue; // not a direct-fire weapon — no overwatch
    const alertDef = FORMATION_DEFS[alert.type];
    const d = distance(alert.x, alert.y, mover.x, mover.y);
    if (d < 1 || d > alertDef.attackRange) continue; // must actually be able to reach it
    const alertTile = state.tiles[alert.y][alert.x];
    const range = detectionRange(alert, alertTile, tile, { fortifiedTarget: mover.fortified, targetStationaryRounds: mover.roundsStationary });
    if (sightDistance(alert.x, alert.y, mover.x, mover.y) > range.effective) continue;
    if (!lineOfSight(state.tiles, alert.x, alert.y, mover.x, mover.y).clear) continue;
    out.push(alert);
  }
  return out;
}

/**
 * Resolve every eligible reaction shot against `mover` at its CURRENT
 * position, using the same combat chain a normal attack uses, scaled down to
 * REACTION_FIRE_POWER_MULT. Returns true when `mover` was destroyed — the
 * caller must stop moving it any further.
 */
function triggerOverwatch(state: GameState, mover: Formation): boolean {
  for (const alert of overwatchCandidates(state, mover)) {
    if (!state.formations[mover.id]) return true; // destroyed by an earlier shot this call
    if (!state.formations[alert.id] || alert.reactionFired) continue;
    const tile = state.tiles[mover.y][mover.x];
    const atk = attackPower(state, alert, mover, tile, false);
    const dfn = defencePower(state, mover, tile);
    const roll = Math.round((Math.random() * 2 - 1) * COMBAT_ROLL_PCT);
    const finalAttacker = atk.power * REACTION_FIRE_POWER_MULT * (1 + roll / 100);
    const share = finalAttacker / (finalAttacker + dfn.power);
    const res = lossesFromShare(share, false);
    alert.strength = Math.max(0, Math.min(100, alert.strength + res.attacker));
    mover.strength = Math.max(0, Math.min(100, mover.strength + res.defender));
    checkLastStand(state, alert);
    checkLastStand(state, mover);
    alert.reactionFired = true;
    alert.lastEngagedRound = state.round;
    mover.lastEngagedRound = state.round;
    recordCombatEvent(state, 'overwatch', alert, alert, mover, tile);
    applyMoraleShock(state, mover, casualtyShock(res.defender, 0.6), 'caught by reaction fire');
    log(
      state,
      `${alert.shortName} opens reaction fire on ${mover.shortName} moving through grid ${gridRef(mover.x, mover.y)} — ${lossFromDelta(res.defender)} losses.`,
      'ALL'
    );
    if (alert.strength <= 0) destroyFormation(state, alert);
    if (mover.strength <= 0) {
      destroyFormation(state, mover);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

/**
 * Result of an attempted single-formation move. `ok` is false whenever
 * nothing happened — the caller (server/index.ts) MUST check this rather
 * than assume any state mutation occurred. `refusal`/`reason`/`occupantId`
 * mirror planMove's MovePlan so the server can decide what is SAFE to relay
 * to the mover: see the occupantId doc comment on MovePlan in movement.ts —
 * an ENEMY_HELD refusal must never be shown verbatim unless the mover's own
 * side has actually detected that occupant (fog.ts contactLevel).
 */
export interface MoveActionResult {
  state: GameState;
  ok: boolean;
  refusal: MoveRefusal | null;
  reason: string;
  occupantId: string | null;
}

export function moveFormation(state: GameState, formationId: string, x: number, y: number): MoveActionResult {
  const fail = (refusal: MoveRefusal | null, reason: string, occupantId: string | null = null): MoveActionResult => ({
    state,
    ok: false,
    refusal,
    reason,
    occupantId,
  });
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer) return fail(null, 'No such formation, or not yours to order.');
  const plan = planMove(state, f, x, y);
  if (!plan.ok) return fail(plan.refusal, plan.reason, plan.occupantId);
  // A long bound may consume more than one of the formation's movement actions
  // (and one AP each) — the client preview states exactly how many before the
  // player commits, so the accounting is never a surprise.
  if (plan.actionsRequired > movesRemaining(f)) return fail('NO_MOVES', 'Not enough movement actions left for this bound.');
  if (state.players[f.owner].ap < plan.apCost) return fail('NO_AP', 'Not enough AP for this bound.');

  const advisory = cohesionAdvisory(state, f, x, y);
  state.players[state.activePlayer].ap -= plan.apCost;
  f.fortified = false;
  f.fortifyTier = 0;
  f.movesUsed += plan.actionsRequired;
  f.roundsStationary = 0;

  // Walk the path tile by tile (not just jump to the destination) so overwatch
  // can react anywhere along the route, not only at the final tile.
  let destroyed = false;
  for (const step of plan.path) {
    f.x = step.x;
    f.y = step.y;
    if (triggerOverwatch(state, f)) {
      destroyed = true;
      break;
    }
  }
  if (destroyed) {
    refreshAllSpotting(state);
    return { state, ok: true, refusal: null, reason: '', occupantId: null };
  }

  const ref = gridRef(f.x, f.y);
  f.lastOrder = `Moved to grid ${ref} — bound ${f.movesUsed}/${f.movesMax}`;
  log(state, `${f.shortName} moved to grid ${ref} [${f.movesUsed}/${f.movesMax} bounds].`);
  if (advisory) log(state, advisory.message);
  refreshAllSpotting(state);
  return { state, ok: true, refusal: null, reason: '', occupantId: null };
}

/**
 * Move Formation — an OPTIONAL grouped order. Every participant is paced to the
 * slowest member's single-action range so the group arrives together, each
 * spends one of its own movement actions and 1 AP, and destination tiles are
 * resolved around the objective so nothing stacks illegally.
 * Single-unit movement is untouched by this.
 */
/**
 * Result of an attempted grouped move. `ok` is false only when NO member of
 * the group moved at all (planGroupMove's own top-level refusal — never
 * enough left to say more than "not enough AP" / "no movement actions left"
 * / "no closer position", none of which can reveal an enemy's position, so
 * `reason` is always safe to relay to the mover as-is).
 */
export interface MoveGroupActionResult {
  state: GameState;
  ok: boolean;
  reason: string;
}

export function moveGroup(state: GameState, formationIds: string[], x: number, y: number): MoveGroupActionResult {
  const plan = planGroupMove(state, formationIds, x, y);
  if (!plan.ok) return { state, ok: false, reason: plan.reason };
  const movers = plan.members.filter((m) => m.ok);
  if (state.players[state.activePlayer].ap < plan.apCost)
    return { state, ok: false, reason: 'Not enough AP for this formation move.' };
  state.players[state.activePlayer].ap -= plan.apCost;
  const names: string[] = [];
  for (const m of movers) {
    const f = state.formations[m.id];
    if (!f) continue;
    f.x = m.x;
    f.y = m.y;
    f.fortified = false;
    f.fortifyTier = 0;
    f.movesUsed += 1;
    f.roundsStationary = 0;
    // Overwatch (phase 7): a grouped move checks only the final tile per
    // member (the pacing model does not track an intermediate path per
    // formation) — a real but deliberately smaller simplification than the
    // tile-by-tile check single-unit movement gets.
    if (triggerOverwatch(state, f)) {
      names.push(`${m.shortName} (destroyed by reaction fire)`);
      continue;
    }
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
  return { state, ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// RETREAT / WITHDRAW (phase 12 §1) — see types.ts's WITHDRAW_RANGE_FRACTION
// comment for the full AP-cost comparison against an ordinary
// ZOC-disengaging Move. Distinct order, distinct engine function, but it
// still walks its path tile by tile through the SAME triggerOverwatch as a
// normal move — it does not dodge reaction fire already covering the ground.
// ---------------------------------------------------------------------------

export function canWithdraw(state: GameState, f: Formation): boolean {
  if (f.owner !== state.activePlayer) return false;
  if (movesRemaining(f) <= 0) return false;
  if ((state.players[f.owner]?.ap ?? 0) < AP_COSTS.WITHDRAW) return false;
  return isThreatened(state, f);
}

export function withdrawAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer) return state;
  if (!canWithdraw(state, f)) return state;
  const plan = planWithdraw(state, f);
  if (!plan.ok) return state;

  state.players[state.activePlayer].ap -= AP_COSTS.WITHDRAW;
  f.fortified = false;
  f.fortifyTier = 0;
  f.movesUsed += 1;
  f.roundsStationary = 0;

  let destroyed = false;
  for (const step of plan.path) {
    f.x = step.x;
    f.y = step.y;
    if (triggerOverwatch(state, f)) {
      destroyed = true;
      break;
    }
  }
  if (destroyed) {
    refreshAllSpotting(state);
    return state;
  }

  const ref = gridRef(f.x, f.y);
  f.lastOrder = `Withdrew from contact to grid ${ref} (${AP_COSTS.WITHDRAW} AP)`;
  log(state, `${f.shortName} withdrew from contact to grid ${ref}, breaking off before the enemy could close.`);
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

// ---------------------------------------------------------------------------
// Destruction — visible to both sides (phase 7)
//
// A formation reduced to 0 strength is not just quietly removed: it goes onto
// `killFeed` (a short, capped list fog.ts redacts per viewer exactly like a
// live formation — the owner always sees the full record, the other side only
// what its detection of that formation had actually established) and gets a
// log line on BOTH sides, each capped at what that side legitimately knew.
// ---------------------------------------------------------------------------

/**
 * Record a resolved engagement for the on-map combat-effect readout (phase
 * 12 §5) — see types.ts CombatEvent. Capped short, newest first, exactly
 * like recordKill below.
 */
function recordCombatEvent(
  state: GameState,
  kind: CombatEvent['kind'],
  attacker: Formation,
  attackerTile: { x: number; y: number },
  defender: Formation,
  defenderTile: { x: number; y: number }
) {
  const ev: CombatEvent = {
    id: nextId('combat'),
    kind,
    attackerId: attacker.id,
    attackerOwner: attacker.owner,
    attackerX: attackerTile.x,
    attackerY: attackerTile.y,
    defenderId: defender.id,
    defenderOwner: defender.owner,
    defenderX: defenderTile.x,
    defenderY: defenderTile.y,
    round: state.round,
  };
  state.combatEvents.unshift(ev);
  if (state.combatEvents.length > 20) state.combatEvents.pop();
}

function recordKill(state: GameState, f: Formation) {
  const k: KillEvent = {
    id: nextId('kill'),
    formationId: f.id,
    owner: f.owner,
    type: f.type,
    name: f.name,
    shortName: f.shortName,
    x: f.x,
    y: f.y,
    round: state.round,
  };
  state.killFeed.unshift(k);
  if (state.killFeed.length > 12) state.killFeed.pop();
}

/** What the OTHER side may be told about a formation that just died, capped at
 *  what their detection of it had actually established. */
function destructionLabel(level: DetectionLevel, victim: Formation): string {
  if (level === 'CONFIRMED') return victim.shortName;
  if (level === 'IDENTIFIED') return `Enemy ${FORMATION_DEFS[victim.type].label}`;
  return 'An unidentified enemy formation'; // CONTACT
}

function logDestruction(state: GameState, victim: Formation) {
  const ref = gridRef(victim.x, victim.y);
  log(state, `${victim.shortName} destroyed at grid ${ref}.`, victim.owner);
  const enemy = otherPlayer(victim.owner);
  const level: DetectionLevel = state.players[enemy].contacts[victim.id]?.level ?? 'UNKNOWN';
  // UNKNOWN: the other side never legitimately detected this formation, so it
  // is told nothing at all — not even that something died there.
  if (level === 'UNKNOWN') return;
  log(state, `${destructionLabel(level, victim)} destroyed at grid ${ref}.`, enemy);
}

/** Mourn, log (both sides, redaction-appropriate) and remove a destroyed formation. */
function destroyFormation(state: GameState, f: Formation) {
  mourn(state, f);
  recordKill(state, f);
  logDestruction(state, f);
  delete state.formations[f.id];
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
  // Prepared-defence tiers (phase 9): a fresh dig-in always starts at Hasty
  // (tier 0) — re-fortifying does NOT bank whatever tier it had climbed to
  // before it stopped being fortified. `fortifiedThisRound` tells the
  // end-of-round tick this was the round it (re)dug in, so the tier does not
  // climb again until a further round is spent simply holding.
  f.fortifyTier = 0;
  f.fortifiedThisRound = true;
  f.lastOrder = 'Dug in (fortified — Hasty)';
  log(state, `${f.name} dug in and fortified its position.`);
  return state;
}

/**
 * Prepared-defence tier tick (phase 9) — end-of-round, mirrors tickMorale /
 * tickCondition. Must run BEFORE the hasActedThisTurn/movesUsed/
 * fortifiedThisRound reset below, since it reads this round's activity.
 */
function tickFortifyTiers(state: GameState, owner: PlayerId) {
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== owner) return;
    if (!f.fortified) {
      f.fortifyTier = 0;
      return;
    }
    if (f.fortifiedThisRound) return; // just (re)dug in this round — holds at its current tier
    if (f.hasActedThisTurn) {
      // A different major action while dug in (Reorganize, a fire mission,
      // Recon, an engineer order, …) — attacking already clears `fortified`
      // itself in attackAction, so this branch is everything else. The
      // accumulated tier is thrown away; the position resets to Hasty.
      if (f.fortifyTier > 0) log(state, `${f.shortName} broke its prepared-defence tier — back to Hasty.`, f.owner);
      f.fortifyTier = 0;
      return;
    }
    // Took no action at all this round while already dug in — held the line.
    const before = f.fortifyTier;
    f.fortifyTier = Math.min(FORTIFY_TIER_MAX, f.fortifyTier + 1);
    if (f.fortifyTier > before)
      log(state, `${f.shortName} improved its position to ${['Hasty', 'Prepared', 'Entrenched'][f.fortifyTier]}.`, f.owner);
  });
}

/**
 * REORGANIZE (phase 7) — light restorative action, not a return of the phase-6
 * supply/depot system. Any formation may stand down for a round to reconstitute:
 * readiness and morale recover a real amount immediately, and a little strength
 * comes back too (replacements, at the same %-of-strength abstraction the rest
 * of the game uses). Gated twice so it cannot flatten combat losses:
 *   - it costs the formation's major action AND requires it to have made no
 *     movement action this round ("stand down to reorganize" — you cannot
 *     manoeuvre and reconstitute in the same round), and
 *   - it cannot be used again for REORGANIZE_COOLDOWN_ROUNDS rounds.
 */
export function canReorganize(state: GameState, f: Formation): boolean {
  if (f.hasActedThisTurn || f.movesUsed > 0) return false;
  if (f.lastReorganizedRound && state.round - f.lastReorganizedRound < REORGANIZE_COOLDOWN_ROUNDS) return false;
  return true;
}

export function reorganizeAction(state: GameState, formationId: string): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer) return state;
  if (!canReorganize(state, f)) return state;
  if (!canAfford(state, 'REORGANIZE')) return state;
  spendAP(state, 'REORGANIZE');
  f.hasActedThisTurn = true;
  f.lastReorganizedRound = state.round;
  const beforeReadiness = f.readiness;
  const beforeStrength = f.strength;
  f.readiness = Math.min(100, f.readiness + REORGANIZE_READINESS);
  f.strength = Math.min(100, f.strength + REORGANIZE_STRENGTH);
  applyMoraleShock(state, f, REORGANIZE_MORALE, 'stood down to reorganize');
  f.lastOrder = `Reorganized — readiness ${Math.round(beforeReadiness)}% → ${Math.round(f.readiness)}%, strength ${Math.round(beforeStrength)}% → ${Math.round(f.strength)}%`;
  log(
    state,
    `${f.name} stood down to reorganize — readiness ${Math.round(beforeReadiness)}% → ${Math.round(f.readiness)}%, strength ${Math.round(beforeStrength)}% → ${Math.round(f.strength)}%.`
  );

  // MUTUAL REORGANIZE (phase 9): any ADJACENT friendly formation that also
  // reorganized THIS round gets an extra bump too — whichever of the pair
  // went second, checking here catches both orderings, since by the time the
  // second one reorganizes the first one's lastReorganizedRound already
  // reads this round.
  const partners = Object.values(state.formations).filter(
    (o) => o.owner === f.owner && o.id !== f.id && distance(o.x, o.y, f.x, f.y) <= 1 && o.lastReorganizedRound === state.round
  );
  if (partners.length > 0) {
    f.readiness = Math.min(100, f.readiness + MUTUAL_REORGANIZE_READINESS_BONUS);
    applyMoraleShock(state, f, MUTUAL_REORGANIZE_MORALE_BONUS, 'reorganized alongside a nearby formation');
    partners.forEach((p) => {
      p.readiness = Math.min(100, p.readiness + MUTUAL_REORGANIZE_READINESS_BONUS);
      applyMoraleShock(state, p, MUTUAL_REORGANIZE_MORALE_BONUS, `reorganized alongside ${f.shortName}`);
    });
    log(
      state,
      `${f.shortName} and ${partners.map((p) => p.shortName).join(', ')} reorganize together — readiness restored more fully.`
    );
  }
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
  // Naval standoff fire (phase 7) needs line of sight, same as passive
  // spotting — a target masked by intervening high ground is not attackable
  // even though it is in range.
  if (def.isNaval && d > 1) {
    const sight = lineOfSight(state.tiles, attacker.x, attacker.y, target.x, target.y);
    if (!sight.clear) return null;
  }
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
  // Naval standoff fire (phase 7): same range it always had, but now gated by
  // line of sight — a ship cannot shoot what intervening high ground masks
  // from its own position, even at a target it is otherwise entitled to see
  // (spotted by someone else). Ship-to-ship fire is essentially never blocked
  // by this (open water), which is exactly the point.
  if (attackerDef.isNaval && d > 1) {
    const sight = lineOfSight(state.tiles, attacker.x, attacker.y, target.x, target.y);
    if (!sight.clear) {
      log(state, `${attacker.name} has no line of sight to ${target.name} from grid ${gridRef(attacker.x, attacker.y)} — intervening terrain masks the target from naval gunfire.`);
      return state;
    }
  }
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
  recordCombatEvent(state, closeAssault ? 'direct' : 'standoff', attacker, attackerTile, target, defenderTile);

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
  checkLastStand(state, attacker);
  checkLastStand(state, target);
  // Suppression (phase 7): a secondary output of the SAME action, alongside
  // damage — never a substitute for it. Indirect/standoff fire suppresses
  // hard; a direct assault suppresses a little too.
  const suppressionApplied = suppressionHitFor(closeAssault);
  target.suppression = Math.min(100, target.suppression + suppressionApplied);
  target.lastSuppressedRound = state.round;
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
      // A formation reduced to 0 strength is DESTROYED — mourned, logged (both
      // sides, redaction-appropriate) and put on the kill feed. One captured
      // but not destroyed is displaced from the position, not killed: no kill
      // event, same as before phase 7.
      if (destroyedTarget) destroyFormation(state, target);
      else delete state.formations[target.id];
      if (closeAssault) {
        attacker.x = target.x;
        attacker.y = target.y;
      }
    }
  }
  if (attacker.strength <= 0) {
    destroyFormation(state, attacker);
  }

  attacker.hasActedThisTurn = true;
  attacker.fortified = false;
  attacker.fortifyTier = 0;
  attacker.lastOrder = closeAssault ? `Assaulted ${target.shortName}` : `Engaged ${target.shortName} at range`;

  // EXPLOITATION BONUS (phase 9): a clean, low-cost decisive win — Position
  // Captured with None/Light losses to the attacker — earns a small
  // immediate AP rebate that same turn. Naturally cannot double-trigger: an
  // attack spends the formation's major action, so it can only attack once
  // per turn, and this runs at most once per resolved attack.
  const breakthroughBonus = captured && (attackerLoss === 'None' || attackerLoss === 'Light');
  if (breakthroughBonus) {
    state.players[attacker.owner].ap = Math.min(state.rules.apCap, state.players[attacker.owner].ap + EXPLOITATION_AP_REBATE);
    log(state, `${attacker.shortName} broke through cleanly — bonus AP granted (+${EXPLOITATION_AP_REBATE}).`, attacker.owner);
  }

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
    suppressionApplied,
    defenderFortifyTier: target.fortified ? target.fortifyTier ?? 0 : -1,
    breakthroughBonus,
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
  recordCombatEvent(state, 'standoff', f, f, target, defenderTile);
  const delta = res.defender;
  target.strength = Math.max(0, target.strength + delta);
  checkLastStand(state, target);
  target.lastEngagedRound = state.round;
  target.readiness = Math.max(25, target.readiness - 6);
  // Suppression (phase 7): a fire mission's second output, alongside damage —
  // artillery is the primary source of it. Never causes strength loss itself.
  const suppressionApplied = suppressionHitFor(false);
  target.suppression = Math.min(100, target.suppression + suppressionApplied);
  target.lastSuppressedRound = state.round;
  // Indirect fire is harassing: it carries half the morale weight of a
  // stand-up assault, and a light stonk carries none at all.
  applyMoraleShock(state, target, casualtyShock(delta, 0.5), 'under artillery fire');
  log(
    state,
    `${f.name} fire mission struck ${target.name} at grid ${gridRef(x, y)} — ${lossFromDelta(delta)} losses, suppression +${suppressionApplied}.`,
    'ALL'
  );
  if (target.strength <= 0) {
    destroyFormation(state, target);
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
  checkLastStand(state, target);
  target.lastEngagedRound = state.round;
  // A strike from off-map is standoff fire too — suppresses like artillery.
  target.suppression = Math.min(100, target.suppression + suppressionHitFor(false));
  target.lastSuppressedRound = state.round;
  applyMoraleShock(state, target, casualtyShock(delta, 0.5), 'under air attack');
  log(state, `Air strike (F-15SG/F-16 flight) hit ${target.name} at grid ${gridRef(x, y)} — ${lossFromDelta(delta)} losses.`, 'ALL');
  if (target.strength <= 0) {
    destroyFormation(state, target);
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
    checkLastStand(state, target);
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
// Vertical / heli insertion (phase 9) — Commandos and Guards only.
//
// A genuine leap: any tile within VERTICAL_INSERT_RADIUS that is NOT
// adjacent to any formation this SIDE has actually detected (its own
// players[owner].contacts table — fog-of-war-correct, never the true enemy
// positions) and is otherwise a legal deployment tile. Bypasses normal
// movement range, road bonuses, and Zones of Control entirely — that is the
// whole point of a vertical envelopment. Capped hard per formation per game.
// ---------------------------------------------------------------------------

function inMapBounds(x: number, y: number): boolean {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

/** Is (x, y) a legal vertical-insertion landing tile for `f` right now? */
export function verticalInsertLandingLegal(state: GameState, f: Formation, x: number, y: number): { ok: boolean; reason: string } {
  if (!inMapBounds(x, y)) return { ok: false, reason: 'Off the map sheet.' };
  const tile = tileAt(state, x, y);
  if (!tile) return { ok: false, reason: 'Off the map sheet.' };
  if (!crossable(state, f, tile)) return { ok: false, reason: 'Not a landing zone this formation can occupy — impassable terrain.' };
  if (formationAt(state, x, y)) return { ok: false, reason: 'Landing zone is already occupied.' };
  const d = distance(f.x, f.y, x, y);
  if (d > VERTICAL_INSERT_RADIUS) return { ok: false, reason: `Beyond the ${VERTICAL_INSERT_RADIUS}-tile insertion radius.` };
  // Fog-of-war correct: this side's OWN contact table, not the true enemy
  // positions — an enemy this side has never detected cannot be avoided by
  // name, so it does not block a landing zone near it.
  const contacts = state.players[f.owner].contacts;
  for (const c of Object.values(contacts)) {
    if (distance(c.x, c.y, x, y) <= 1) return { ok: false, reason: 'Landing zone is adjacent to a detected enemy formation.' };
  }
  return { ok: true, reason: '' };
}

/** True if ANY legal landing tile exists for `f` right now — for the disabled-reason UI. */
export function hasVerticalInsertLandingZone(state: GameState, f: Formation): boolean {
  const r = VERTICAL_INSERT_RADIUS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > r) continue;
      const x = f.x + dx;
      const y = f.y + dy;
      if (x === f.x && y === f.y) continue;
      if (verticalInsertLandingLegal(state, f, x, y).ok) return true;
    }
  }
  return false;
}

export function verticalInsertAction(state: GameState, formationId: string, x: number, y: number): GameState {
  const f = state.formations[formationId];
  if (!f || f.owner !== state.activePlayer || f.hasActedThisTurn) return state;
  if (!SPECIAL_OP_TYPES.includes(f.type)) return state; // Commandos and Guards only
  if ((f.verticalInsertsUsed ?? 0) >= VERTICAL_INSERT_MAX_USES) return state;
  if (!canAfford(state, 'VERTICAL_INSERT')) return state;
  const legal = verticalInsertLandingLegal(state, f, x, y);
  if (!legal.ok) return state;

  spendAP(state, 'VERTICAL_INSERT');
  f.x = x;
  f.y = y;
  f.fortified = false;
  f.fortifyTier = 0;
  f.roundsStationary = 0;
  f.hasActedThisTurn = true;
  f.verticalInsertsUsed = (f.verticalInsertsUsed ?? 0) + 1;
  const remaining = VERTICAL_INSERT_MAX_USES - f.verticalInsertsUsed;
  f.lastOrder = `Vertical insertion to grid ${gridRef(x, y)} (${remaining} insertion${remaining === 1 ? '' : 's'} left)`;
  log(state, `${f.name} conducted a vertical insertion to grid ${gridRef(x, y)} — ${remaining} left this operation.`, 'ALL');
  refreshAllSpotting(state);
  return state;
}

// ---------------------------------------------------------------------------
// UAV recon (phase 9) — a capped, player-level consumable, not a formation
// order. Reveals a radius anywhere on the map for the round, upgrading
// detection directly regardless of any formation's own sight or LOS.
// ---------------------------------------------------------------------------

export function uavReconAction(state: GameState, x: number, y: number): GameState {
  const ps = state.players[state.activePlayer];
  if (!inMapBounds(x, y)) return state;
  if (ps.uavCharges <= 0) return state;
  if (!canAfford(state, 'UAV_RECON')) return state;
  spendAP(state, 'UAV_RECON');
  ps.uavCharges -= 1;

  const enemy = otherPlayer(state.activePlayer);
  let found = 0;
  for (const e of Object.values(state.formations)) {
    if (e.owner !== enemy) continue;
    if (distance(x, y, e.x, e.y) > UAV_SWEEP_RADIUS) continue;
    const existing = ps.contacts[e.id];
    const confidence = Math.max(existing?.confidence ?? 0, UAV_SWEEP_CONFIDENCE);
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
      ceiling: Math.max(existing?.ceiling ?? 0, UAV_SWEEP_CONFIDENCE),
      decayPerRound: Math.min(existing?.decayPerRound ?? 99, UAV_DECAY_PER_ROUND),
      type: level === 'CONTACT' ? undefined : e.type,
      spottedBy: 'UAV sweep',
      source: 'Heron 1 / Hermes 450 UAV sweep',
    };
    found++;
  }
  log(
    state,
    `UAV sweep over grid ${gridRef(x, y)} (radius ${UAV_SWEEP_RADIUS}) — ${found} contact${found === 1 ? '' : 's'}. ${ps.uavCharges} sortie${ps.uavCharges === 1 ? '' : 's'} remaining.`
  );
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
/**
 * Suppression's per-round decay rate (phase 7): cover recovers it faster,
 * open ground lets it linger — the same terrain-as-multiplier pattern already
 * used for combat and detection.
 */
function suppressionDecayFor(f: Formation, tile: Tile): number {
  let d = SUPPRESSION_DECAY_BASE;
  if (isCloseTerrain(tile) || f.fortified) d *= SUPPRESSION_DECAY_COVER_MULT;
  else if (tile.terrain === 'OPEN' || tile.terrain === 'BEACH') d *= SUPPRESSION_DECAY_OPEN_MULT;
  // Prepared-defence tiers (phase 9): a more established position resists
  // suppression better — recovers composure faster still, on top of the
  // flat fortified/cover bonus above.
  if (f.fortified) {
    const tier = Math.max(0, Math.min(FORTIFY_TIER_SUPPRESSION_DECAY_MULT.length - 1, f.fortifyTier ?? 0));
    d *= FORTIFY_TIER_SUPPRESSION_DECAY_MULT[tier];
  }
  return d;
}

function tickCondition(state: GameState, owner: PlayerId) {
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== owner) return;
    const engaged = f.lastEngagedRound === state.round;
    f.readiness = engaged ? Math.max(25, f.readiness - 4) : Math.min(100, f.readiness + 12);
    if (usesAmmo(f) && f.lastFiredRound !== state.round) {
      f.ammo = Math.min(maxAmmo(f), f.ammo + AMMO_REGEN_PER_ROUND);
    }
    // Suppression decays a round after it was last applied — a fresh hit this
    // round is not also decayed the same round it landed.
    if (f.suppression > 0 && f.lastSuppressedRound !== state.round) {
      const tile = state.tiles[f.y][f.x];
      f.suppression = Math.max(0, f.suppression - suppressionDecayFor(f, tile));
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
  if (b >= state.rules.vpToWin || r >= state.rules.vpToWin) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'SABRE' : 'VANGUARD';
    state.winReason = 'VP_THRESHOLD';
    log(state, `Victory point threshold reached. Winner: ${winnerLabel(state.winner)}.`, 'ALL');
  } else if (state.round > state.rules.roundLimit) {
    state.phase = 'GAME_OVER';
    state.winner = b === r ? 'DRAW' : b > r ? 'SABRE' : 'VANGUARD';
    state.winReason = 'ROUND_LIMIT';
    log(state, `Final round complete. Winner: ${winnerLabel(state.winner)}.`, 'ALL');
  }
}

export function endTurn(state: GameState): GameState {
  const finishing = state.activePlayer;
  tickObjectives(state, otherPlayer(finishing));
  tickCondition(state, finishing);
  tickMorale(state, finishing);
  tickFortifyTiers(state, finishing);
  const roundComplete = finishing === otherPlayer(state.initiative);
  if (roundComplete) state.round += 1;
  // Overwatch (phase 7): a formation that did NOT spend its major action this
  // round goes on alert for the opponent's following turn — read BEFORE the
  // reset below clears hasActedThisTurn. Artillery never stands overwatch —
  // it is not a direct-fire weapon.
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== finishing) return;
    f.onAlert = !f.hasActedThisTurn && f.type !== 'ARTILLERY';
    f.reactionFired = false;
  });
  // Concealment from stasis (phase 12 §3): tick BEFORE movesUsed resets below
  // — a formation that spent no movement action this round just held its
  // ground for another round, so the streak climbs; anything that moved (even
  // partially) had its streak already zeroed the instant it moved (see
  // moveFormation / moveGroup / withdrawAction / verticalInsertAction).
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== finishing) return;
    if (f.movesUsed === 0) f.roundsStationary = (f.roundsStationary ?? 0) + 1;
  });
  // Reset the finishing side's per-round budgets so everything is fresh when
  // control comes back to them.
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== finishing) return;
    f.hasActedThisTurn = false;
    f.movesUsed = 0;
    f.fortifiedThisRound = false;
  });
  const nextPlayer = otherPlayer(finishing);
  const carry = Math.min(state.rules.apCap, state.players[nextPlayer].ap + state.rules.apPerTurn);
  state.players[nextPlayer].ap = carry;
  state.players[nextPlayer].airSorties = AIR_SORTIES_PER_TURN;
  state.activePlayer = nextPlayer;
  refreshAllSpotting(state);
  checkVictory(state, roundComplete);
  // Replay (phase 9): a fresh positions snapshot at the start of every round.
  if (roundComplete) snapshotRound(state);
  if (state.phase !== 'GAME_OVER') state.phase = 'TURN_HANDOFF';
  log(state, `Turn passed to ${FACTION_NAMES[nextPlayer]}. Round ${state.round}.`, 'ALL');
  return state;
}

export function beginPlayerTurn(state: GameState): GameState {
  // Never resurrect a finished game — endTurn() may have just declared a
  // winner, and the server calls this immediately afterwards.
  if (state.phase === 'GAME_OVER') return state;
  state.phase = 'PLAYING';
  // Overwatch (phase 7): the alert a formation went on when IT last ended its
  // own turn has now served its purpose (the opponent's turn it covered is
  // over) — clear it at the start of its own next turn.
  Object.values(state.formations).forEach((f) => {
    if (f.owner !== state.activePlayer) return;
    f.onAlert = false;
    f.reactionFired = false;
  });
  return state;
}
