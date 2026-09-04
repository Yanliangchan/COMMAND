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
import { BotDifficulty, ClientMsg, CreateRulesInput, GameAction, ReplayViewState, RoomRulesInfo, ServerMsg } from './protocol';

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
  if (env?.DEV) return 'ws://localhost:8787/ws';
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8787/ws';
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

/** A saved match replay fetched standalone via a shareable code (phase 11 §6) — see net/protocol.ts ReplayViewState.
 * One fully-revealed view (terrain included) — the match is over, so there is nothing left to redact per side. */
export interface FetchedReplay {
  code: string;
  mapName: string;
  winner: PlayerId | 'DRAW' | null;
  full: ReplayViewState;
}

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
  // Bumped on every 'error' message, including a repeat of the same text back
  // to back (e.g. clicking the same refused tile twice) — App.tsx keys its
  // in-game toast effect off this rather than the message text so a repeat
  // refusal is not silently swallowed by React's "state didn't change" bail.
  const [errorSeq, setErrorSeq] = useState(0);
  // Which kind of opponent this match is against, and — for a bot match — at
  // what difficulty. Purely presentational (the pre-battle briefing, phase
  // 10 §1) — the server is still the sole source of truth for game state.
  const [matchKind, setMatchKind] = useState<MatchKind | null>(null);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty | null>(null);
  // Phase 11 §3 — spectator mode: a third client watching an existing room,
  // read-only, always sent the full unredacted state.
  const [spectating, setSpectating] = useState(false);
  // Phase 11 §4 — the room's resolved rules, shown before the match starts
  // (the waiting screen for a host, the join screen for a joiner).
  const [roomRules, setRoomRules] = useState<RoomRulesInfo | null>(null);
  // Phase 11 §6 — a replay fetched standalone via a shareable code, and any
  // error fetching one (bad/expired code).
  const [fetchedReplay, setFetchedReplay] = useState<FetchedReplay | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

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
          setRoomRules(msg.rules);
          setStatus('waiting');
          break;
        case 'joined':
          sessionRef.current = { code: msg.code, token: msg.token };
          saveSession(sessionRef.current);
          setRoomCode(msg.code);
          setYou(msg.you);
          setRoomRules(msg.rules);
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
        case 'spectate_start':
          setSpectating(true);
          setRoomCode(msg.code);
          setYou('SABRE'); // arbitrary — a spectator has no side; colours pick SABRE's palette
          tilesRef.current = msg.state.tiles;
          setState(msg.state);
          setStatus('in_game');
          break;
        case 'spectate_state':
          setState((prev) => (prev ? { ...msg.state, tiles: prev.tiles } : msg.state));
          break;
        case 'replay_data':
          setFetchedReplay({ code: msg.code, mapName: msg.mapName, winner: msg.winner, full: msg.full });
          setReplayError(null);
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
          setErrorSeq((n) => n + 1);
          setReplayError(msg.message);
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

  const createRoom = useCallback(
    (rules?: CreateRulesInput) => {
      setMatchKind('multiplayer');
      openSocket((ws) => ws.send(JSON.stringify({ t: 'create', rules } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const joinRoom = useCallback(
    (code: string) => {
      setMatchKind('multiplayer');
      openSocket((ws) => ws.send(JSON.stringify({ t: 'join', code } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const spectate = useCallback(
    (code: string) => {
      setMatchKind('multiplayer');
      openSocket((ws) => ws.send(JSON.stringify({ t: 'spectate', code } satisfies ClientMsg)));
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

  /** Phase 11 §6 — fetch a saved replay standalone, with no room/session of its own. */
  const getReplay = useCallback(
    (code: string) => {
      setFetchedReplay(null);
      setReplayError(null);
      openSocket((ws) => ws.send(JSON.stringify({ t: 'get_replay', code } satisfies ClientMsg)));
    },
    [openSocket]
  );

  const sendAction = useCallback(
    (action: GameAction) => {
      if (spectating) return; // read-only — see App.tsx's own UI-level guard too
      send({ t: 'action', action });
    },
    [send, spectating]
  );
  const endTurn = useCallback(() => {
    if (spectating) return;
    send({ t: 'action', action: { type: 'END_TURN' } });
  }, [send, spectating]);

  const leaveToLobby = useCallback(() => {
    if (!spectating) send({ t: 'leave' });
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
    setSpectating(false);
    setRoomRules(null);
    setStatus('lobby');
  }, [send, spectating]);

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
    errorSeq,
    matchKind,
    botDifficulty,
    spectating,
    roomRules,
    fetchedReplay,
    replayError,
    createRoom,
    joinRoom,
    spectate,
    quickMatch,
    vsBot,
    getReplay,
    sendAction,
    endTurn,
    leaveToLobby,
  };
}
