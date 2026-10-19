// ============================================================================
// ISLAND OPS — browser side of the online game.
//
// useIslandOnline() owns the socket: create / join a room, pick a Pasukan,
// start, then relay recon and orders up and fogged views, round reports,
// lobby updates and emotes down. It holds no rules — the server resolves
// everything. The session (room code + seat token) is kept in sessionStorage,
// so a refresh drops you straight back into your seat.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotLevel } from './bot';
import type { Emote, IoClientMsg, IoServerMsg, LobbyInfo } from './protocol';
import type { FactionId, Order, PlayerView, RoundReport } from './types';

const SESSION_KEY = 'island_ops_session_v1';

function socketUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
  if (env?.VITE_IO_URL) return String(env.VITE_IO_URL);
  if (env?.DEV) return 'ws://localhost:8787/io';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/io`;
}

interface Session {
  code: string;
  token: string;
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Without storage a refresh just loses the seat; play goes on.
  }
}

export type OnlineStatus = 'idle' | 'connecting' | 'lobby' | 'playing' | 'closed';

export interface OnlineState {
  status: OnlineStatus;
  you: FactionId | null;
  code: string | null;
  lobby: LobbyInfo | null;
  view: PlayerView | null;
  pending: { report: RoundReport; before: PlayerView } | null;
  submitted: boolean;
  notice: { id: number; text: string } | null;
  emotes: { id: number; from: FactionId; text: string }[];
}

const INITIAL: OnlineState = { status: 'idle', you: null, code: null, lobby: null, view: null, pending: null, submitted: false, notice: null, emotes: [] };

export function hasSavedSession() {
  return loadSession() !== null;
}

export function useIslandOnline() {
  const [st, setSt] = useState<OnlineState>(INITIAL);
  const ws = useRef<WebSocket | null>(null);
  const queue = useRef<IoClientMsg[]>([]);

  const onMessage = useCallback((msg: IoServerMsg) => {
    switch (msg.t) {
      case 'joined':
        saveSession({ code: msg.code, token: msg.token });
        return setSt((s) => ({ ...s, you: msg.you, code: msg.code, status: s.status === 'playing' ? 'playing' : 'lobby' }));
      case 'lobby':
        return setSt((s) => ({ ...s, lobby: msg.lobby, status: msg.lobby.phase === 'LOBBY' ? 'lobby' : 'playing' }));
      case 'view':
        return setSt((s) => ({
          ...s,
          status: 'playing',
          view: msg.view,
          submitted: msg.submitted,
          // A report means a round just resolved: play it back from what we saw before.
          pending: msg.report && s.view ? { report: msg.report, before: s.view } : s.pending,
        }));
      case 'emote': {
        const id = Math.random();
        setSt((s) => ({ ...s, emotes: [...s.emotes.slice(-3), { id, from: msg.from, text: msg.text }] }));
        window.setTimeout(() => setSt((s) => ({ ...s, emotes: s.emotes.filter((e) => e.id !== id) })), 3500);
        return;
      }
      case 'error':
        if (msg.message === 'That session has expired.') saveSession(null);
        return setSt((s) => ({ ...s, notice: { id: Math.random(), text: msg.message }, status: s.status === 'connecting' && !s.code ? 'idle' : s.status }));
    }
  }, []);

  const connect = useCallback(
    (first: IoClientMsg) => {
      const existing = ws.current;
      if (existing && existing.readyState === WebSocket.OPEN) {
        existing.send(JSON.stringify(first));
        return;
      }
      queue.current = [first];
      setSt((s) => ({ ...s, status: 'connecting' }));
      const sock = new WebSocket(socketUrl());
      ws.current = sock;
      sock.onopen = () => {
        for (const m of queue.current) sock.send(JSON.stringify(m));
        queue.current = [];
      };
      sock.onmessage = (e) => {
        try {
          onMessage(JSON.parse(e.data));
        } catch {
          // Ignore anything we can't read.
        }
      };
      sock.onclose = () => {
        if (ws.current !== sock) return;
        ws.current = null;
        setSt((s) => (s.status === 'idle' ? s : { ...s, status: 'closed', notice: { id: Math.random(), text: 'Lost the connection to the server.' } }));
      };
      sock.onerror = () => {
        setSt((s) => ({ ...s, notice: { id: Math.random(), text: "Can't reach the game server." } }));
      };
    },
    [onMessage],
  );

  const sendMsg = useCallback((m: IoClientMsg) => {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
  }, []);

  // Back into your seat after a refresh.
  useEffect(() => {
    const saved = loadSession();
    if (saved) connect({ t: 'reconnect', code: saved.code, token: saved.token });
    return () => ws.current?.close();
  }, [connect]);

  return {
    ...st,
    create: (name: string, faction: FactionId, seats: 3 | 4, level: BotLevel) => connect({ t: 'create', name, faction, seats, level }),
    join: (code: string, name: string) => connect({ t: 'join', code, name }),
    pick: (faction: FactionId) => sendMsg({ t: 'pick', faction }),
    start: () => sendMsg({ t: 'start' }),
    recon: async (region: string) => {
      sendMsg({ t: 'recon', region });
      return null;
    },
    submit: async (orders: Order[]) => {
      sendMsg({ t: 'orders', orders });
      return null;
    },
    unready: () => sendMsg({ t: 'unready' }),
    emote: (text: Emote) => sendMsg({ t: 'emote', text }),
    played: () => setSt((s) => ({ ...s, pending: null })),
    leave: () => {
      sendMsg({ t: 'leave' });
      saveSession(null);
      const sock = ws.current;
      ws.current = null;
      sock?.close();
      setSt(INITIAL);
    },
  };
}

export type IslandOnline = ReturnType<typeof useIslandOnline>;
