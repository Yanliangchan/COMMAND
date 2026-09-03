// ============================================================================
// COMMAND — Action availability model.
//
// One pure description of "what can this formation do right now, and if not,
// why not" — shared by the floating action bar, the keyboard shortcut handler,
// the roster badges and the end-turn warning, so all four agree exactly.
// No React, no DOM.
// ============================================================================

import { FORMATION_DEFS } from './data';
import { canReorganize, distance, hasAmmo, maxAmmo, movesRemaining, computeReachable } from './engine';
import { lineOfSight } from './detection';
import { AP_COSTS, ActionKind, Formation, GameState, PlayerId, REORGANIZE_COOLDOWN_ROUNDS, SPECIAL_OP_TYPES } from './types';
import { TargetMode } from '../App.types';

/** Stable identifier for a UI action (1:1 with an engine ActionKind). */
export type ActionId = ActionKind;

export interface ActionSpec {
  id: ActionId;
  label: string;
  /** Single-character keyboard shortcut, upper case. */
  shortcut: string;
  apCost: number;
  /** Target-selection mode this action enters, or null for a fire-and-forget order. */
  mode: TargetMode;
  /** Short beginner-friendly description, used as the button tooltip / help. */
  blurb: string;
}

/** Canonical action table. Order = display order in the action bar. */
export const ACTION_SPECS: ActionSpec[] = [
  {
    id: 'MOVE',
    label: 'Move',
    shortcut: 'M',
    apCost: AP_COSTS.MOVE,
    mode: 'MOVE',
    blurb: 'Reposition the formation. The highlighted area is everywhere it can reach this round; hover a tile for the costed path. Shift-click friendlies then Shift+M to move them as one formation.',
  },
  {
    id: 'ATTACK',
    label: 'Attack',
    shortcut: 'A',
    apCost: AP_COSTS.ATTACK,
    mode: 'ATTACK',
    blurb: 'Engage an enemy formation inside your attack range. Hover a target to see the predicted result — expected losses to both sides and every factor for and against — before you commit.',
  },
  {
    id: 'RECON',
    label: 'Recon',
    shortcut: 'R',
    apCost: AP_COSTS.RECON,
    mode: null,
    blurb: 'Your formations already spot nearby enemies on their own. A Recon sweep goes further: a much longer sensor range, it pushes through forest and built-up ground, and it jumps contacts up the detection ladder — Contact to Identified to Confirmed — and keeps tracking them long after you lose sight. Confirming a target does not make your attack stronger; it makes the pre-attack prediction reliable instead of a wide guess.',
  },
  {
    id: 'FORTIFY',
    label: 'Fortify',
    shortcut: 'F',
    apCost: AP_COSTS.FORTIFY,
    mode: null,
    blurb: 'Dig in. The formation defends much better until it moves again.',
  },
  {
    id: 'ARTILLERY',
    label: 'Fire Mission',
    shortcut: 'G',
    apCost: AP_COSTS.ARTILLERY,
    mode: 'ARTILLERY',
    blurb: 'Long-range gunfire onto a spotted enemy. Artillery only. Each mission spends one round of ammunition; a battery that holds its fire for a round gets one back.',
  },
  {
    id: 'AIR',
    label: 'Air Support',
    shortcut: 'C',
    apCost: AP_COSTS.AIR,
    mode: 'AIR_TARGET',
    blurb: 'Call an air strike on a spotted enemy anywhere on the map. Limited sorties per turn.',
  },
  {
    id: 'ENGINEER_BRIDGE',
    label: 'Build Bridge',
    shortcut: 'B',
    apCost: AP_COSTS.ENGINEER_BRIDGE,
    mode: 'ENGINEER_BRIDGE',
    blurb: 'Engineers only. Bridge an adjacent river tile so land formations can cross.',
  },
  {
    id: 'ENGINEER_CLEAR',
    label: 'Clear Obstacle',
    shortcut: 'O',
    apCost: AP_COSTS.ENGINEER_CLEAR,
    mode: 'ENGINEER_CLEAR',
    blurb: 'Engineers only. Strip an adjacent enemy position of its dug-in defences.',
  },
  {
    id: 'SPECIAL_OP',
    label: 'Special Op',
    shortcut: 'X',
    apCost: AP_COSTS.SPECIAL_OP,
    mode: 'SPECIAL_OP',
    blurb: 'Commandos and Guards only. Raid a distant enemy or probe deep behind their lines.',
  },
  {
    id: 'REORGANIZE',
    label: 'Reorganize',
    shortcut: 'S',
    apCost: AP_COSTS.REORGANIZE,
    mode: null,
    blurb: `Stand down to reconstitute: restores readiness, morale and a little strength immediately. Only if the formation has made no movement action this round, and not more than once every ${REORGANIZE_COOLDOWN_ROUNDS} rounds.`,
  },
];

export const ACTION_BY_SHORTCUT: Record<string, ActionSpec> = Object.fromEntries(
  ACTION_SPECS.map((a) => [a.shortcut, a])
);

export interface ActionAvailability extends ActionSpec {
  /** False when the action is not applicable to this unit type at all (hidden). */
  applicable: boolean;
  enabled: boolean;
  /** Human-readable reason the action is disabled, '' when enabled. */
  reason: string;
}

/**
 * Enemies this side can actually shoot at. `state.formations` on the client is
 * already fog-filtered, so an enemy only appears here once passive spotting (or
 * recon) has taken it to IDENTIFIED or better — a Contact-only blip is a
 * position, not a target.
 */
function enemiesInRange(state: GameState, f: Formation): number {
  const def = FORMATION_DEFS[f.type];
  const range = def.attackRange;
  return Object.values(state.formations).filter((e) => {
    if (e.owner === f.owner) return false;
    const d = distance(f.x, f.y, e.x, e.y);
    if (d < 1 || d > range) return false;
    // Naval standoff fire (phase 7) needs line of sight, just like passive
    // spotting — a target masked by intervening high ground is out of reach.
    if (def.isNaval && d > 1 && !lineOfSight(state.tiles, f.x, f.y, e.x, e.y).clear) return false;
    return true;
  }).length;
}

/** Any enemy the player can currently see anywhere (needed for air strikes). */
function visibleEnemies(state: GameState, owner: PlayerId): number {
  return Object.values(state.formations).filter((e) => e.owner !== owner).length;
}

/** True when an enemy is within weapon range but the only thing stopping the
 *  shot is line of sight — lets the UI tell a naval player the difference
 *  between "nothing out there" and "something's out there, but masked". */
function anyEnemyInRangeIgnoringLOS(state: GameState, f: Formation): boolean {
  const range = FORMATION_DEFS[f.type].attackRange;
  return Object.values(state.formations).some((e) => {
    if (e.owner === f.owner) return false;
    const d = distance(f.x, f.y, e.x, e.y);
    return d >= 1 && d <= range;
  });
}

/**
 * Full availability read-out for one formation. `viewer` is the player looking
 * at the panel; actions are only ever enabled for their own formations on
 * their own turn.
 */
export function actionAvailability(state: GameState, f: Formation, viewer: PlayerId): ActionAvailability[] {
  const def = FORMATION_DEFS[f.type];
  const ap = state.players[viewer].ap;
  const isMine = f.owner === viewer;
  const myTurn = state.activePlayer === viewer;
  const majorFree = !f.hasActedThisTurn;
  const moves = movesRemaining(f);

  return ACTION_SPECS.map((spec) => {
    let applicable = true;
    switch (spec.id) {
      case 'ARTILLERY':
        applicable = f.type === 'ARTILLERY';
        break;
      case 'ENGINEER_BRIDGE':
      case 'ENGINEER_CLEAR':
        applicable = f.type === 'ENGINEER';
        break;
      case 'SPECIAL_OP':
        applicable = SPECIAL_OP_TYPES.includes(f.type);
        break;
      default:
        applicable = true;
    }

    let reason = '';
    if (!isMine) reason = 'This formation belongs to the other side.';
    else if (!myTurn) reason = 'Not your turn.';
    else if (spec.id === 'MOVE' && moves <= 0) reason = `No movement actions left this round (${f.movesMax}/${f.movesMax} used).`;
    else if (spec.id !== 'MOVE' && spec.id !== 'AIR' && !majorFree) reason = 'This formation has already taken its major action this round.';
    else if (ap < spec.apCost) reason = `Not enough AP — needs ${spec.apCost}, you have ${ap}.`;
    else if (spec.id === 'MOVE' && computeReachable(state, f.id).size === 0) reason = 'No reachable tile from here.';
    else if (spec.id === 'ATTACK' && !hasAmmo(f))
      reason = `No ready rounds left (0 / ${maxAmmo(f)}). Hold fire for a round and one comes back.`;
    else if (spec.id === 'ATTACK' && enemiesInRange(state, f) === 0)
      reason = def.isNaval && anyEnemyInRangeIgnoringLOS(state, f)
        ? `Enemy within range but no line of sight — intervening terrain masks it from naval gunfire. Reposition for a clear shot.`
        : `No identified enemy within attack range (${def.attackRange} tiles). Your formations spot nearby enemies automatically — close the distance, or use Recon (R) to identify a contact.`;
    else if (spec.id === 'ARTILLERY' && !hasAmmo(f))
      reason = `No ready rounds left (0 / ${maxAmmo(f)}). Hold fire for a round and one comes back.`;
    else if (spec.id === 'ARTILLERY' && enemiesInRange(state, f) === 0)
      reason = `No identified enemy within ${def.attackRange} tiles to fire on.`;
    else if (spec.id === 'AIR' && state.players[viewer].airSorties < 1) reason = 'No air sorties left this turn.';
    else if (spec.id === 'AIR' && visibleEnemies(state, f.owner) === 0)
      reason = 'No identified enemy to strike — push a formation forward until it spots one, or Recon (R) an existing contact to identify it.';
    else if (spec.id === 'REORGANIZE' && f.movesUsed > 0)
      reason = 'Reorganize requires the formation to stand fast — it has already used a movement action this round.';
    else if (spec.id === 'REORGANIZE' && !canReorganize(state, f))
      reason = `Still recovering from its last reorganization — ready again in ${REORGANIZE_COOLDOWN_ROUNDS - (state.round - f.lastReorganizedRound)} round(s).`;

    return { ...spec, applicable, enabled: reason === '', reason };
  });
}

/** Cheapest AP cost of any action this formation could still usefully take. */
export function hasAnyAction(state: GameState, f: Formation, viewer: PlayerId): boolean {
  return actionAvailability(state, f, viewer).some((a) => a.applicable && a.enabled);
}

export interface FormationActivity {
  movesLeft: number;
  majorFree: boolean;
  /** True when at least one action is actually executable right now. */
  actionable: boolean;
}

export function formationActivity(state: GameState, f: Formation, viewer: PlayerId): FormationActivity {
  return {
    movesLeft: movesRemaining(f),
    majorFree: !f.hasActedThisTurn,
    actionable: hasAnyAction(state, f, viewer),
  };
}

/** Formations belonging to `viewer` that still have something to do, in map order. */
export function formationsWithActions(state: GameState, viewer: PlayerId): Formation[] {
  return Object.values(state.formations)
    .filter((f) => f.owner === viewer && hasAnyAction(state, f, viewer))
    .sort((a, b) => a.id.localeCompare(b.id));
}
