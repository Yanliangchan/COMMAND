// ============================================================================
// ISLAND OPS — online wire protocol, shared by client and server.
//
// The server holds the one true GameState per room. Clients only ever get
// their own fogged PlayerView, the round report when a round resolves, and
// the lobby: who sits where, who is ready, and the planning deadline.
// ============================================================================

import type { BotLevel } from './bot';
import type { FactionId, Order, PlayerView, RoundReport } from './types';

export const EMOTES = ['Shiok!', 'Alamak!', 'Steady lah', 'Wah lau', 'Bo jio!', 'Can or not?'] as const;
export type Emote = (typeof EMOTES)[number];

export const PLANNING_SECONDS = 90;

export type IoClientMsg =
  | { t: 'create'; name: string; faction: FactionId; seats: 3 | 4; level: BotLevel }
  | { t: 'join'; code: string; name: string }
  | { t: 'reconnect'; code: string; token: string }
  | { t: 'pick'; faction: FactionId }
  | { t: 'start' }
  | { t: 'recon'; region: string }
  | { t: 'orders'; orders: Order[] }
  | { t: 'unready' }
  | { t: 'emote'; text: Emote }
  | { t: 'leave' };

export interface SeatInfo {
  faction: FactionId;
  name: string;
  bot: boolean;
  connected: boolean;
  ready: boolean;
  host: boolean;
}

export interface LobbyInfo {
  code: string;
  phase: 'LOBBY' | 'PLAYING' | 'OVER';
  seats: SeatInfo[];
  /** How many seats the room has (3 or 4). */
  size: number;
  level: BotLevel;
  /** Epoch ms when planning closes; null outside planning. */
  deadline: number | null;
}

export type IoServerMsg =
  | { t: 'joined'; code: string; token: string; you: FactionId }
  | { t: 'lobby'; lobby: LobbyInfo }
  | { t: 'view'; view: PlayerView; report: RoundReport | null; submitted: boolean }
  | { t: 'emote'; from: FactionId; text: Emote }
  | { t: 'error'; message: string };
