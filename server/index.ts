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
import { filterStateForPlayer, filterStateForSpectator } from '../src/game/fog';
import { randomScenario, scenarioById, Scenario } from '../src/game/scenarios';
import { GameState, MatchRules, PlayerId, otherPlayer, validateMatchRules } from '../src/game/types';
import { ClientMsg, CreateRulesInput, GameAction, ReplayViewState, RoomRulesInfo, ServerMsg, WireGameState } from '../src/net/protocol';
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
  /** Phase 11 §4 — resolved once at room creation, echoed to both players. */
  rulesInfo: RoomRulesInfo;
  /** Phase 11 §4 — resolved which side moves first, applied once the host's seat is known. */
  initiativeMode: 'RANDOM' | 'HOST' | 'GUEST';
  /** Phase 11 §3 — read-only observers. Never seated, never accepted for `action`. */
  spectators: Set<WebSocket>;
}

const rooms = new Map<string, Room>();

// ---------------------------------------------------------------------------
// SHAREABLE REPLAYS (phase 11 §6) — kept in a separate, longer-lived store so
// a finished match's replay survives the room itself expiring (see
// EMPTY_ROOM_TTL_MS below, much shorter). Deliberately in-memory only, same
// as every other piece of state this prototype server holds (see module
// header) — a process restart loses saved replays. That is a documented
// limitation, not an oversight: a real deployment would move this to a
// database the way it would for rooms, and nothing about the shape of
// SavedReplay stops that later.
// ---------------------------------------------------------------------------
interface SavedReplay {
  code: string;
  mapName: string;
  winner: PlayerId | 'DRAW' | null;
  sabre: ReplayViewState;
  vanguard: ReplayViewState;
  savedAt: number;
}
const savedReplays = new Map<string, SavedReplay>();
const REPLAY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REPLAY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — well past any room's own TTL
const REPLAY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function genReplayCode(): string {
  let code = '';
  for (let i = 0; i < 7; i++) code += REPLAY_CODE_ALPHABET[randomBytes(1)[0] % REPLAY_CODE_ALPHABET.length];
  return code;
}

function stripTiles(state: GameState): ReplayViewState {
  const { tiles, ...rest } = state;
  void tiles;
  return rest;
}

/** Called once, when a room's GameState first reaches GAME_OVER. */
function saveReplay(room: Room) {
  if (room.state.phase !== 'GAME_OVER' || room.state.replayCode) return;
  let code = genReplayCode();
  while (savedReplays.has(code)) code = genReplayCode();
  savedReplays.set(code, {
    code,
    mapName: room.state.mapName,
    winner: room.state.winner,
    sabre: stripTiles(filterStateForPlayer(room.state, 'SABRE')),
    vanguard: stripTiles(filterStateForPlayer(room.state, 'VANGUARD')),
    savedAt: Date.now(),
  });
  room.state.replayCode = code;
}

// ---------------------------------------------------------------------------
// MATCH RULES resolution (phase 11 §4) — Create Room only. Quick Match and
// vs-Bot never pass a `rules` input at all, so they always take this exact
// default path: random scenario from the curated pool, default AP/VP/round
// numbers, random initiative — unchanged from before this phase.
// ---------------------------------------------------------------------------
function resolveCreateRules(
  input: CreateRulesInput | undefined
): { ok: true; rules: MatchRules; scenario: Scenario; initiative: 'RANDOM' | 'HOST' | 'GUEST' } | { ok: false; reason: string } {
  const v = validateMatchRules({ apPerTurn: input?.apPerTurn, vpToWin: input?.vpToWin, roundLimit: input?.roundLimit });
  if (!v.ok) return v;

  let scenario: Scenario;
  const mapChoice = input?.mapChoice ?? 'RANDOM';
  if (mapChoice === 'RANDOM') {
    scenario = randomScenario();
  } else {
    const found = scenarioById(mapChoice);
    if (!found) return { ok: false, reason: `Unknown scenario "${mapChoice}".` };
    scenario = found;
  }

  const initiative = input?.initiative ?? 'RANDOM';
  if (initiative !== 'RANDOM' && initiative !== 'HOST' && initiative !== 'GUEST') {
    return { ok: false, reason: `Invalid initiative setting "${initiative}".` };
  }

  return { ok: true, rules: v.rules, scenario, initiative };
}

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
  (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((pid) => {
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
  // Spectators (phase 11 §3) get the full, unredacted state every push —
  // there is no per-viewer secret to withhold from a non-combatant, and
  // (unlike the two player seats) there is no cached tile grid to elide
  // against since a spectator can join mid-match at any time.
  if (room.spectators.size) {
    const spec = filterStateForSpectator(room.state);
    room.spectators.forEach((ws) => send(ws, { t: 'spectate_state', state: spec }));
  }
}

function makeSeats(): Room['seats'] {
  // Randomize which joiner gets which side.
  const sides: PlayerId[] = Math.random() < 0.5 ? ['SABRE', 'VANGUARD'] : ['VANGUARD', 'SABRE'];
  return {
    [sides[0]]: { playerId: sides[0], token: randomUUID(), ws: null, connected: false, disconnectTimer: null },
    [sides[1]]: { playerId: sides[1], token: randomUUID(), ws: null, connected: false, disconnectTimer: null },
  } as Room['seats'];
}

function createRoom(resolved?: { rules: MatchRules; scenario: Scenario; initiative: 'RANDOM' | 'HOST' | 'GUEST' }): Room {
  let code = genRoomCode();
  while (rooms.has(code)) code = genRoomCode();
  const rules = resolved?.rules;
  const scenario = resolved?.scenario ?? randomScenario();
  const state = engine.initGame(scenario.seed, { rules, mapName: scenario.name });
  const room: Room = {
    code,
    state,
    seats: makeSeats(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    botSide: null,
    botDifficulty: null,
    rulesInfo: {
      apPerTurn: state.rules.apPerTurn,
      vpToWin: state.rules.vpToWin,
      roundLimit: state.rules.roundLimit,
      mapName: scenario.name,
      initiative: resolved?.initiative ?? 'RANDOM',
    },
    initiativeMode: resolved?.initiative ?? 'RANDOM',
    spectators: new Set(),
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
  const a = room.seats.SABRE;
  const b = room.seats.VANGUARD;
  if (!a.ws && !a.connected) return a;
  if (!b.ws && !b.connected) return b;
  return null;
}

function bothConnected(room: Room) {
  return room.seats.SABRE.connected && room.seats.VANGUARD.connected;
}

function clearDisconnectTimer(seat: Seat) {
  if (seat.disconnectTimer) {
    clearTimeout(seat.disconnectTimer);
    seat.disconnectTimer = null;
  }
}

function seatBySocket(ws: WebSocket): { room: Room; seat: Seat } | null {
  for (const room of rooms.values()) {
    for (const pid of ['SABRE', 'VANGUARD'] as PlayerId[]) {
      if (room.seats[pid].ws === ws) return { room, seat: room.seats[pid] };
    }
  }
  return null;
}

function spectatorRoom(ws: WebSocket): Room | null {
  for (const room of rooms.values()) {
    if (room.spectators.has(ws)) return room;
  }
  return null;
}

/** Politely disconnect any spectators when their room goes away entirely. */
function closeRoomSpectators(room: Room) {
  room.spectators.forEach((ws) => {
    send(ws, { t: 'error', message: 'The match ended and this room is now closed.' });
    ws.close();
  });
  room.spectators.clear();
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
    closeRoomSpectators(room);
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
    case 'REORGANIZE':
      engine.reorganizeAction(state, action.formationId);
      break;
    case 'VERTICAL_INSERT':
      engine.verticalInsertAction(state, action.formationId, action.x, action.y);
      break;
    case 'UAV_RECON':
      engine.uavReconAction(state, action.x, action.y);
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
  // Shareable replay (phase 11 §6): the moment a match reaches GAME_OVER,
  // save it under a short code that outlives the room itself.
  if ((state.phase as GameState['phase']) === 'GAME_OVER') saveReplay(room);
  return { error: null, mapChanged: action.type === 'ENGINEER_BRIDGE' };
}

const httpServer = createServer((req, res) => {
  void serveStatic(req, res);
});
// Caps guard against a single client exhausting server memory: an oversized
// message (maxPayload) or an unbounded flood of rooms (MAX_ROOMS, checked
// before every room-creating message below).
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });
const MAX_ROOMS = 2000;

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
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { t: 'error', message: 'Server is at capacity — please try again shortly.' });
          return;
        }
        const resolved = resolveCreateRules(msg.rules);
        if (!resolved.ok) {
          send(ws, { t: 'error', message: resolved.reason });
          return;
        }
        const room = createRoom(resolved);
        const seat = firstOpenSeat(room)!;
        seat.ws = ws;
        seat.connected = true;
        // Initiative HOST/GUEST can only be applied once we know which seat
        // the creator (the "host") actually drew — makeSeats() assigns
        // SABRE/VANGUARD before this point, so this is the earliest moment
        // it is resolvable.
        if (room.initiativeMode !== 'RANDOM') {
          const first = room.initiativeMode === 'HOST' ? seat.playerId : otherPlayer(seat.playerId);
          room.state.activePlayer = first;
          room.state.initiative = first;
        }
        send(ws, { t: 'created', code: room.code, token: seat.token, you: seat.playerId, rules: room.rulesInfo });
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
        send(ws, { t: 'joined', code: room.code, token: seat.token, you: seat.playerId, rules: room.rulesInfo });
        if (bothConnected(room)) {
          (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((pid) => {
            const s = room.seats[pid];
            send(s.ws, { t: 'start', state: filterStateForPlayer(room.state, pid), you: pid, opponentConnected: true, botDifficulty: room.botDifficulty });
          });
        }
        break;
      }
      case 'spectate': {
        const room = rooms.get(msg.code.toUpperCase().trim());
        if (!room) {
          send(ws, { t: 'error', message: 'No room with that code.' });
          return;
        }
        if (room.state.phase === 'GAME_OVER') {
          send(ws, { t: 'error', message: 'That match has already finished. Ask for its replay link instead.' });
          return;
        }
        if (!bothConnected(room) && !room.botSide) {
          send(ws, { t: 'error', message: 'That match has not started yet.' });
          return;
        }
        room.spectators.add(ws);
        send(ws, { t: 'spectate_start', code: room.code, state: filterStateForSpectator(room.state) });
        break;
      }
      case 'bot': {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { t: 'error', message: 'Server is at capacity — please try again shortly.' });
          return;
        }
        const room = createRoom();
        const humanSeat = firstOpenSeat(room)!;
        humanSeat.ws = ws;
        humanSeat.connected = true;
        const botSeat = firstOpenSeat(room)!;
        botSeat.connected = true; // no socket — the bot is always "connected"
        room.botSide = botSeat.playerId;
        room.botDifficulty = msg.difficulty;
        send(ws, { t: 'joined', code: room.code, token: humanSeat.token, you: humanSeat.playerId, rules: room.rulesInfo });
        send(ws, {
          t: 'start',
          state: filterStateForPlayer(room.state, humanSeat.playerId),
          you: humanSeat.playerId,
          opponentConnected: true,
          botDifficulty: room.botDifficulty,
        });
        scheduleBotStep(room); // in case the bot drew SABRE and moves first
        break;
      }
      case 'quick': {
        if (quickMatchWaiting && quickMatchWaiting.readyState === WebSocket.OPEN && quickMatchWaiting !== ws) {
          if (rooms.size >= MAX_ROOMS) {
            send(ws, { t: 'error', message: 'Server is at capacity — please try again shortly.' });
            return;
          }
          const waitingWs = quickMatchWaiting;
          quickMatchWaiting = null;
          const room = createRoom();
          const seatA = firstOpenSeat(room)!;
          seatA.ws = waitingWs;
          seatA.connected = true;
          const seatB = firstOpenSeat(room)!;
          seatB.ws = ws;
          seatB.connected = true;
          send(waitingWs, { t: 'joined', code: room.code, token: seatA.token, you: seatA.playerId, rules: room.rulesInfo });
          send(ws, { t: 'joined', code: room.code, token: seatB.token, you: seatB.playerId, rules: room.rulesInfo });
          (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((pid) => {
            const s = room.seats[pid];
            send(s.ws, { t: 'start', state: filterStateForPlayer(room.state, pid), you: pid, opponentConnected: true, botDifficulty: room.botDifficulty });
          });
        } else {
          quickMatchWaiting = ws;
          send(ws, { t: 'searching' });
        }
        break;
      }
      case 'get_replay': {
        const saved = savedReplays.get(msg.code.toUpperCase().trim());
        if (!saved) {
          send(ws, { t: 'error', message: 'No replay found for that code — it may have expired or never existed.' });
          return;
        }
        send(ws, { t: 'replay_data', code: saved.code, mapName: saved.mapName, winner: saved.winner, sabre: saved.sabre, vanguard: saved.vanguard });
        break;
      }
      case 'reconnect': {
        const room = rooms.get(msg.code.toUpperCase().trim());
        if (!room) {
          send(ws, { t: 'error', message: 'Room no longer exists.' });
          return;
        }
        const seat = (['SABRE', 'VANGUARD'] as PlayerId[]).map((pid) => room.seats[pid]).find((s) => s.token === msg.token);
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
          botDifficulty: room.botDifficulty,
        });
        break;
      }
      case 'action': {
        if (spectatorRoom(ws)) {
          send(ws, { t: 'error', message: 'Spectators cannot issue actions.' });
          return;
        }
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
          closeRoomSpectators(room);
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
    const specRoom = spectatorRoom(ws);
    if (specRoom) specRoom.spectators.delete(ws);
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
      : room.seats.SABRE.connected || room.seats.VANGUARD.connected;
    if (!anyoneConnected && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
      clearBotTimer(room);
      closeRoomSpectators(room);
      rooms.delete(code);
    }
  }
}, ROOM_SWEEP_INTERVAL_MS).unref();

// Saved-replay sweep (phase 11 §6) — much longer retention than a live room,
// and on its own timer/interval so the two lifetimes never get conflated.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of savedReplays) {
    if (now - r.savedAt > REPLAY_RETENTION_MS) savedReplays.delete(code);
  }
}, REPLAY_SWEEP_INTERVAL_MS).unref();

process.on('uncaughtException', (err) => {
  console.error('[COMMAND] Uncaught exception (server kept alive):', err);
});

httpServer.listen(PORT, () => {
  console.log(`[COMMAND] listening on :${PORT} — HTTP (static: ${DIST_DIR}) + WebSocket on /ws`);
});
