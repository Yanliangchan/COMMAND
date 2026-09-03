// ============================================================================
// COMMAND — Wire protocol shared between the browser client (src/net/client.ts)
// and the Node WebSocket server (server/index.ts). Pure TypeScript, no
// DOM/React/browser APIs — importable from both sides.
// ============================================================================

import { GameState, PlayerId } from '../game/types';

/**
 * The tile grid is 6,400 tiles (~400 KB of JSON) and changes only when an
 * engineer throws a bridge, so incremental `state` pushes elide it and the
 * client reuses the grid it already has. `start` (and any resync) always
 * carries the full grid.
 */
export type WireGameState = Omit<GameState, 'tiles'> & { tiles?: GameState['tiles'] };

/**
 * REPLAY LINKS (phase 11 §6). The replay viewer (components/Replay.tsx)
 * never reads `.tiles` at all — it draws plain dots on a blank grid — so a
 * shared replay link never carries the ~400 KB tile grid, either from a live
 * match or from the server's saved replay store.
 */
export type ReplayViewState = Omit<GameState, 'tiles'>;

export type BotDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

/**
 * CUSTOM MATCH RULES (phase 11 §4) — only meaningful on the Create Room path
 * (Quick Match and vs-Bot keep sensible defaults, see server/index.ts). Every
 * field is optional; an absent field keeps the default. `mapChoice` is either
 * 'RANDOM' (draw uniformly from the ten-scenario pool, the default) or one of
 * scenarios.ts's scenario ids. `initiative` is 'RANDOM' (the existing rolled
 * behaviour), 'HOST' (the room's creator moves first) or 'GUEST' (the second
 * player to join moves first).
 */
export interface CreateRulesInput {
  apPerTurn?: number;
  vpToWin?: number;
  roundLimit?: number;
  mapChoice?: 'RANDOM' | string;
  initiative?: 'RANDOM' | 'HOST' | 'GUEST';
}

/** What a room's settings resolved to — echoed back so a joining player can see them before the match starts. */
export interface RoomRulesInfo {
  apPerTurn: number;
  vpToWin: number;
  roundLimit: number;
  mapName: string;
  initiative: 'RANDOM' | 'HOST' | 'GUEST';
}

export type GameAction =
  | { type: 'MOVE'; formationId: string; x: number; y: number }
  | { type: 'MOVE_GROUP'; formationIds: string[]; x: number; y: number }
  | { type: 'ATTACK'; attackerId: string; targetId: string }
  | { type: 'RECON'; formationId: string }
  | { type: 'FORTIFY'; formationId: string }
  | { type: 'ENGINEER_BRIDGE'; formationId: string; x: number; y: number }
  | { type: 'ENGINEER_CLEAR'; formationId: string; x: number; y: number }
  | { type: 'ARTILLERY'; formationId: string; x: number; y: number }
  | { type: 'AIR'; x: number; y: number }
  | { type: 'SPECIAL_OP'; formationId: string; x: number; y: number }
  | { type: 'REORGANIZE'; formationId: string }
  | { type: 'VERTICAL_INSERT'; formationId: string; x: number; y: number }
  | { type: 'UAV_RECON'; x: number; y: number }
  | { type: 'END_TURN' };

export type ClientMsg =
  | { t: 'create'; rules?: CreateRulesInput }
  | { t: 'join'; code: string }
  | { t: 'spectate'; code: string }
  | { t: 'quick' }
  | { t: 'bot'; difficulty: BotDifficulty }
  | { t: 'reconnect'; code: string; token: string }
  | { t: 'action'; action: GameAction }
  | { t: 'leave' }
  | { t: 'get_replay'; code: string };

export type ServerMsg =
  | { t: 'created'; code: string; token: string; you: PlayerId; rules: RoomRulesInfo }
  | { t: 'joined'; code: string; token: string; you: PlayerId; rules: RoomRulesInfo }
  | { t: 'waiting' }
  | { t: 'searching' }
  | { t: 'start'; state: GameState; you: PlayerId; opponentConnected: boolean; botDifficulty?: BotDifficulty | null }
  | { t: 'state'; state: WireGameState }
  /** Spectator (phase 11 §3): full, unredacted state — both sides confirmed. */
  | { t: 'spectate_start'; code: string; state: GameState }
  | { t: 'spectate_state'; state: GameState }
  | { t: 'opponent_disconnected' }
  | { t: 'opponent_reconnected' }
  | { t: 'opponent_left' }
  /**
   * Shareable replay link (phase 11 §6). The room's own GameState.replayCode
   * (set server-side once the match ends — see server/index.ts) is what a
   * live player sees; this message is the standalone answer to `get_replay`
   * for anyone loading `?replay=CODE` cold, with no room/session of their own.
   */
  | { t: 'replay_data'; code: string; mapName: string; winner: PlayerId | 'DRAW' | null; sabre: ReplayViewState; vanguard: ReplayViewState }
  | { t: 'error'; message: string };
