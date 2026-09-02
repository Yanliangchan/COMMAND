// ============================================================================
// COMMAND — Authoritative multiplayer WebSocket server.
//
// Holds the canonical GameState per room (in-memory only, no database — a
// prototype). Validates every incoming action server-side using the shared
// pure engine in src/game/engine.ts, applies it, and broadcasts each player
// their own fog-of-war-filtered view via src/game/fog.ts. The client never
// computes combat or fog itself — it only renders what this process sends.
//
// Run with `npm run server` (tsx, dev-only — no build step needed).
// ============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import * as engine from '../src/game/engine';
import { filterStateForPlayer } from '../src/game/fog';
import { GameState, PlayerId, otherPlayer } from '../src/game/types';
import { ClientMsg, GameAction, ServerMsg } from '../src/net/protocol';

const PORT = Number(process.env.PORT) || 8787;

// No 0/O/1/I/L — visually ambiguous in a shared room code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRoomCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  return code;
}

const RECONNECT_GRACE_MS = 2 * 60 * 1000; // 2 minutes
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000; // rooms with nobody connected expire after this
const ROOM_SWEEP_INTERVAL_MS = 60 * 1000;

interface Seat {
  playerId: PlayerId;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  disconnectTimer: NodeJS.Timeout | null;
}

interface Room {
  code: string;
  state: GameState;
  seats: Record<PlayerId, Seat>;
  createdAt: number;
  lastActivity: number;
}

const rooms = new Map<string, Room>();

// Sockets waiting in the quick-match queue (at most one at a time for 1v1).
let quickMatchWaiting: WebSocket | null = null;

function send(ws: WebSocket | null, msg: ServerMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastState(room: Room) {
  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((pid) => {
    const seat = room.seats[pid];
    if (seat.ws) send(seat.ws, { t: 'state', state: filterStateForPlayer(room.state, pid) });
  });
}

function makeSeats(): Room['seats'] {
  // Randomize which joiner gets which side.
  const sides: PlayerId[] = Math.random() < 0.5 ? ['BLUEFOR', 'REDFOR'] : ['REDFOR', 'BLUEFOR'];
  return {
    [sides[0]]: { playerId: sides[0], token: randomUUID(), ws: null, connected: false, disconnectTimer: null },
    [sides[1]]: { playerId: sides[1], token: randomUUID(), ws: null, connected: false, disconnectTimer: null },
  } as Room['seats'];
}

function createRoom(): Room {
  let code = genRoomCode();
  while (rooms.has(code)) code = genRoomCode();
  const room: Room = {
    code,
    state: engine.initGame(Date.now() ^ Math.floor(Math.random() * 1e9)),
    seats: makeSeats(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function firstOpenSeat(room: Room): Seat | null {
  const a = room.seats.BLUEFOR;
  const b = room.seats.REDFOR;
  if (!a.ws && !a.connected) return a;
  if (!b.ws && !b.connected) return b;
  return null;
}

function bothConnected(room: Room) {
  return room.seats.BLUEFOR.connected && room.seats.REDFOR.connected;
}

function clearDisconnectTimer(seat: Seat) {
  if (seat.disconnectTimer) {
    clearTimeout(seat.disconnectTimer);
    seat.disconnectTimer = null;
  }
}

function seatBySocket(ws: WebSocket): { room: Room; seat: Seat } | null {
  for (const room of rooms.values()) {
    for (const pid of ['BLUEFOR', 'REDFOR'] as PlayerId[]) {
      if (room.seats[pid].ws === ws) return { room, seat: room.seats[pid] };
    }
  }
  return null;
}

function handleDisconnect(room: Room, seat: Seat) {
  seat.connected = false;
  seat.ws = null;
  const other = room.seats[otherPlayer(seat.playerId)];
  if (other.ws && room.state.phase !== 'GAME_OVER') {
    send(other.ws, { t: 'opponent_disconnected' });
  }
  clearDisconnectTimer(seat);
  seat.disconnectTimer = setTimeout(() => {
    // Grace period lapsed without a reconnect — end the game for whoever remains.
    const stillOther = room.seats[otherPlayer(seat.playerId)];
    if (stillOther.ws) send(stillOther.ws, { t: 'opponent_left' });
    rooms.delete(room.code);
  }, RECONNECT_GRACE_MS);
}

function applyAction(room: Room, playerId: PlayerId, action: GameAction): string | null {
  const state = room.state;
  if (state.phase === 'GAME_OVER') return 'Game is already over.';
  if (state.activePlayer !== playerId) return 'Not your turn.';

  switch (action.type) {
    case 'MOVE':
      engine.moveFormation(state, action.formationId, action.x, action.y);
      break;
    case 'ATTACK':
      engine.attackAction(state, action.attackerId, action.targetId);
      break;
    case 'RECON':
      engine.reconAction(state, action.formationId);
      break;
    case 'FORTIFY':
      engine.fortifyAction(state, action.formationId);
      break;
    case 'RESUPPLY':
      engine.resupplyAction(state, action.formationId);
      break;
    case 'ENGINEER_BRIDGE':
      engine.engineerBridgeAction(state, action.formationId, action.x, action.y);
      break;
    case 'ENGINEER_CLEAR':
      engine.engineerClearAction(state, action.formationId, action.x, action.y);
      break;
    case 'ARTILLERY':
      engine.artilleryAction(state, action.formationId, action.x, action.y);
      break;
    case 'AIR':
      engine.airStrikeAction(state, action.x, action.y);
      break;
    case 'SPECIAL_OP':
      engine.specialOpAction(state, action.formationId, action.x, action.y);
      break;
    case 'AMPHIBIOUS':
      engine.amphibiousAction(state, action.transportId, action.cargoId, action.x, action.y);
      break;
    case 'END_TURN':
      engine.endTurn(state);
      // Skip the (now meaningless, single-tab-only) TURN_HANDOFF phase —
      // real multiplayer has no "pass the device" step.
      engine.beginPlayerTurn(state);
      break;
    default:
      return 'Unknown action.';
  }
  room.lastActivity = Date.now();
  return null;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[COMMAND] WebSocket server listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: 'Malformed message.' });
      return;
    }

    switch (msg.t) {
      case 'create': {
        const room = createRoom();
        const seat = firstOpenSeat(room)!;
        seat.ws = ws;
        seat.connected = true;
        send(ws, { t: 'created', code: room.code, token: seat.token, you: seat.playerId });
        send(ws, { t: 'waiting' });
        break;
      }
      case 'join': {
        const room = rooms.get(msg.code.toUpperCase().trim());
        if (!room) {
          send(ws, { t: 'error', message: 'No room with that code.' });
          return;
        }
        const seat = firstOpenSeat(room);
        if (!seat) {
          send(ws, { t: 'error', message: 'That room is full.' });
          return;
        }
        seat.ws = ws;
        seat.connected = true;
        send(ws, { t: 'joined', code: room.code, token: seat.token, you: seat.playerId });
        if (bothConnected(room)) {
          (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((pid) => {
            const s = room.seats[pid];
            send(s.ws, { t: 'start', state: filterStateForPlayer(room.state, pid), you: pid, opponentConnected: true });
          });
        }
        break;
      }
      case 'quick': {
        if (quickMatchWaiting && quickMatchWaiting.readyState === WebSocket.OPEN && quickMatchWaiting !== ws) {
          const waitingWs = quickMatchWaiting;
          quickMatchWaiting = null;
          const room = createRoom();
          const seatA = firstOpenSeat(room)!;
          seatA.ws = waitingWs;
          seatA.connected = true;
          const seatB = firstOpenSeat(room)!;
          seatB.ws = ws;
          seatB.connected = true;
          send(waitingWs, { t: 'joined', code: room.code, token: seatA.token, you: seatA.playerId });
          send(ws, { t: 'joined', code: room.code, token: seatB.token, you: seatB.playerId });
          (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((pid) => {
            const s = room.seats[pid];
            send(s.ws, { t: 'start', state: filterStateForPlayer(room.state, pid), you: pid, opponentConnected: true });
          });
        } else {
          quickMatchWaiting = ws;
          send(ws, { t: 'searching' });
        }
        break;
      }
      case 'reconnect': {
        const room = rooms.get(msg.code.toUpperCase().trim());
        if (!room) {
          send(ws, { t: 'error', message: 'Room no longer exists.' });
          return;
        }
        const seat = (['BLUEFOR', 'REDFOR'] as PlayerId[]).map((pid) => room.seats[pid]).find((s) => s.token === msg.token);
        if (!seat) {
          send(ws, { t: 'error', message: 'Invalid reconnect token.' });
          return;
        }
        clearDisconnectTimer(seat);
        seat.ws = ws;
        seat.connected = true;
        const other = room.seats[otherPlayer(seat.playerId)];
        if (other.ws) send(other.ws, { t: 'opponent_reconnected' });
        send(ws, {
          t: 'start',
          state: filterStateForPlayer(room.state, seat.playerId),
          you: seat.playerId,
          opponentConnected: other.connected,
        });
        break;
      }
      case 'action': {
        const found = seatBySocket(ws);
        if (!found) {
          send(ws, { t: 'error', message: 'You are not seated in a room.' });
          return;
        }
        const { room, seat } = found;
        const err = applyAction(room, seat.playerId, msg.action);
        if (err) {
          send(ws, { t: 'error', message: err });
          return;
        }
        broadcastState(room);
        break;
      }
      case 'leave': {
        const found = seatBySocket(ws);
        if (found) {
          const { room, seat } = found;
          const other = room.seats[otherPlayer(seat.playerId)];
          if (other.ws) send(other.ws, { t: 'opponent_left' });
          rooms.delete(room.code);
        }
        break;
      }
      default:
        send(ws, { t: 'error', message: 'Unknown message type.' });
    }
  });

  ws.on('close', () => {
    if (quickMatchWaiting === ws) quickMatchWaiting = null;
    const found = seatBySocket(ws);
    if (found) handleDisconnect(found.room, found.seat);
  });

  ws.on('error', () => {
    // Swallow — 'close' still fires and handles cleanup. Never let a single
    // socket error crash the process.
  });
});

// Periodic sweep: drop rooms nobody has touched or reconnected to in a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = room.seats.BLUEFOR.connected || room.seats.REDFOR.connected;
    if (!anyoneConnected && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_INTERVAL_MS).unref();

process.on('uncaughtException', (err) => {
  console.error('[COMMAND] Uncaught exception (server kept alive):', err);
});
