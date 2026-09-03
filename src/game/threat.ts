// ============================================================================
// COMMAND — Priority-targets readout (phase 12 §2).
//
// "Which 1-2 enemy formations most threaten me right now" — computed purely
// from the VIEWER's already fog-filtered GameState. This module never reads
// anything beyond `state.formations` / `state.players[viewer].contacts`, so
// it is fog-correct BY CONSTRUCTION: an enemy formation the viewer's side has
// not detected simply is not present in `state.formations` at all (fog.ts
// strips it entirely at UNKNOWN and CONTACT — a CONTACT-only blip carries no
// type/strength/movement information to reason about a threat with, so this
// module only ever considers IDENTIFIED or CONFIRMED enemies, exactly the
// rung at which an arm — and therefore a public MOBILITY/FORMATION_DEFS
// profile — is known at all).
//
// Reach is estimated from PUBLIC, type-level constants (attack range,
// MOBILITY's move range x moves-per-round) — the same numbers printed on the
// Field Manual and the unit card for that arm — never from the individual
// target's own (possibly redacted) instance fields. An IDENTIFIED contact's
// strength/readiness are unknown (redacted -1), so a neutral estimate
// standing in for them (mirroring the same ESTIMATED_STRENGTH the bot uses)
// is the honest ceiling of what the player could infer, not a peek at the
// true numbers.
// ============================================================================

import { FORMATION_DEFS } from './data';
import { Formation, GameState, MOBILITY, PlayerId } from './types';

function manhattan(x0: number, y0: number, x1: number, y1: number) {
  return Math.abs(x0 - x1) + Math.abs(y0 - y1);
}

/** Neutral estimate for a redacted (IDENTIFIED-only) enemy's strength — mirrors bot.ts's ESTIMATED_STRENGTH. */
const ESTIMATED_STRENGTH = 80;

export interface PriorityTarget {
  formationId: string;
  /** Generic ("Enemy Infantry") at IDENTIFIED, real short name at CONFIRMED — whatever the fog-filtered object already carries. */
  label: string;
  x: number;
  y: number;
  /** How many of the viewer's own formations sit within this enemy's estimated reach next turn. */
  threatenedCount: number;
  /** The viewer's own formation names within reach, for the tooltip. */
  threatenedNames: string[];
  score: number;
}

/**
 * Estimated total reach (attack range + one round of movement) for `e`'s arm,
 * in tiles — a coarse straight-line budget, not a real pathfind, which is
 * appropriate for a "who should worry me" readout rather than a guaranteed
 * prediction.
 */
function estimatedReach(e: Formation): number {
  const def = FORMATION_DEFS[e.type];
  const mob = MOBILITY[e.type];
  return def.attackRange + mob.moveRange * mob.movesPerRound;
}

/**
 * The 1-2 enemy formations that most threaten the viewer's position right
 * now, computed ONLY from `state` as already delivered to that viewer (a
 * fog-filtered GameState — pass the client's own state, or on the server a
 * `filterStateForPlayer(state, viewer)` view; never the raw authoritative
 * state).
 */
export function computePriorityTargets(state: GameState, viewer: PlayerId, limit = 2): PriorityTarget[] {
  const mine = Object.values(state.formations).filter((f) => f.owner === viewer);
  if (!mine.length) return [];

  const results: PriorityTarget[] = [];
  for (const e of Object.values(state.formations)) {
    if (e.owner === viewer) continue;
    // Only IDENTIFIED/CONFIRMED enemies carry a real `type` and are present
    // as full formation objects at all — a CONTACT-only blip never reaches
    // this loop (fog.ts omits the formation object entirely below IDENTIFIED)
    // and an UNKNOWN enemy is never on the wire in the first place.
    const reach = estimatedReach(e);
    const threatened = mine.filter((m) => manhattan(e.x, e.y, m.x, m.y) <= reach);
    if (!threatened.length) continue;
    const estStrength = e.redacted || e.strength < 0 ? ESTIMATED_STRENGTH : e.strength;
    const power = FORMATION_DEFS[e.type].baseAttack * (estStrength / 100);
    const score = threatened.reduce((s, m) => {
      const d = Math.max(1, manhattan(e.x, e.y, m.x, m.y));
      return s + (power / d) * (0.4 + m.strength / 100);
    }, 0);
    results.push({
      formationId: e.id,
      label: e.redacted ? e.name : e.shortName,
      x: e.x,
      y: e.y,
      threatenedCount: threatened.length,
      threatenedNames: threatened.map((m) => m.shortName),
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
