// ============================================================================
// COMMAND — Server-side bot opponent.
//
// Drives an AI-controlled seat using the *same* action functions the real
// player path uses (server/index.ts's applyAction) — the bot never bypasses
// game rules or AP costs. This module only *decides*: given the room's
// authoritative GameState, return the single best next GameAction for the
// bot to take, or null when it has nothing worthwhile left this turn (the
// server then ends its turn).
//
// Fairness: decisions are built from `filterStateForPlayer`'s fog-of-war
// view, exactly what a real player in that seat would be shown — the bot
// never targets or reasons about an enemy formation its side hasn't
// legitimately detected.
//
// Phase 4b: that view is now redacted BY DETECTION LEVEL, so an enemy the bot
// has only IDENTIFIED arrives with -1 in every numeric field. The bot fills
// those with the same neutral estimate a human would have to guess at
// (ESTIMATED_*) rather than peeking at the authoritative state — see
// `estimateEnemy`. Spotting itself is passive, so the bot no longer spends AP
// on Recon merely to see; it spends it to IDENTIFY contacts it already holds,
// to see further, and to keep tracking what it has found.
//
// Phase 6: supply is gone, so the bot no longer manages logistics at all. Its
// attack scoring now runs on the shared combat model in src/game/combat.ts via
// engine.previewAttack — the same prediction the human player is shown in the
// pre-attack preview, computed from the bot's fog-of-war view.
//
// Difficulty is a set of scoring weights over a shared candidate-generation
// pass (per formation: move / attack / recon / fortify / air),
// each candidate scored by a small utility function, best score wins. This
// is deliberately a greedy per-action policy, not a search tree — the AP
// budget already forces a natural multi-step "plan" to emerge turn to turn.
// ============================================================================

import * as engine from '../src/game/engine';
import { filterStateForPlayer } from '../src/game/fog';
import { FORMATION_DEFS } from '../src/game/data';
import { MANOEUVRE_TYPES, isSupportType, planGroupMove, zocTilesFor } from '../src/game/movement';
import { currentDetectionRange, lineOfSight } from '../src/game/detection';
import {
  ActionKind,
  AP_COSTS,
  AP_PER_TURN,
  COHESION_RADIUS,
  Contact,
  DETECTION,
  Formation,
  GameState,
  Objective,
  PlayerId,
  REORGANIZE_COOLDOWN_ROUNDS,
  UAV_SWEEP_RADIUS,
} from '../src/game/types';
import { GameAction } from '../src/net/protocol';

export type BotDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

interface Weights {
  objectiveWeight: number; // how strongly to path toward uncontrolled objectives
  /**
   * Tiles of "shortcut" the bot credits an objective with per extra VP/round.
   * 0 = pick the nearest objective regardless of what it is worth (EASY).
   */
  objectiveValueBias: number;
  attackThreshold: number; // predicted win-ratio below which an attack is considered "bad"
  isolationBonus: number; // reward per point of target weakness/isolation (combined-arms target priority)
  reconPriority: number; // baseline value of a recon sweep
  clusterWeight: number; // reward massing near friendlies (crude combined-arms positioning)
  randomness: number; // chance to ignore the best-scoring candidate and pick a weaker one
  minScore: number; // candidates below this aren't worth spending AP on
  /**
   * How many of a formation's per-round movement actions this difficulty will
   * actually use. EASY leaves the extra bounds on the table; MEDIUM and HARD
   * exploit the full allowance to manoeuvre aggressively.
   */
  maxBoundsPerUnit: number;
  /**
   * How strongly the bot keeps its artillery and engineers tucked in behind a
   * manoeuvre formation instead of letting them wander at a nearby objective.
   * 0 disables support cohesion entirely (EASY).
   */
  cohesionWeight: number;
  /** Whether this difficulty will issue grouped Move Formation orders. */
  useGroupMoves: boolean;
}

const WEIGHTS: Record<BotDifficulty, Weights> = {
  // Mostly-random legal moves, weak objective/combined-arms awareness, will
  // take bad attacks and can waste AP on low-value actions.
  EASY: { objectiveWeight: 0.4, objectiveValueBias: 0, attackThreshold: 0, isolationBonus: 0, reconPriority: 0.2, clusterWeight: 0, randomness: 0.45, minScore: -100, maxBoundsPerUnit: 1, cohesionWeight: 0, useGroupMoves: false },
  // Prioritizes objectives, recons before committing when AP allows, avoids
  // clearly bad attacks.
  MEDIUM: { objectiveWeight: 1.1, objectiveValueBias: 2.5, attackThreshold: 0.42, isolationBonus: 4, reconPriority: 0.7, clusterWeight: 0.3, randomness: 0.12, minScore: 0.2, maxBoundsPerUnit: 3, cohesionWeight: 0.7, useGroupMoves: true },
  // Combined-arms aware, target-prioritizes weakened/isolated formations,
  // defends held objectives, spends its AP efficiently.
  HARD: { objectiveWeight: 1.4, objectiveValueBias: 4, attackThreshold: 0.5, isolationBonus: 9, reconPriority: 1.1, clusterWeight: 0.8, randomness: 0.02, minScore: 0.5, maxBoundsPerUnit: 3, cohesionWeight: 1.2, useGroupMoves: true },
};

interface Candidate {
  action: GameAction;
  score: number;
}

function dist(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

/**
 * Best objective this formation could actually take: warships go for maritime
 * objectives, ground formations for land ones — the bot never walks a frigate
 * at a bridge or an infantry battalion at an open-sea anchorage.
 *
 * Phase 5: objectives are no longer all worth the same. The ones on the axis
 * of advance pay two to three times a rear-area objective, so "nearest" alone
 * would send the bot to mop up cheap ground behind its own line while the
 * valuable middle went uncontested. Distance is discounted by VALUE — each
 * extra VP per round is treated as `valueBias` tiles of shortcut — so the bot
 * walks past a 1 VP depot to fight for a 5 VP town, which is exactly the
 * behaviour the map is now designed to reward.
 */
function bestUncontrolledObjective(
  objectives: Objective[],
  bot: PlayerId,
  x: number,
  y: number,
  naval: boolean,
  valueBias: number
): { obj: Objective; d: number } | null {
  let best: { obj: Objective; d: number; rank: number } | null = null;
  for (const o of objectives) {
    if (o.controlledBy === bot) continue;
    if (!!o.maritime !== naval) continue;
    const d = dist(x, y, o.x, o.y);
    const rank = d - (o.vpPerTurn - 1) * valueBias;
    if (!best || rank < best.rank) best = { obj: o, d, rank };
  }
  return best ? { obj: best.obj, d: best.d } : null;
}

// What the bot assumes about an enemy it has identified but not confirmed.
// A human in the same seat has exactly this much to go on: the arm, and the
// knowledge that a battalion in the field is usually in decent shape.
const ESTIMATED_STRENGTH = 80;
const ESTIMATED_READINESS = 85;
const ESTIMATED_AMMO = 80;

/**
 * Replace the -1 sentinels fog.ts writes into a redacted enemy with a neutral
 * estimate, so the scoring maths has numbers to work with WITHOUT ever reading
 * the authoritative state. A confirmed enemy is returned untouched — the bot
 * has earned those numbers.
 */
function estimateEnemy(f: Formation): Formation {
  if (!f.redacted) return f;
  return {
    ...f,
    strength: ESTIMATED_STRENGTH,
    morale: 'Steady',
    moraleValue: 70,
    moraleBaseline: 70,
    readiness: ESTIMATED_READINESS,
    ammo: ESTIMATED_AMMO,
    lastFiredRound: 0,
  };
}

/**
 * Predicted attacker-favour share (0..1) — literally the number the human
 * player's pre-attack preview shows, from the bot's fog-filtered view with
 * redacted enemies already replaced by neutral estimates. Never the
 * authoritative state.
 */
function predictRatio(view: GameState, attacker: Formation, target: Formation): number {
  const p = engine.previewAttack(view, attacker.id, target.id);
  return p ? p.share : 0.5;
}

/**
 * How weak / unsupported a (visible) enemy target looks — the combined-arms
 * target-priority signal. Reads the ESTIMATED view: an identified-but-not-
 * confirmed enemy contributes its estimated strength, so the bot cannot
 * target-prioritise on damage it has no way of knowing about.
 */
function isolationScore(view: GameState, target: Formation): number {
  const friendsNearby = Object.values(view.formations).filter(
    (f) => f.owner === target.owner && f.id !== target.id && dist(f.x, f.y, target.x, target.y) <= 2
  ).length;
  const weakness = Math.max(0, (60 - target.strength) / 60); // 0..1, more damaged = higher
  const isolation = Math.max(0, (2 - friendsNearby) / 2); // 0..1, fewer nearby friends = higher
  return weakness + isolation;
}

/** Nearest friendly manoeuvre element (what a gun or bridging unit should be shadowing). */
function nearestManoeuvre(state: GameState, f: Formation): Formation | null {
  let best: Formation | null = null;
  let bestD = Infinity;
  for (const o of Object.values(state.formations)) {
    if (o.owner !== f.owner || o.id === f.id) continue;
    if (!MANOEUVRE_TYPES.includes(o.type) || FORMATION_DEFS[o.type].isNaval) continue;
    const d = dist(f.x, f.y, o.x, o.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function clusterScore(state: GameState, bot: PlayerId, x: number, y: number): number {
  return Object.values(state.formations).filter((f) => f.owner === bot && dist(f.x, f.y, x, y) <= 2).length;
}

function affordable(state: GameState, kind: ActionKind) {
  return state.players[state.activePlayer].ap >= AP_COSTS[kind];
}

/**
 * How much a destination tile is threatened by an enemy formation already
 * known (from the bot's OWN fog-of-war view — onAlert is redacted below
 * CONFIRMED, exactly like a human player would see it) to be on alert. A
 * cheap range-only approximation (no LOS simulation per candidate tile) —
 * good enough to make the bot think twice about walking into a kill zone
 * without the cost of a full spotting pass per candidate.
 */
function alertThreatPenalty(view: GameState, bot: PlayerId, x: number, y: number): number {
  let penalty = 0;
  for (const o of Object.values(view.formations)) {
    if (o.owner === bot || !o.onAlert || o.type === 'ARTILLERY') continue;
    if (dist(o.x, o.y, x, y) <= FORMATION_DEFS[o.type].attackRange) penalty += 1.5;
  }
  return penalty;
}

export function decideBotAction(state: GameState, bot: PlayerId, difficulty: BotDifficulty): GameAction | null {
  if (state.activePlayer !== bot || state.phase !== 'PLAYING') return null;
  const w = WEIGHTS[difficulty];

  // The bot's fog-of-war-legitimate view of the world — exactly what a real
  // player in this seat would have been sent over the wire.
  const rawView = filterStateForPlayer(state, bot);
  // Fill the redaction sentinels with estimates so the scoring maths works on
  // the bot's *belief* about the enemy, not on facts it has not earned.
  const view: GameState = {
    ...rawView,
    formations: Object.fromEntries(
      Object.entries(rawView.formations).map(([id, f]) => [id, f.owner === bot ? f : estimateEnemy(f)])
    ),
  };
  const visibleEnemies = Object.values(view.formations).filter((f) => f.owner !== bot);
  // Contacts the bot holds but has NOT identified — the things a recon sweep
  // would actually turn into targets.
  const contacts = Object.values(rawView.players[bot].contacts);
  const unidentified: Contact[] = contacts.filter((c) => c.level === 'CONTACT');
  const stale: Contact[] = contacts.filter((c) => !c.live);
  const mine = Object.values(state.formations).filter((f) => f.owner === bot);
  if (mine.length === 0) return null;

  const candidates: Candidate[] = [];

  // --- UAV RECON (phase 9): a rare, player-level asset — MEDIUM/HARD only,
  // spent deliberately on ground the bot is about to commit to rather than
  // burned reflexively or hoarded to zero effect. It sweeps the highest-value
  // uncontrolled objective the bot does NOT already hold solid (IDENTIFIED+)
  // intelligence on within the sweep radius — i.e. exactly the "unclear
  // territory it is about to assault" case the spec asks for.
  if (difficulty !== 'EASY' && state.players[bot].uavCharges > 0 && affordable(state, 'UAV_RECON')) {
    const contactsList = Object.values(rawView.players[bot].contacts);
    const blindObjective = state.objectives
      .filter((o) => o.controlledBy !== bot)
      .filter(
        (o) =>
          !contactsList.some(
            (c) => dist(c.x, c.y, o.x, o.y) <= UAV_SWEEP_RADIUS && (c.level === 'IDENTIFIED' || c.level === 'CONFIRMED')
          )
      )
      .filter((o) => Object.values(state.formations).some((f) => f.owner === bot && dist(f.x, f.y, o.x, o.y) <= UAV_SWEEP_RADIUS * 2))
      .sort((a, b) => b.vpPerTurn - a.vpPerTurn)[0];
    if (blindObjective) {
      candidates.push({
        action: { type: 'UAV_RECON', x: blindObjective.x, y: blindObjective.y },
        score: 1.4 + blindObjective.vpPerTurn * 0.3,
      });
    }
  }

  for (const f of mine) {
    const def = FORMATION_DEFS[f.type];
    const boundsLeft = Math.min(w.maxBoundsPerUnit, f.movesMax) - f.movesUsed;
    const majorAvailable = !f.hasActedThisTurn;

    // --- ATTACK (melee adjacency, or artillery fire mission at range).
    const isArtillery = f.type === 'ARTILLERY';
    const range = def.attackRange;
    const attackKind: ActionKind = isArtillery ? 'ARTILLERY' : 'ATTACK';
    if (majorAvailable && engine.hasAmmo(f) && affordable(state, attackKind)) {
      for (const e of visibleEnemies) {
        const d = dist(f.x, f.y, e.x, e.y);
        if (d === 0 || d > range) continue;
        // Naval standoff fire needs line of sight, same as the human player's
        // engine — reasons about exactly what it is legitimately allowed to hit.
        if (def.isNaval && d > 1 && !lineOfSight(state.tiles, f.x, f.y, e.x, e.y).clear) continue;
        const ratio = predictRatio(view, f, e);
        const iso = isolationScore(view, e);
        let score = (ratio - 0.5) * 10 + iso * w.isolationBonus;
        if (ratio < w.attackThreshold && iso < 0.6) score -= 8; // a clearly bad attack into a supported, healthy position
        // Standoff fire (artillery, naval at range) is safe and suppresses the
        // target on top of the damage — worth using more readily than the raw
        // damage ratio alone would suggest.
        if (isArtillery || (def.isNaval && d > 1)) score += 1.2;
        if (isArtillery) {
          candidates.push({ action: { type: 'ARTILLERY', formationId: f.id, x: e.x, y: e.y }, score });
        } else {
          candidates.push({ action: { type: 'ATTACK', attackerId: f.id, targetId: e.id }, score });
        }
      }
    }

    // --- AIR: on-call support strikes, reserved for clearly worthwhile (weak/isolated) targets.
    if (majorAvailable && difficulty !== 'EASY' && state.players[bot].airSorties > 0 && affordable(state, 'AIR')) {
      for (const e of visibleEnemies) {
        const iso = isolationScore(view, e);
        if (iso < 0.5) continue;
        candidates.push({ action: { type: 'AIR', x: e.x, y: e.y }, score: 2 + iso * w.isolationBonus * 0.6 });
      }
    }

    // --- RECON: no longer how the bot SEES (spotting is passive now) — it is
    // how the bot IDENTIFIES. A sweep is only worth AP when there is something
    // to resolve: an unidentified contact or a stale one inside sweep range, or
    // a push onto an objective the bot cannot yet see into.
    if (majorAvailable && affordable(state, 'RECON') && state.players[bot].ap > 4) {
      const sweepRange = currentDetectionRange(state, f, true);
      const toIdentify = unidentified.filter((c) => dist(f.x, f.y, c.x, c.y) <= sweepRange).length;
      const toRefresh = stale.filter((c) => dist(f.x, f.y, c.x, c.y) <= sweepRange).length;
      const isReconAsset = DETECTION[f.type].identifyFactor >= 1.15;
      // A line battalion only sweeps when it has an actual unidentified blip in
      // front of it; the sensor units are allowed to screen speculatively.
      if (toIdentify > 0 || isReconAsset) {
        const nearestObj = bestUncontrolledObjective(state.objectives, bot, f.x, f.y, def.isNaval, w.objectiveValueBias);
        let score = w.reconPriority * (isReconAsset ? 1 : 0.4);
        score += toIdentify * 1.5 + toRefresh * 0.35;
        // A recce screen pushed onto the next objective is worth something even
        // with nothing on the plot — that is what finds the enemy's main body.
        if (isReconAsset && nearestObj && nearestObj.d <= sweepRange + 2) score += 1.2;
        // But burning the sweep on empty ground with nothing to resolve is not.
        if (toIdentify === 0 && toRefresh === 0) score -= 1.2;
        candidates.push({ action: { type: 'RECON', formationId: f.id }, score });
      }
    }

    // --- FORTIFY: defend an objective already held when the enemy is in sight.
    const heldNearby = state.objectives.find((o) => o.controlledBy === bot && dist(o.x, o.y, f.x, f.y) <= 1);
    if (majorAvailable && !def.isNaval && heldNearby && !f.fortified && affordable(state, 'FORTIFY') && visibleEnemies.some((e) => dist(e.x, e.y, f.x, f.y) <= currentDetectionRange(state, f))) {
      candidates.push({ action: { type: 'FORTIFY', formationId: f.id }, score: 1.5 + w.objectiveWeight * 0.5 });
    }

    // --- REORGANIZE: stand a damaged formation down when it is safe to do so.
    // Only when it has not moved this round, is off cooldown, and no visible
    // enemy is close enough to make standing still a bad idea.
    const reorgReady =
      majorAvailable &&
      f.movesUsed === 0 &&
      (!f.lastReorganizedRound || state.round - f.lastReorganizedRound >= REORGANIZE_COOLDOWN_ROUNDS) &&
      affordable(state, 'REORGANIZE');
    if (reorgReady) {
      const damaged = f.strength < 75 || f.readiness < 65 || f.suppression > 25;
      const threatened = visibleEnemies.some((e) => dist(e.x, e.y, f.x, f.y) <= 2);
      if (damaged && !threatened) {
        const need = (100 - f.strength) / 40 + (100 - f.readiness) / 50 + (f.suppression ?? 0) / 50;
        candidates.push({ action: { type: 'REORGANIZE', formationId: f.id }, score: 0.8 + need });
      }
    }

    // --- MOVE: the main map driver — path toward the nearest uncontrolled objective,
    // or (Medium/Hard) toward a visible enemy when no objective is known.
    // Naval formations manoeuvre too — they contest anchorages and bring their
    // guns within range of the coast.
    if (boundsLeft > 0 && affordable(state, 'MOVE')) {
      const reachable = engine.computeReachable(state, f.id);
      const zoc = zocTilesFor(state, f);
      if (reachable.size > 0) {
        let targetX = f.x;
        let targetY = f.y;
        let haveTarget = false;
        const nearestObj = bestUncontrolledObjective(state.objectives, bot, f.x, f.y, def.isNaval, w.objectiveValueBias);
        // Support elements (guns, engineers) shadow the manoeuvre formation
        // they are working with once they drift outside cohesion range —
        // artillery and engineers now have the mobility to actually do it.
        const anchor = w.cohesionWeight > 0 && isSupportType(f.type) ? nearestManoeuvre(state, f) : null;
        if (anchor && dist(f.x, f.y, anchor.x, anchor.y) > COHESION_RADIUS) {
          targetX = anchor.x;
          targetY = anchor.y;
          haveTarget = true;
        } else if (nearestObj) {
          targetX = nearestObj.obj.x;
          targetY = nearestObj.obj.y;
          haveTarget = true;
        } else if (visibleEnemies.length && difficulty !== 'EASY') {
          const closest = visibleEnemies.reduce((a, b) => (dist(f.x, f.y, a.x, a.y) <= dist(f.x, f.y, b.x, b.y) ? a : b));
          targetX = closest.x;
          targetY = closest.y;
          haveTarget = true;
        } else if (contacts.length && difficulty !== 'EASY') {
          // Nothing identified, but something is out there: manoeuvre onto the
          // nearest contact marker and let passive spotting do the rest.
          const closest = contacts.reduce((a, b) => (dist(f.x, f.y, a.x, a.y) <= dist(f.x, f.y, b.x, b.y) ? a : b));
          targetX = closest.x;
          targetY = closest.y;
          haveTarget = true;
        }

        let bestTile: { x: number; y: number } | null = null;
        let bestD = Infinity;
        const currentD = haveTarget ? dist(f.x, f.y, targetX, targetY) : 0;
        reachable.forEach((_cost, key) => {
          const [tx, ty] = key.split(',').map(Number);
          const d = haveTarget ? dist(tx, ty, targetX, targetY) : Math.random() * 8;
          if (d < bestD) {
            bestD = d;
            bestTile = { x: tx, y: ty };
          }
        });

        const chosenTile = bestTile as { x: number; y: number } | null;
        if (chosenTile) {
          const improvement = haveTarget ? currentD - bestD : 1;
          let score = improvement * w.objectiveWeight * 0.4;
          score += clusterScore(state, bot, chosenTile.x, chosenTile.y) * w.clusterWeight;
          // Respect enemy Zones of Control and known on-alert formations: a
          // tile under enemy ZOC is a exposed place to stop (unless it IS the
          // objective, which the improvement term already rewards enough to
          // outweigh this), and a tile within a confirmed alert unit's reach
          // risks a reaction shot for nothing.
          if (!def.isNaval && zoc.has(`${chosenTile.x},${chosenTile.y}`)) score -= 1.2;
          score -= alertThreatPenalty(view, bot, chosenTile.x, chosenTile.y);
          if (anchor) {
            // Reward closing on the supported formation, punish drifting away.
            const before = dist(f.x, f.y, anchor.x, anchor.y);
            const after = dist(chosenTile.x, chosenTile.y, anchor.x, anchor.y);
            score += (before - after) * w.cohesionWeight * 0.35;
            if (after > COHESION_RADIUS) score -= w.cohesionWeight;
          }
          // A second or third bound in the same round is still worth taking,
          // but slightly less than the first — keeps AP available elsewhere.
          if (f.movesUsed > 0) score *= 0.8;
          if (difficulty === 'EASY') score = score * 0.3 + Math.random() * 2; // weak, occasionally aimless movement
          candidates.push({ action: { type: 'MOVE', formationId: f.id, x: chosenTile.x, y: chosenTile.y }, score });
        }
      }
    }
  }

  // --- MOVE FORMATION: keep a combined-arms pair together as it advances.
  // The bot uses exactly the same grouped order the player has, so the pacing,
  // AP accounting and destination resolution are the shared engine code.
  if (w.useGroupMoves && affordable(state, 'MOVE')) {
    for (const f of mine) {
      const def = FORMATION_DEFS[f.type];
      if (def.isNaval) continue;
      if (!MANOEUVRE_TYPES.includes(f.type)) continue;
      if (f.movesUsed >= f.movesMax) continue;
      const partner = Object.values(state.formations).find(
        (o) =>
          o.owner === bot &&
          o.id !== f.id &&
          isSupportType(o.type) &&
          o.movesUsed < o.movesMax &&
          dist(o.x, o.y, f.x, f.y) <= COHESION_RADIUS
      );
      if (!partner) continue;
      const obj = bestUncontrolledObjective(state.objectives, bot, f.x, f.y, false, w.objectiveValueBias);
      if (!obj) continue;
      const plan = planGroupMove(state, [f.id, partner.id], obj.obj.x, obj.obj.y);
      if (!plan.ok) continue;
      const movers = plan.members.filter((m) => m.ok);
      if (movers.length < 2) continue;
      const before = movers.reduce((acc, m) => acc + dist(state.formations[m.id].x, state.formations[m.id].y, obj.obj.x, obj.obj.y), 0);
      const after = movers.reduce((acc, m) => acc + dist(m.x, m.y, obj.obj.x, obj.obj.y), 0);
      const improvement = (before - after) / movers.length;
      // Scored per AP spent so it competes fairly with single-unit bounds.
      const score = improvement * w.objectiveWeight * 0.4 + w.cohesionWeight * 0.9;
      candidates.push({
        action: { type: 'MOVE_GROUP', formationIds: movers.map((m) => m.id), x: obj.obj.x, y: obj.obj.y },
        score,
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  // AP pressure: holding a big unspent AP pool at the end of a turn is pure
  // waste, so the more AP is still banked the lower the bar a candidate has to
  // clear. This is what stops the bot ending turns on a full wallet.
  const apLeft = state.players[bot].ap;
  const relaxed = apLeft >= AP_PER_TURN * 0.6 ? 0.15 : apLeft >= AP_PER_TURN * 0.35 ? 0.5 : 1;
  let viable = candidates.filter((c) => c.score >= w.minScore * relaxed);
  if (viable.length === 0) viable = difficulty === 'EASY' ? candidates : [];
  if (viable.length === 0) return null;

  if (Math.random() < w.randomness) {
    return viable[Math.floor(Math.random() * viable.length)].action;
  }
  return viable[0].action;
}
