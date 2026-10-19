// ============================================================================
// ISLAND OPS — authoritative online rooms.
//
// One GameState per room, held here. Every Pasukan plans at once; when all the
// humans have submitted — or the planning clock runs out, in which case a bot
// plans for whoever hasn't ("Encik takes command") — the round resolves and
// each player is sent only their own fogged view, plus the round report.
// Bots fill any seat the host leaves empty.
// ============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { alive, allReady, newGame, player, recon, resolveRound, submitOrders, validateOrders, viewFor } from '../src/island/engine';
import { BotLevel, planBot } from '../src/island/bot';
import { EMOTES, IoClientMsg, IoServerMsg, LobbyInfo, PLANNING_SECONDS } from '../src/island/protocol';
import { FACTION_IDS, FACTIONS, FactionId, GameState, Order, RoundReport } from '../src/island/types';

interface IoSeat {
  faction: FactionId;
  token: string;
  name: string;
  bot: boolean;
  host: boolean;
  ws: WebSocket | null;
  lastEmote: number;
}

interface IoRoom {
  code: string;
  size: 3 | 4;
  level: BotLevel;
  seats: IoSeat[];
  state: GameState | null;
  phase: LobbyInfo['phase'];
  deadline: number | null;
  timer: NodeJS.Timeout | null;
  lastActivity: number;
}

const rooms = new Map<string, IoRoom>();
const MAX_ROOMS = 1000;
const MAX_ORDERS = 200;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const LEVELS: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];

// No 0/O/1/I/L — visually ambiguous in a shared room code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(): string {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  } while (rooms.has(code));
  return code;
}

function send(ws: WebSocket | null, msg: IoServerMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function lobbyInfo(room: IoRoom): LobbyInfo {
  return {
    code: room.code,
    phase: room.phase,
    size: room.size,
    level: room.level,
    deadline: room.deadline,
    seats: room.seats.map((s) => ({
      faction: s.faction,
      name: s.name,
      bot: s.bot,
      host: s.host,
      connected: s.bot || (s.ws !== null && s.ws.readyState === WebSocket.OPEN),
      ready: !!room.state && !!room.state.players[s.faction] && (player(room.state, s.faction).orders !== null || !player(room.state, s.faction).alive),
    })),
  };
}

function broadcastLobby(room: IoRoom) {
  const lobby = lobbyInfo(room);
  for (const s of room.seats) send(s.ws, { t: 'lobby', lobby });
}

function sendView(room: IoRoom, seat: IoSeat, report: RoundReport | null) {
  if (!room.state || seat.bot) return;
  send(seat.ws, { t: 'view', view: viewFor(room.state, seat.faction), report, submitted: player(room.state, seat.faction).orders !== null });
}

function clearTimer(room: IoRoom) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

/** Plan and submit for a seat that isn't going to: a bot, or a human out of time. */
function planFor(room: IoRoom, f: FactionId) {
  let s = room.state!;
  const orders = planBot(
    () => viewFor(s, f),
    (r) => (s = recon(s, f, r)),
    room.level,
  );
  room.state = submitOrders(s, f, orders);
}

function openRound(room: IoRoom, report: RoundReport | null) {
  const s = room.state!;
  if (s.phase === 'GAME_OVER') {
    room.phase = 'OVER';
    room.deadline = null;
    clearTimer(room);
  } else {
    for (const seat of room.seats) if (seat.bot && player(s, seat.faction).alive) planFor(room, seat.faction);
    room.deadline = Date.now() + PLANNING_SECONDS * 1000;
    clearTimer(room);
    room.timer = setTimeout(() => onDeadline(room), PLANNING_SECONDS * 1000 + 300);
  }
  for (const seat of room.seats) sendView(room, seat, report);
  broadcastLobby(room);
}

function onDeadline(room: IoRoom) {
  if (!room.state || room.phase !== 'PLAYING') return;
  for (const f of alive(room.state)) {
    if (player(room.state, f).orders === null) {
      planFor(room, f);
      const seat = room.seats.find((s) => s.faction === f);
      send(seat?.ws ?? null, { t: 'error', message: 'Time! Encik took command and sent orders for you this round.' });
    }
  }
  resolve(room);
}

function resolve(room: IoRoom) {
  clearTimer(room);
  const { state, report } = resolveRound(room.state!);
  room.state = state;
  room.lastActivity = Date.now();
  openRound(room, report);
}

function seatOf(ws: WebSocket): { room: IoRoom; seat: IoSeat } | null {
  for (const room of rooms.values()) {
    const seat = room.seats.find((s) => s.ws === ws);
    if (seat) return { room, seat };
  }
  return null;
}

function cleanName(raw: unknown, fallback: string): string {
  const name = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 20) : '';
  return name || fallback;
}

function isFaction(f: unknown): f is FactionId {
  return typeof f === 'string' && (FACTION_IDS as string[]).includes(f);
}

function handle(ws: WebSocket, msg: IoClientMsg) {
  const here = seatOf(ws);
  switch (msg.t) {
    case 'create': {
      if (here) return send(ws, { t: 'error', message: 'You are already in a room.' });
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', message: 'The server is full right now — try again in a few minutes.' });
      const faction = isFaction(msg.faction) ? msg.faction : 'SINGA';
      const room: IoRoom = {
        code: genCode(),
        size: msg.seats === 4 ? 4 : 3,
        level: LEVELS.includes(msg.level) ? msg.level : 'REGULAR',
        seats: [],
        state: null,
        phase: 'LOBBY',
        deadline: null,
        timer: null,
        lastActivity: Date.now(),
      };
      const seat: IoSeat = { faction, token: randomUUID(), name: cleanName(msg.name, 'Commander'), bot: false, host: true, ws, lastEmote: 0 };
      room.seats.push(seat);
      rooms.set(room.code, room);
      send(ws, { t: 'joined', code: room.code, token: seat.token, you: faction });
      return broadcastLobby(room);
    }
    case 'join': {
      if (here) return send(ws, { t: 'error', message: 'You are already in a room.' });
      const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'error', message: 'No room with that code.' });
      if (room.phase !== 'LOBBY') return send(ws, { t: 'error', message: 'That exercise has already started.' });
      if (room.seats.length >= room.size) return send(ws, { t: 'error', message: 'That room is full.' });
      const faction = FACTION_IDS.find((f) => !room.seats.some((s) => s.faction === f))!;
      const seat: IoSeat = { faction, token: randomUUID(), name: cleanName(msg.name, `Commander ${room.seats.length + 1}`), bot: false, host: false, ws, lastEmote: 0 };
      room.seats.push(seat);
      room.lastActivity = Date.now();
      send(ws, { t: 'joined', code: room.code, token: seat.token, you: faction });
      return broadcastLobby(room);
    }
    case 'reconnect': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase());
      const seat = room?.seats.find((s) => !s.bot && s.token === msg.token);
      if (!room || !seat) return send(ws, { t: 'error', message: 'That session has expired.' });
      if (seat.ws && seat.ws !== ws) seat.ws.close();
      seat.ws = ws;
      room.lastActivity = Date.now();
      send(ws, { t: 'joined', code: room.code, token: seat.token, you: seat.faction });
      broadcastLobby(room);
      return sendView(room, seat, null);
    }
    case 'emote': {
      if (!here || !EMOTES.includes(msg.text)) return;
      const now = Date.now();
      if (now - here.seat.lastEmote < 1500) return;
      here.seat.lastEmote = now;
      for (const s of here.room.seats) send(s.ws, { t: 'emote', from: here.seat.faction, text: msg.text });
      return;
    }
    case 'leave': {
      if (!here) return;
      return leave(here.room, here.seat);
    }
  }

  if (!here) return send(ws, { t: 'error', message: 'Join a room first.' });
  const { room, seat } = here;
  room.lastActivity = Date.now();

  switch (msg.t) {
    case 'pick': {
      if (room.phase !== 'LOBBY') return;
      if (!isFaction(msg.faction) || room.seats.some((s) => s.faction === msg.faction)) return send(ws, { t: 'error', message: 'That Pasukan is taken.' });
      seat.faction = msg.faction;
      send(ws, { t: 'joined', code: room.code, token: seat.token, you: seat.faction });
      return broadcastLobby(room);
    }
    case 'start': {
      if (!seat.host || room.phase !== 'LOBBY') return;
      for (const f of FACTION_IDS) {
        if (room.seats.length >= room.size) break;
        if (!room.seats.some((s) => s.faction === f))
          room.seats.push({ faction: f, token: randomUUID(), name: `${FACTIONS[f].short} (bot)`, bot: true, host: false, ws: null, lastEmote: 0 });
      }
      room.state = newGame({ human: null, factions: room.seats.map((s) => s.faction) });
      room.phase = 'PLAYING';
      return openRound(room, null);
    }
    case 'recon': {
      if (!room.state || room.phase !== 'PLAYING') return;
      try {
        room.state = recon(room.state, seat.faction, String(msg.region));
        return sendView(room, seat, null);
      } catch (e) {
        return send(ws, { t: 'error', message: (e as Error).message });
      }
    }
    case 'orders': {
      if (!room.state || room.phase !== 'PLAYING') return;
      if (!Array.isArray(msg.orders) || msg.orders.length > MAX_ORDERS) return send(ws, { t: 'error', message: 'Malformed orders.' });
      let err: string | null;
      try {
        err = validateOrders(room.state, seat.faction, msg.orders as Order[]);
      } catch {
        err = 'Malformed orders.';
      }
      if (err) return send(ws, { t: 'error', message: err });
      room.state = submitOrders(room.state, seat.faction, msg.orders as Order[]);
      sendView(room, seat, null);
      broadcastLobby(room);
      if (allReady(room.state)) resolve(room);
      return;
    }
    case 'unready': {
      if (!room.state || room.phase !== 'PLAYING') return;
      const p = player(room.state, seat.faction);
      if (p.orders === null) return;
      room.state = structuredClone(room.state);
      player(room.state, seat.faction).orders = null;
      sendView(room, seat, null);
      return broadcastLobby(room);
    }
  }
}

function leave(room: IoRoom, seat: IoSeat) {
  if (room.phase === 'LOBBY') {
    room.seats = room.seats.filter((s) => s !== seat);
    if (!room.seats.length) {
      rooms.delete(room.code);
      return;
    }
    if (seat.host) room.seats[0].host = true;
  } else {
    // Mid-game the seat stays; the planning clock (and Encik) cover for it.
    seat.ws = null;
  }
  broadcastLobby(room);
}

export const islandWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

islandWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: IoClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { t: 'error', message: 'Malformed message.' });
    }
    try {
      handle(ws, msg);
    } catch (e) {
      console.error('[ISLAND] handler error:', e);
      send(ws, { t: 'error', message: 'Something went wrong on the server.' });
    }
  });
  ws.on('close', () => {
    const here = seatOf(ws);
    if (!here) return;
    if (here.room.phase === 'LOBBY') leave(here.room, here.seat);
    else {
      here.seat.ws = null;
      broadcastLobby(here.room);
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.seats.some((s) => !s.bot && s.ws && s.ws.readyState === WebSocket.OPEN);
    if (!anyone && now - room.lastActivity > EMPTY_ROOM_TTL_MS) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();
