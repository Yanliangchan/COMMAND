// ============================================================================
// The match in progress, kept in localStorage at the start of every round, so
// a reload, a closed tab or "Exit" never throws a game away.
// ============================================================================

import { REGION_IDS, ZONE_IDS } from '../map';
import { budget, orderIssues, planSummary, viewFor } from '../engine';
import { FACTIONS, FACTION_IDS, GameState, MAX_ROUNDS, Order } from '../types';
import type { BotLevel } from '../bot';

const KEY = 'island_ops_match_v1';

export interface SavedMatch {
  game: GameState;
  level: BotLevel;
  draft: Order[];
}

const LEVELS: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];

const isInt = (n: unknown, min = 0): n is number => Number.isInteger(n) && (n as number) >= min;

/**
 * A saved match is only offered if every field the game reads has the right
 * shape — and if the game can actually be computed from it. A save that would
 * crash on Continue would otherwise crash every time.
 */
function looksValid(m: SavedMatch): boolean {
  const g = m?.game;
  if (!g || typeof g !== 'object' || !isInt(g.round, 1) || g.round > MAX_ROUNDS || typeof g.rng !== 'number') return false;
  // A finished match is kept until its end screen has been seen (leaving during the deciding round's playback).
  if (g.phase !== 'PLANNING' && !(g.phase === 'GAME_OVER' && g.factions?.includes(g.winner as never))) return false;
  if (!Array.isArray(g.factions) || !g.factions.length || !g.factions.every((f) => FACTION_IDS.includes(f))) return false;
  const players = g.factions.map((f) => g.players?.[f]);
  if (!players.every((p, i) => p && p.id === g.factions[i] && typeof p.alive === 'boolean' && typeof p.human === 'boolean' && isInt(p.vp) && isInt(p.reconsUsed) && Array.isArray(p.revealed)))
    return false;
  if (players.filter((p) => p!.human).length !== 1) return false;
  if (!REGION_IDS.every((r) => g.map?.[r] && g.factions.includes(g.map[r].owner) && isInt(g.map[r].troops, 1) && typeof g.map[r].unit === 'string')) return false;
  if (!Array.isArray(g.ships) || !g.ships.every((sh) => sh && typeof sh.id === 'string' && g.factions.includes(sh.owner) && (sh.zone === null || ZONE_IDS.includes(sh.zone)) && isInt(sh.repair)))
    return false;
  if (new Set(g.ships.map((sh) => sh.id)).size !== g.ships.length) return false;
  if (!Array.isArray(g.log) || !g.stats || !isInt(g.stats.battles) || !isInt(g.stats.captures)) return false;
  if (!LEVELS.includes(m.level) || !Array.isArray(m.draft) || m.draft.length > 200) return false;
  // Dry run: everything the match screen computes on its first render.
  try {
    const me = g.factions.find((f) => g.players[f]!.human)!;
    // Every task force's view (the bots plan from theirs, including last round's report).
    for (const f of g.factions) {
      viewFor(g, f);
      budget(g, f);
    }
    planSummary(g, me, m.draft);
    if (orderIssues(g, me, m.draft).length !== m.draft.length) return false;
  } catch {
    return false;
  }
  return !!FACTIONS[g.factions[0]];
}

const REGIONS = new Set(REGION_IDS);
const ZONES = new Set<string>(ZONE_IDS);
const count = (n: unknown) => Number.isInteger(n) && (n as number) > 0;

/**
 * Orders that name things that exist. A draft order can be legitimately
 * flagged (a landing whose ship has sailed away) and is kept; one that names
 * no real region, zone or ship can't even be drawn, so it's dropped.
 */
function wellFormed(o: Order, g: GameState): boolean {
  if (!o || typeof o !== 'object') return false;
  switch (o.kind) {
    case 'DEPLOY':
      return REGIONS.has(o.region) && count(o.count);
    case 'MOVE':
      return REGIONS.has(o.from) && REGIONS.has(o.to) && count(o.count);
    case 'LAND':
      return REGIONS.has(o.from) && REGIONS.has(o.to) && ZONES.has(o.zone) && count(o.count);
    case 'SAIL':
      return ZONES.has(o.to) && g.ships.some((sh) => sh.id === o.ship);
    case 'STRIKE':
    case 'CAS':
      return REGIONS.has(o.region);
    default:
      return false;
  }
}

export function loadMatch(): SavedMatch | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SavedMatch;
    if (m && typeof m === 'object' && Array.isArray(m.draft) && Array.isArray(m.game?.ships)) m.draft = m.draft.filter((o) => wellFormed(o, m.game));
    // Narration that can't be read is dropped rather than allowed to break the Log tab.
    if (m?.game && Array.isArray(m.game.log))
      m.game.log = m.game.log.filter(
        (l) =>
          l && typeof l === 'object' && isInt(l.round, 1) && typeof l.text === 'string' && (l.who === null || FACTION_IDS.includes(l.who)) &&
          (l.seen === undefined || (Array.isArray(l.seen) && l.seen.every((f) => FACTION_IDS.includes(f)))) && (l.open === undefined || typeof l.open === 'string'),
      );
    return looksValid(m) ? m : null;
  } catch {
    return null;
  }
}

export function saveMatch(m: SavedMatch) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Storage full or blocked: the match simply won't survive a reload.
  }
}

export function clearMatch() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
