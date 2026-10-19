// ============================================================================
// ISLAND OPS — bot commanders.
//
// `botAction` returns the single next action for whoever's turn it is, so the
// UI can play bot turns one visible step at a time and the sim can loop it.
// The heuristics are deliberately simple and aggressive: pick a sector to go
// for, stack troops on the border facing it, attack at good odds, consolidate.
// ============================================================================

import { BOARD, SECTOR_IDS, SECTORS, SectorId, regionsInSector } from './map';
import { attackOptions, canStrike, connectedOwned, current, findSet, player, regionsOf } from './engine';
import { Action, FactionId, GameState, MAX_HAND } from './types';

export type BotLevel = 'RECRUIT' | 'REGULAR' | 'VETERAN';

/** How many more troops than the defender a bot wants before it attacks. */
const ATTACK_MARGIN: Record<BotLevel, number> = { RECRUIT: 3, REGULAR: 1, VETERAN: 0 };

function enemyNeighbours(s: GameState, r: string): string[] {
  const me = s.map[r].owner;
  return BOARD.byId[r].neighbours.filter((n) => s.map[n].owner !== me);
}

/** Sectors this bot cares about, best first: its mission sectors, then those it nearly holds. */
function sectorPriority(s: GameState, me: FactionId): Map<SectorId, number> {
  const mission = player(s, me).mission;
  const scores = new Map<SectorId, number>();
  for (const sec of SECTOR_IDS) {
    const regions = regionsInSector(sec);
    const owned = regions.filter((r) => s.map[r].owner === me).length;
    let score = owned / regions.length + SECTORS[sec].bonus / 20;
    if (mission.kind === 'SECTORS' && mission.sectors!.includes(sec)) score += 0.6;
    scores.set(sec, score);
  }
  return scores;
}

function targetValue(s: GameState, me: FactionId, to: string, prio: Map<SectorId, number>): number {
  const r = BOARD.byId[to];
  const defender = s.map[to].owner;
  let v = prio.get(r.sector)! * 2;
  const sectorRegions = regionsInSector(r.sector);
  const missing = sectorRegions.filter((x) => s.map[x].owner !== me).length;
  if (missing === 1) v += 2; // completes the sector
  // Break a rival's sector bonus.
  if (sectorRegions.every((x) => s.map[x].owner === defender)) v += 1.5;
  const mission = player(s, me).mission;
  if (mission.kind === 'ELIMINATE' && mission.target === defender) v += 1.5;
  // Finishing off a nearly-dead faction pays its cards.
  if (regionsOf(s, defender).length <= 2) v += 1.5;
  return v;
}

function bestStagingRegion(s: GameState, me: FactionId): string {
  const prio = sectorPriority(s, me);
  let best = regionsOf(s, me)[0];
  let bestScore = -Infinity;
  for (const r of regionsOf(s, me)) {
    const enemies = enemyNeighbours(s, r);
    if (!enemies.length) continue;
    let score = 0;
    for (const e of enemies) score = Math.max(score, targetValue(s, me, e, prio) - s.map[e].troops * 0.15);
    score += s.map[r].troops * 0.05; // keep stacking one spearhead rather than spreading thin
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

export function botAction(s: GameState, level: BotLevel = 'REGULAR'): Action {
  const me = current(s);
  const p = player(s, me);

  if (s.pendingMove) {
    const { from, max, min } = s.pendingMove;
    // Leave a guard behind only if the origin still faces the enemy.
    const keep = enemyNeighbours(s, from).length ? Math.ceil((max + 1) / 3) : 0;
    return { type: 'MOVE_IN', count: Math.max(min, max - keep) };
  }

  if (s.phase === 'MOBILISE' || s.reserve > 0) {
    const set = findSet(p.cards);
    const mayTrade = s.phase === 'MOBILISE' || p.cards.length > MAX_HAND;
    const wantsTrade = p.cards.length >= MAX_HAND || level !== 'RECRUIT' || p.cards.length >= 4;
    if (set && mayTrade && wantsTrade) return { type: 'TRADE', cardIds: set.map((c) => c.id) };
    if (s.reserve > 0) return { type: 'PLACE', region: bestStagingRegion(s, me), count: s.reserve };
    return { type: 'END_MOBILISE' };
  }

  if (s.phase === 'ASSAULT') {
    const prio = sectorPriority(s, me);
    if (canStrike(s)) {
      let best: string | null = null, bestV = 0;
      for (const r of BOARD.regions) {
        const h = s.map[r.id];
        if (h.owner === me || h.troops < 2) continue;
        const touching = r.neighbours.some((n) => s.map[n].owner === me);
        const v = targetValue(s, me, r.id, prio) + (touching ? 2 : 0) + Math.min(h.troops, 6) * 0.1;
        if (v > bestV) {
          bestV = v;
          best = r.id;
        }
      }
      if (best) return { type: 'STRIKE', region: best };
    }

    let bestAttack: Action | null = null, bestScore = 0;
    for (const from of regionsOf(s, me)) {
      const troops = s.map[from].troops;
      for (const opt of attackOptions(s, from)) {
        const def = s.map[opt.to].troops;
        const margin = opt.mode === 'AMPHIBIOUS' ? ATTACK_MARGIN[level] + 2 : ATTACK_MARGIN[level];
        if (troops - 1 < def + margin) continue;
        const odds = (troops - 1) / (def + 1);
        const score = targetValue(s, me, opt.to, prio) + Math.min(odds, 4);
        if (score > bestScore) {
          bestScore = score;
          bestAttack = { type: 'ATTACK', from, to: opt.to, blitz: true };
        }
      }
    }
    if (bestAttack) return bestAttack;
    return { type: 'END_ASSAULT' };
  }

  // REDEPLOY: pull the biggest idle stack forward to the most threatened border.
  let src: string | null = null;
  for (const r of regionsOf(s, me)) {
    if (enemyNeighbours(s, r).length || s.map[r].troops < 2) continue;
    if (!src || s.map[r].troops > s.map[src].troops) src = r;
  }
  if (src) {
    let dest: string | null = null, threat = -1;
    for (const r of connectedOwned(s, src)) {
      const enemies = enemyNeighbours(s, r);
      if (!enemies.length) continue;
      const t = enemies.reduce((n, e) => n + s.map[e].troops, 0) - s.map[r].troops * 0.5;
      if (t > threat) {
        threat = t;
        dest = r;
      }
    }
    if (dest) return { type: 'REDEPLOY', from: src, to: dest, count: s.map[src].troops - 1 };
  }
  return { type: 'END_TURN' };
}
