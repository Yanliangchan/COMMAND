// ============================================================================
// COMMAND — Multiplayer WebSocket client.
//
// Owns the single connection to the authoritative server: lobby flow
// (create/join/quick-match), and once in a game, sends player actions and
// renders whatever GameState the server pushes back. This client never
// computes combat or fog itself.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { GameState, PlayerId } from '../game/types';
import { BotDifficulty, ClientMsg, GameAction, ServerMsg } from './protocol';

export type MatchKind = 'bot' | 'multiplayer';

// Resolution order:
//  1. VITE_WS_URL — explicit override, handy for local dev pointed at a
//     non-default server, or a split (non-single-process) deployment.
//  2. `import.meta.env.DEV` (Vite dev server) — the two-terminal `npm run
//     dev:all` workflow: client on :5173, server on :8787.
//  3. Otherwise (a production build, single combined process) — derive the
//     URL from the page's own origin: same host/port, matching ws:/wss:
//     protocol, `/ws` path. Zero env config required.
function resolveWsUrl(): string {
  const env = (import.meta as any).env;
  if (env?.VITE_WS_URL) return env.VITE_WS_URL;
  if (env?.DEV) return 'ws://localhost:8787';
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8787';
}

export const WS_URL = resolveWsUrl();

export type ConnStatus =
  | 'lobby' // showing the lobby screen, no active room
  | 'connecting'
  | 'waiting' // room created, waiting for the second player to join via code
  | 'searching' // quick-match queue
  | 'in_game'
  | 'opponent_disconnected' // still in_game, but the opponent dropped — grace period running
  | 'opponent_left' // grace period lapsed or opponent explicitly left; room is gone
  | 'error';

interface SessionInfo {
  code: string;
  token: string;
}

const STORAGE_KEY = 'command_session_v1';

function loadSession(): SessionInfo | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionInfo) : null;
  } catch {
    return null;
  }
}

function saveSession(info: SessionInfo | null) {
  try {
    if (info) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage unavailable (private browsing, etc.) — reconnect-on-refresh
    // just won't work; the rest of the app still functions.
  }
}

export function useMultiplayer() {
  const [status, setStatus] = useState<ConnStatus>('lobby');
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [you, setYou] = useState<PlayerId | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  // Cached tile grid — the server only resends it when the map actually changes.
  const tilesRef = useRef<GameState['tiles'] | null>(null);
  const [opponentConnected, setOpponentConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which kind of opponent this match is against, and — for a bot match — at
  // what difficulty. Purely presentational (the pre-battle briefing, phase
  // 10 §1) — the server is still the sole source of truth for game state.
  const [matchKind, setMatchKind] = useState<MatchKind | null>(null);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);

  const openSocket = useCallback((onOpen: (ws: WebSocket) => void) => {
    setStatus('connecting');
    setError(null);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.addEventListener('open', () => onOpen(ws));

    ws.addEventListener('message', (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'created':
          sessionRef.current = { code: msg.code, token: msg.token };
          saveSession(sessionRef.current);
          setRoomCode(msg.code);
          setYou(msg.you);
          setStatus('waiting');
          break;
        case 'joined':
          sessionRef.current = { code: msg.code, token: msg.token };
          saveSession(sessionRef.current);
          setRoomCode(msg.code);
          setYou(msg.you);
          break;
        case 'waiting':
          setStatus('waiting');
          break;
        case 'searching':
          setStatus('searching');
          break;
        case 'start':
          tilesRef.current = msg.state.tiles;
          setState(msg.state);
          setYou(msg.you);
          setOpponentConnected(msg.opponentConnected);
          setBotDifficulty(msg.botDifficulty ?? null);
          setStatus('in_game');
          break;
        case 'state': {
          // The server elides the (large, near-static) tile grid on routine
          // pushes — splice back in the grid we already hold.
          const tiles = msg.state.tiles ?? tilesRef.current;
          if (tiles) tilesRef.current = tiles;
          if (!tiles) return; // no map yet: ignore until a `start` arrives
          setState({ ...msg.state, tiles });
          break;
        }
        case 'opponent_disconnected':
          setOpponentConnected(false);
          setStatus('opponent_disconnected');
          break;
        case 'opponent_reconnected':
          setOpponentConnected(true);
          setStatus('in_game');
          break;
        case 'opponent_left':
          setStatus('opponent_left');
          saveSession(null);
          sessionRef.current = null;
          break;
        case 'error':
          setError(msg.message);
          // A LOBBY-phase failure (no such room code, room full, server refused
          // the queue) has to hand the player back to the menu with the reason
          // — otherwise the "connecting" card spins forever. An in-game action
          // rejection arrives on the same message and must NOT eject anyone, so
          // the status only moves for the pre-game states.
          setStatus((prev) => (prev === 'connecting' || prev === 'waiting' || prev === 'searching' ? 'error' : prev));
          break;
      }
    });

    ws.addEventListener('close', () => {
      wsRef.current = null;
    });

    ws.addEventListener('error', () => {
      setError('Connection error — is the server running?');
      setStatus('error');
    });

    return ws;
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const createRoom = useCallback(() => {
    setMatchKind('multiplayer');
    openSocket((ws) => ws.send(JSON.stringify({ t: 'create' } satisfies ClientMsg)));
  }, [openSocket]);

  const joinRoom = useCallback(
    (code: string) => {
      setMatchKind('multiplayer');
      openSocket((ws) => ws.send(JSON.stringify({ t: 'join', code } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const quickMatch = useCallback(() => {
    setMatchKind('multiplayer');
    openSocket((ws) => ws.send(JSON.stringify({ t: 'quick' } satisfies ClientMsg)));
  }, [openSocket]);

  const vsBot = useCallback(
    (difficulty: BotDifficulty) => {
      setMatchKind('bot');
      openSocket((ws) => ws.send(JSON.stringify({ t: 'bot', difficulty } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const sendAction = useCallback((action: GameAction) => send({ t: 'action', action }), [send]);
  const endTurn = useCallback(() => send({ t: 'action', action: { type: 'END_TURN' } }), [send]);

  const leaveToLobby = useCallback(() => {
    send({ t: 'leave' });
    wsRef.current?.close();
    wsRef.current = null;
    sessionRef.current = null;
    saveSession(null);
    setState(null);
    tilesRef.current = null;
    setYou(null);
    setRoomCode(null);
    setOpponentConnected(false);
    setError(null);
    setMatchKind(null);
    setBotDifficulty(null);
    setStatus('lobby');
  }, [send]);

  // On mount, attempt to resume a session left over from a page refresh mid-game.
  useEffect(() => {
    const session = loadSession();
    if (!session) return;
    sessionRef.current = session;
    setRoomCode(session.code);
    openSocket((ws) => ws.send(JSON.stringify({ t: 'reconnect', code: session.code, token: session.token } satisfies ClientMsg)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    roomCode,
    you,
    state,
    opponentConnected,
    error,
    matchKind,
    botDifficulty,
    createRoom,
    joinRoom,
    quickMatch,
    vsBot,
    sendAction,
    endTurn,
    leaveToLobby,
  };
}
