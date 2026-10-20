// ============================================================================
// The match in progress, kept in localStorage at the start of every round, so
// a reload, a closed tab or "Exit" never throws a game away.
// ============================================================================

import { REGION_IDS } from '../map';
import { FACTIONS, GameState, Order } from '../types';
import type { BotLevel } from '../bot';

const KEY = 'island_ops_match_v1';

export interface SavedMatch {
  game: GameState;
  level: BotLevel;
  draft: Order[];
}

const LEVELS: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];

function looksValid(m: SavedMatch): boolean {
  const g = m?.game;
  if (!g || typeof g !== 'object' || g.phase !== 'PLANNING') return false;
  if (!Array.isArray(g.factions) || !g.factions.length || !g.factions.every((f) => FACTIONS[f] && g.players?.[f])) return false;
  if (!REGION_IDS.every((r) => g.map?.[r] && FACTIONS[g.map[r].owner] && Number.isInteger(g.map[r].troops))) return false;
  if (!g.factions.some((f) => g.players[f]!.human)) return false;
  return LEVELS.includes(m.level) && Array.isArray(m.draft);
}

export function loadMatch(): SavedMatch | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as SavedMatch;
    return looksValid(m) ? m : null;
  } catch {
    return null;
  }
}

export function saveMatch(m: SavedMatch) {
  try {
    if (m.game.phase === 'GAME_OVER') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(m));
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
