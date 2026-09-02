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
import { ClientMsg, GameAction, ServerMsg } from './protocol';

export const WS_URL = (import.meta as any).env?.VITE_WS_URL || 'ws://localhost:8787';

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
  const [opponentConnected, setOpponentConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          setState(msg.state);
          setYou(msg.you);
          setOpponentConnected(msg.opponentConnected);
          setStatus('in_game');
          break;
        case 'state':
          setState(msg.state);
          break;
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
    openSocket((ws) => ws.send(JSON.stringify({ t: 'create' } satisfies ClientMsg)));
  }, [openSocket]);

  const joinRoom = useCallback(
    (code: string) => {
      openSocket((ws) => ws.send(JSON.stringify({ t: 'join', code } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const quickMatch = useCallback(() => {
    openSocket((ws) => ws.send(JSON.stringify({ t: 'quick' } satisfies ClientMsg)));
  }, [openSocket]);

  const sendAction = useCallback((action: GameAction) => send({ t: 'action', action }), [send]);
  const endTurn = useCallback(() => send({ t: 'action', action: { type: 'END_TURN' } }), [send]);

  const leaveToLobby = useCallback(() => {
    send({ t: 'leave' });
    wsRef.current?.close();
    wsRef.current = null;
    sessionRef.current = null;
    saveSession(null);
    setState(null);
    setYou(null);
    setRoomCode(null);
    setOpponentConnected(false);
    setError(null);
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
    createRoom,
    joinRoom,
    quickMatch,
    sendAction,
    endTurn,
    leaveToLobby,
  };
}
