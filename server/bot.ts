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
// Difficulty is a set of scoring weights over a shared candidate-generation
// pass (per formation: move / attack / recon / fortify / resupply / air),
// each candidate scored by a small utility function, best score wins. This
// is deliberately a greedy per-action policy, not a search tree — the AP
// budget already forces a natural multi-step "plan" to emerge turn to turn.
// ============================================================================

import * as engine from '../src/game/engine';
import { filterStateForPlayer } from '../src/game/fog';
import { FORMATION_DEFS } from '../src/game/data';
import { ActionKind, AP_COSTS, Formation, GameState, Objective, PlayerId } from '../src/game/types';
import { GameAction } from '../src/net/protocol';

export type BotDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

interface Weights {
  objectiveWeight: number; // how strongly to path toward uncontrolled objectives
  attackThreshold: number; // predicted win-ratio below which an attack is considered "bad"
  isolationBonus: number; // reward per point of target weakness/isolation (combined-arms target priority)
  reconPriority: number; // baseline value of a recon sweep
  resupplyThreshold: number; // supply % below which resupplying takes priority over offense
  clusterWeight: number; // reward massing near friendlies (crude combined-arms positioning)
  randomness: number; // chance to ignore the best-scoring candidate and pick a weaker one
  minScore: number; // candidates below this aren't worth spending AP on
}

const WEIGHTS: Record<BotDifficulty, Weights> = {
  // Mostly-random legal moves, weak objective/combined-arms awareness, will
  // take bad attacks and can waste AP on low-value actions.
  EASY: { objectiveWeight: 0.4, attackThreshold: 0, isolationBonus: 0, reconPriority: 0.2, resupplyThreshold: 15, clusterWeight: 0, randomness: 0.45, minScore: -100 },
  // Prioritizes objectives, recons before committing when AP allows, avoids
  // clearly bad attacks, keeps an eye on supply.
  MEDIUM: { objectiveWeight: 1.1, attackThreshold: 0.42, isolationBonus: 4, reconPriority: 0.7, resupplyThreshold: 35, clusterWeight: 0.3, randomness: 0.12, minScore: 0.2 },
  // Combined-arms aware, target-prioritizes weakened/isolated formations,
  // defends held objectives, manages logistics, spends its AP efficiently.
  HARD: { objectiveWeight: 1.4, attackThreshold: 0.5, isolationBonus: 9, reconPriority: 1.1, resupplyThreshold: 55, clusterWeight: 0.8, randomness: 0.02, minScore: 0.5 },
};

interface Candidate {
  action: GameAction;
  score: number;
}

function dist(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

function nearestUncontrolledObjective(objectives: Objective[], bot: PlayerId, x: number, y: number): { obj: Objective; d: number } | null {
  let best: { obj: Objective; d: number } | null = null;
  for (const o of objectives) {
    if (o.controlledBy === bot) continue;
    const d = dist(x, y, o.x, o.y);
    if (!best || d < best.d) best = { obj: o, d };
  }
  return best;
}

/** Predicted attacker-favor ratio (0..1), same formula as engine.attackAction, with no side effects. */
function predictRatio(state: GameState, attacker: Formation, target: Formation): number {
  const attackerTile = state.tiles[attacker.y][attacker.x];
  const defenderTile = state.tiles[target.y][target.x];
  const atk = engine.computePower(state, attacker, 'attack', attackerTile, [], { revealed: true });
  const def = engine.computePower(state, target, 'defense', defenderTile, []);
  return atk / (atk + def);
}

/** How weak / unsupported a (visible) enemy target looks — the combined-arms target-priority signal. */
function isolationScore(view: GameState, target: Formation): number {
  const friendsNearby = Object.values(view.formations).filter(
    (f) => f.owner === target.owner && f.id !== target.id && dist(f.x, f.y, target.x, target.y) <= 2
  ).length;
  const weakness = Math.max(0, (60 - target.strength) / 60); // 0..1, more damaged = higher
  const isolation = Math.max(0, (2 - friendsNearby) / 2); // 0..1, fewer nearby friends = higher
  return weakness + isolation;
}

function clusterScore(state: GameState, bot: PlayerId, x: number, y: number): number {
  return Object.values(state.formations).filter((f) => f.owner === bot && dist(f.x, f.y, x, y) <= 2).length;
}

function affordable(state: GameState, kind: ActionKind) {
  return state.players[state.activePlayer].ap >= AP_COSTS[kind];
}

export function decideBotAction(state: GameState, bot: PlayerId, difficulty: BotDifficulty): GameAction | null {
  if (state.activePlayer !== bot || state.phase !== 'PLAYING') return null;
  const w = WEIGHTS[difficulty];

  // The bot's fog-of-war-legitimate view of the world — exactly what a real
  // player in this seat would have been sent over the wire.
  const view = filterStateForPlayer(state, bot);
  const visibleEnemies = Object.values(view.formations).filter((f) => f.owner !== bot);
  const mine = Object.values(state.formations).filter((f) => f.owner === bot && !f.hasActedThisTurn && !f.embarkedOn);
  if (mine.length === 0) return null;

  const candidates: Candidate[] = [];

  for (const f of mine) {
    const def = FORMATION_DEFS[f.type];

    // --- RESUPPLY: logistics management — don't push an offense on empty tanks.
    if (f.supply < w.resupplyThreshold && affordable(state, 'RESUPPLY') && engine.isInSupplyRange(state, f)) {
      candidates.push({ action: { type: 'RESUPPLY', formationId: f.id }, score: 6 - f.supply / 20 });
    }

    // --- ATTACK (melee adjacency, or artillery fire mission at range).
    const isArtillery = f.type === 'ARTILLERY';
    const range = isArtillery ? 6 : 1;
    const attackKind: ActionKind = isArtillery ? 'ARTILLERY' : 'ATTACK';
    if ((def.maxAmmo === null || f.ammo > 0) && affordable(state, attackKind)) {
      for (const e of visibleEnemies) {
        const d = dist(f.x, f.y, e.x, e.y);
        if (d === 0 || d > range) continue;
        if (!isArtillery && d !== 1) continue;
        const ratio = predictRatio(state, f, e);
        const iso = isolationScore(view, e);
        let score = (ratio - 0.5) * 10 + iso * w.isolationBonus;
        if (ratio < w.attackThreshold && iso < 0.6) score -= 8; // a clearly bad attack into a supported, healthy position
        if (isArtillery) {
          candidates.push({ action: { type: 'ARTILLERY', formationId: f.id, x: e.x, y: e.y }, score });
        } else {
          candidates.push({ action: { type: 'ATTACK', attackerId: f.id, targetId: e.id }, score });
        }
      }
    }

    // --- AIR: on-call support strikes, reserved for clearly worthwhile (weak/isolated) targets.
    if (difficulty !== 'EASY' && state.players[bot].airSorties > 0 && affordable(state, 'AIR')) {
      for (const e of visibleEnemies) {
        const iso = isolationScore(view, e);
        if (iso < 0.5) continue;
        candidates.push({ action: { type: 'AIR', x: e.x, y: e.y }, score: 2 + iso * w.isolationBonus * 0.6 });
      }
    }

    // --- RECON: reveal before committing, when there's AP surplus to spend on it.
    if ((f.type === 'RECON' || f.type === 'COMMANDO') && affordable(state, 'RECON') && state.players[bot].ap > 4) {
      const nearestObj = nearestUncontrolledObjective(state.objectives, bot, f.x, f.y);
      let score = w.reconPriority;
      if (nearestObj && nearestObj.d <= def.reconRadius + 2) score += 1.5;
      candidates.push({ action: { type: 'RECON', formationId: f.id }, score });
    }

    // --- FORTIFY: defend an objective already held when the enemy is in sight.
    const heldNearby = state.objectives.find((o) => o.controlledBy === bot && dist(o.x, o.y, f.x, f.y) <= 1);
    if (heldNearby && !f.fortified && affordable(state, 'FORTIFY') && visibleEnemies.some((e) => dist(e.x, e.y, f.x, f.y) <= def.sightRadius)) {
      candidates.push({ action: { type: 'FORTIFY', formationId: f.id }, score: 1.5 + w.objectiveWeight * 0.5 });
    }

    // --- MOVE: the main map driver — path toward the nearest uncontrolled objective,
    // or (Medium/Hard) toward a visible enemy when no objective is known.
    if (affordable(state, 'MOVE') && !def.isNaval) {
      const reachable = engine.computeReachable(state, f.id);
      if (reachable.size > 0) {
        let targetX = f.x;
        let targetY = f.y;
        let haveTarget = false;
        const nearestObj = nearestUncontrolledObjective(state.objectives, bot, f.x, f.y);
        if (nearestObj) {
          targetX = nearestObj.obj.x;
          targetY = nearestObj.obj.y;
          haveTarget = true;
        } else if (visibleEnemies.length && difficulty !== 'EASY') {
          const closest = visibleEnemies.reduce((a, b) => (dist(f.x, f.y, a.x, a.y) <= dist(f.x, f.y, b.x, b.y) ? a : b));
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
          if (difficulty === 'EASY') score = score * 0.3 + Math.random() * 2; // weak, occasionally aimless movement
          candidates.push({ action: { type: 'MOVE', formationId: f.id, x: chosenTile.x, y: chosenTile.y }, score });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  let viable = candidates.filter((c) => c.score >= w.minScore);
  if (viable.length === 0) viable = difficulty === 'EASY' ? candidates : [];
  if (viable.length === 0) return null;

  if (Math.random() < w.randomness) {
    return viable[Math.floor(Math.random() * viable.length)].action;
  }
  return viable[0].action;
}
