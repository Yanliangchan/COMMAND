// ============================================================================
// What the order draft allows, asked of the engine — so the HUD, the picker
// and Ready can never disagree with the rules about what is legal.
// ============================================================================

import { BOARD, SEA_ZONES, ZoneId } from '../map';
import { defenceEstimate, orderIssues, planSummary } from '../engine';
import { FactionId, GameState, Order, PlayerView } from '../types';

export type Movement = Extract<Order, { kind: 'MOVE' | 'LAND' }>;

export const isMovement = (o: Order): o is Movement => o.kind === 'MOVE' || o.kind === 'LAND';

export interface Plan {
  deployLeft: number;
  sortiesLeft: number;
  /** Troops that may still leave a region (one always stays), not counting `except`. */
  available: (region: string, except?: Order) => number;
  /** Seats left on ships in a zone after planned sails, not counting `except`. */
  liftLeft: (zone: ZoneId, except?: Order) => number;
  /** Your ships in a zone once planned sails happen. */
  shipsIn: (zone: ZoneId) => number;
  /** Why each order would be rejected (null if fine), in draft order. */
  issues: (string | null)[];
}

export function plan(state: GameState, me: FactionId, draft: Order[]): Plan {
  const s = planSummary(state, me, draft);
  return {
    deployLeft: s.deployLeft,
    sortiesLeft: s.sortiesLeft,
    available: s.available,
    liftLeft: s.liftLeft,
    shipsIn: s.shipsIn,
    issues: orderIssues(state, me, draft),
  };
}

export interface DefenceReadout {
  /** "4", "3–5" or "?" */
  troops: string;
  /** Lowest and highest the defence could be before air support. */
  low: number;
  high: number;
  bonuses: { label: string; n: number }[];
  mayAddAir: number;
}

export function defence(view: PlayerView, region: string): DefenceReadout {
  const d = defenceEstimate(view, region);
  const bonus = d.bonuses.reduce((n, b) => n + b.n, 0);
  const [lo, hi, text] =
    d.troops.kind === 'exact'
      ? [d.troops.troops, d.troops.troops, String(d.troops.troops)]
      : d.troops.kind === 'band'
        ? [d.troops.min, d.troops.max >= 99 ? 14 : d.troops.max, d.troops.max >= 99 ? `${d.troops.min}+` : `${d.troops.min}–${d.troops.max}`]
        : [1, 12, '?'];
  return { troops: text, low: lo + bonus, high: hi + bonus, bonuses: d.bonuses, mayAddAir: d.mayAddAir };
}

export const regionName = (id: string) => BOARD.byId[id].name;
export const zoneName = (z: ZoneId) => SEA_ZONES[z].name;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
