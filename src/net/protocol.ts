// ============================================================================
// COMMAND — Wire protocol shared between the browser client (src/net/client.ts)
// and the Node WebSocket server (server/index.ts). Pure TypeScript, no
// DOM/React/browser APIs — importable from both sides.
// ============================================================================

import { GameState, PlayerId } from '../game/types';

export type BotDifficulty = 'EASY' | 'MEDIUM' | 'HARD';

export type GameAction =
  | { type: 'MOVE'; formationId: string; x: number; y: number }
  | { type: 'ATTACK'; attackerId: string; targetId: string }
  | { type: 'RECON'; formationId: string }
  | { type: 'FORTIFY'; formationId: string }
  | { type: 'RESUPPLY'; formationId: string }
  | { type: 'ENGINEER_BRIDGE'; formationId: string; x: number; y: number }
  | { type: 'ENGINEER_CLEAR'; formationId: string; x: number; y: number }
  | { type: 'ARTILLERY'; formationId: string; x: number; y: number }
  | { type: 'AIR'; x: number; y: number }
  | { type: 'SPECIAL_OP'; formationId: string; x: number; y: number }
  | { type: 'AMPHIBIOUS'; transportId: string; cargoId: string; x: number; y: number }
  | { type: 'END_TURN' };

export type ClientMsg =
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'quick' }
  | { t: 'bot'; difficulty: BotDifficulty }
  | { t: 'reconnect'; code: string; token: string }
  | { t: 'action'; action: GameAction }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'created'; code: string; token: string; you: PlayerId }
  | { t: 'joined'; code: string; token: string; you: PlayerId }
  | { t: 'waiting' }
  | { t: 'searching' }
  | { t: 'start'; state: GameState; you: PlayerId; opponentConnected: boolean }
  | { t: 'state'; state: GameState }
  | { t: 'opponent_disconnected' }
  | { t: 'opponent_reconnected' }
  | { t: 'opponent_left' }
  | { t: 'error'; message: string };
