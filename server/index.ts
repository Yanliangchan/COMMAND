// ============================================================================
// COMMAND — Authoritative multiplayer WebSocket server.
//
// Holds the canonical GameState per room (in-memory only, no database — a
// prototype). Validates every incoming action server-side using the shared
// pure engine in src/game/engine.ts, applies it, and broadcasts each player
// their own fog-of-war-filtered view via src/game/fog.ts. The client never
// computes combat or fog itself — it only renders what this process sends.
//
// In dev, run with `npm run server` (tsx, no build step needed) alongside
// `npm run dev` (Vite) — two processes, client points at ws://localhost:PORT.
//
// In production, `npm start` runs this same file as a SINGLE process: it
// serves the built client (vite build's dist/) over plain HTTP *and* the
// WebSocket server on the `/ws` path of that same HTTP server/port, so the
// whole app is one reachable service with no separate host/CORS/URL config.
// ============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import * as engine from '../src/game/engine';
import { filterStateForPlayer } from '../src/game/fog';
import { GameState, PlayerId, otherPlayer } from '../src/game/types';
import { ClientMsg, GameAction, ServerMsg, WireGameState } from '../src/net/protocol';
import { BotDifficulty, decideBotAction } from './bot';

const PORT = Number(process.env.PORT) || 8787;

// ---------------------------------------------------------------------------
// Static file serving (the built client) — same process, same port as WS.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '../dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.normalize(path.join(DIST_DIR, urlPath));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let isFile = false;
    try {
      const s = await fsStat(filePath);
      isFile = s.isFile();
    } catch {
      isFile = false;
    }
    // SPA fallback: any non-file GET (client-side routes, deep links) serves index.html.
    if (!isFile) filePath = path.join(DIST_DIR, 'index.html');
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found. Did you run `npm run build`?');
  }
}

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
  botSide: PlayerId | null;
  botDifficulty: BotDifficulty | null;
  botTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();

// Sockets waiting in the quick-match queue (at most one at a time for 1v1).
let quickMatchWaiting: WebSocket | null = null;

function send(ws: WebSocket | null, msg: ServerMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

/**
 * Push each seat its own fog-filtered view. The tile grid is only included
 * when the map itself changed (an engineer bridge) — otherwise it is elided
 * and the client reuses the grid it was sent at `start`, which keeps a routine
 * per-action broadcast to a few tens of KB instead of ~400 KB.
 */
function broadcastState(room: Room, includeTiles = false) {
  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((pid) => {
    const seat = room.seats[pid];
    if (!seat.ws) return;
    const full = filterStateForPlayer(room.state, pid);
    let payload: WireGameState = full;
    if (!includeTiles) {
      const { tiles, ...rest } = full;
      void tiles;
      payload = rest;
    }
    send(seat.ws, { t: 'state', state: payload });
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
    botSide: null,
    botDifficulty: null,
    botTimer: null,
  };
  rooms.set(code, room);
  return room;
}

function clearBotTimer(room: Room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

const BOT_STEP_DELAY_MIN_MS = 250;
const BOT_STEP_DELAY_MAX_MS = 550;
const BOT_MAX_STEPS_PER_TURN = 80; // safety valve against a pathological infinite loop

/** Drives the bot's turn one action at a time, with a human-watchable delay between each. */
function scheduleBotStep(room: Room, stepsTaken = 0) {
  clearBotTimer(room);
  if (!room.botSide || !room.botDifficulty) return;
  if (room.state.phase !== 'PLAYING' || room.state.activePlayer !== room.botSide) return;
  if (stepsTaken >= BOT_MAX_STEPS_PER_TURN) {
    applyAction(room, room.botSide, { type: 'END_TURN' });
    broadcastState(room);
    return;
  }
  const delay = BOT_STEP_DELAY_MIN_MS + Math.random() * (BOT_STEP_DELAY_MAX_MS - BOT_STEP_DELAY_MIN_MS);
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!rooms.has(room.code)) return; // room was deleted meanwhile
    if (room.state.phase !== 'PLAYING' || room.state.activePlayer !== room.botSide) return;
    const action = decideBotAction(room.state, room.botSide!, room.botDifficulty!);
    if (action) {
      const res = applyAction(room, room.botSide!, action);
      broadcastState(room, res.mapChanged);
      scheduleBotStep(room, stepsTaken + 1);
    } else {
      applyAction(room, room.botSide!, { type: 'END_TURN' });
      broadcastState(room);
    }
  }, delay);
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
    clearBotTimer(room);
    rooms.delete(room.code);
  }, RECONNECT_GRACE_MS);
}

interface ActionResult {
  error: string | null;
  /** True when the action can have mutated the tile grid (bridge building). */
  mapChanged: boolean;
}

function applyAction(room: Room, playerId: PlayerId, action: GameAction): ActionResult {
  const state = room.state;
  if (state.phase === 'GAME_OVER') return { error: 'Game is already over.', mapChanged: false };
  if (state.activePlayer !== playerId) return { error: 'Not your turn.', mapChanged: false };

  switch (action.type) {
    case 'MOVE':
      engine.moveFormation(state, action.formationId, action.x, action.y);
      break;
    case 'MOVE_GROUP':
      engine.moveGroup(state, action.formationIds, action.x, action.y);
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
    case 'END_TURN':
      engine.endTurn(state);
      // Skip the (now meaningless, single-tab-only) TURN_HANDOFF phase —
      // real multiplayer has no "pass the device" step.
      engine.beginPlayerTurn(state);
      break;
    default:
      return { error: 'Unknown action.', mapChanged: false };
  }
  // Backstop: spotting is passive and symmetric, so both sides re-look after
  // ANY accepted action, whatever it was. The engine actions already do this;
  // repeating it here means a future action can never forget to.
  engine.refreshAllFog(state);
  room.lastActivity = Date.now();
  return { error: null, mapChanged: action.type === 'ENGINEER_BRIDGE' };
}

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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
      case 'bot': {
        const room = createRoom();
        const humanSeat = firstOpenSeat(room)!;
        humanSeat.ws = ws;
        humanSeat.connected = true;
        const botSeat = firstOpenSeat(room)!;
        botSeat.connected = true; // no socket — the bot is always "connected"
        room.botSide = botSeat.playerId;
        room.botDifficulty = msg.difficulty;
        send(ws, { t: 'joined', code: room.code, token: humanSeat.token, you: humanSeat.playerId });
        send(ws, {
          t: 'start',
          state: filterStateForPlayer(room.state, humanSeat.playerId),
          you: humanSeat.playerId,
          opponentConnected: true,
        });
        scheduleBotStep(room); // in case the bot drew BLUEFOR and moves first
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
        const res = applyAction(room, seat.playerId, msg.action);
        if (res.error) {
          send(ws, { t: 'error', message: res.error });
          return;
        }
        broadcastState(room, res.mapChanged);
        scheduleBotStep(room);
        break;
      }
      case 'leave': {
        const found = seatBySocket(ws);
        if (found) {
          const { room, seat } = found;
          const other = room.seats[otherPlayer(seat.playerId)];
          if (other.ws) send(other.ws, { t: 'opponent_left' });
          clearBotTimer(room);
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
// A bot seat is never "connected" via a real socket, so only the human
// seat(s) count toward whether a bot room is still in use.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = room.botSide
      ? room.seats[otherPlayer(room.botSide)].connected
      : room.seats.BLUEFOR.connected || room.seats.REDFOR.connected;
    if (!anyoneConnected && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
      clearBotTimer(room);
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_INTERVAL_MS).unref();

process.on('uncaughtException', (err) => {
  console.error('[COMMAND] Uncaught exception (server kept alive):', err);
});

httpServer.listen(PORT, () => {
  console.log(`[COMMAND] listening on :${PORT} — HTTP (static: ${DIST_DIR}) + WebSocket on /ws`);
});
