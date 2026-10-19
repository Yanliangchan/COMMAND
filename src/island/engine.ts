// ============================================================================
// ISLAND OPS — rules engine.
//
// Pure functions over GameState. `apply` never mutates its input: it clones,
// applies one action and returns the new state, throwing on an illegal
// action. All randomness comes from the seeded RNG carried in the state, so a
// game is fully reproducible from its seed and action list.
// ============================================================================

import { BOARD, REGION_IDS, SECTOR_IDS, SECTORS, SectorId, distance, regionsInSector } from './map';
import {
  Action, AMPHIBIOUS_MAX_DICE, AMPHIBIOUS_REACH, ARMY_BONUS, ASSETS, AttackMode, Card, CARD_REGION_BONUS, CardKind, DIS_TRADE_BONUS, DiceRoll,
  FACTIONS, FactionId, GameEvent, GameState, MAX_HAND, MAX_ROUNDS, MIN_REINFORCEMENT, Mission, Player, REGION_GOAL,
  START_TROOPS, STRIKE_DAMAGE, tradeValue,
} from './types';

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

function nextRandom(state: GameState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const die = (s: GameState) => 1 + Math.floor(nextRandom(s) * 6);

function shuffle<T>(s: GameState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const MISSION_SECTOR_PAIRS: [SectorId, SectorId][] = [
  ['WEST', 'NORTH'], ['NORTHEAST', 'EAST'], ['CENTRAL', 'WEST'], ['SOUTH', 'EAST'], ['NORTH', 'NORTHEAST'], ['SOUTH', 'WEST'],
];

function sectorMission(pair: [SectorId, SectorId]): Mission {
  return {
    kind: 'SECTORS',
    sectors: pair,
    text: `Secure the ${SECTORS[pair[0]].name} and the ${SECTORS[pair[1]].name}.`,
  };
}

function regionMission(): Mission {
  return { kind: 'REGIONS', regions: REGION_GOAL, text: `Hold ${REGION_GOAL} regions at once.` };
}

function buildDeck(s: GameState): Card[] {
  const kinds: Exclude<CardKind, 'WILD'>[] = ['LAND', 'SEA', 'AIR'];
  const cards: Card[] = REGION_IDS.map((region, i) => {
    const kind = kinds[i % 3];
    const pool = ASSETS[kind];
    return { id: i, kind, asset: pool[Math.floor(nextRandom(s) * pool.length)], region };
  });
  cards.push({ id: 100, kind: 'WILD', asset: 'Total Defence', region: null });
  cards.push({ id: 101, kind: 'WILD', asset: 'Total Defence', region: null });
  return shuffle(s, cards);
}

export interface NewGameOptions {
  human: FactionId | null;
  factions: FactionId[];
  seed?: number;
}

export function newGame(opts: NewGameOptions): GameState {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const s: GameState = {
    seed,
    rng: seed,
    round: 1,
    turnIndex: 0,
    order: [],
    players: { ARMY: undefined, NAVY: undefined, AIRFORCE: undefined, COMMANDO: undefined, DIS: undefined },
    map: {},
    phase: 'MOBILISE',
    reserve: 0,
    pendingMove: null,
    deck: [],
    discard: [],
    tradesDone: 0,
    tick: 0,
    events: [],
    log: [],
    winner: null,
    winReason: null,
    stats: { attacks: 0, captures: 0, turns: 0 },
  };

  const factions = [...opts.factions];
  s.order = shuffle(s, factions);

  // Ops Orders: distinct, and no one is ordered to eliminate themselves.
  const sectorPairs = shuffle(s, [...MISSION_SECTOR_PAIRS]);
  for (const f of s.order) {
    const roll = nextRandom(s);
    let mission: Mission;
    if (roll < 0.45) mission = sectorMission(sectorPairs.pop()!);
    else if (roll < 0.75) {
      const others = s.order.filter((o) => o !== f);
      const target = others[Math.floor(nextRandom(s) * others.length)];
      mission = { kind: 'ELIMINATE', target, text: `Eliminate the ${FACTIONS[target].name}.` };
    } else mission = regionMission();
    s.players[f] = { id: f, human: f === opts.human, alive: true, cards: [], mission, conquered: false, powerUsed: false };
  }

  // Deal regions round-robin, one troop each, then scatter the rest of each
  // force across its own ground.
  const deal = shuffle(s, [...REGION_IDS]);
  deal.forEach((r, i) => (s.map[r] = { owner: s.order[i % s.order.length], troops: 1 }));
  const startTroops = START_TROOPS[s.order.length] ?? 20;
  for (const f of s.order) {
    const mine = REGION_IDS.filter((r) => s.map[r].owner === f);
    let left = startTroops - mine.length;
    while (left-- > 0) s.map[mine[Math.floor(nextRandom(s) * mine.length)]].troops++;
  }

  s.deck = buildDeck(s);
  log(s, null, `Exercise begins. Turn order: ${s.order.map((f) => FACTIONS[f].name).join(' → ')}.`);
  beginTurn(s);
  return s;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const current = (s: GameState): FactionId => s.order[s.turnIndex];
export const player = (s: GameState, f: FactionId): Player => s.players[f]!;

export function regionsOf(s: GameState, f: FactionId): string[] {
  return REGION_IDS.filter((r) => s.map[r].owner === f);
}

export function troopsOf(s: GameState, f: FactionId): number {
  return REGION_IDS.reduce((n, r) => n + (s.map[r].owner === f ? s.map[r].troops : 0), 0);
}

export function ownsSector(s: GameState, f: FactionId, sector: SectorId): boolean {
  return regionsInSector(sector).every((r) => s.map[r].owner === f);
}

export interface Reinforcement {
  base: number;
  sectors: { sector: SectorId; bonus: number }[];
  faction: number;
  total: number;
}

export function reinforcement(s: GameState, f: FactionId): Reinforcement {
  const base = Math.max(MIN_REINFORCEMENT, Math.floor(regionsOf(s, f).length / 3));
  const sectors = SECTOR_IDS.filter((sec) => ownsSector(s, f, sec)).map((sector) => ({ sector, bonus: SECTORS[sector].bonus }));
  const faction = f === 'ARMY' ? ARMY_BONUS : 0;
  return { base, sectors, faction, total: base + faction + sectors.reduce((n, x) => n + x.bonus, 0) };
}

export interface AttackOption {
  to: string;
  mode: AttackMode;
}

/** Every region `from` may attack right now, and how. */
export function attackOptions(s: GameState, from: string): AttackOption[] {
  const me = current(s);
  const h = s.map[from];
  if (s.phase !== 'ASSAULT' || s.pendingMove || s.reserve > 0 || h.owner !== me || h.troops < 2) return [];
  const out = new Map<string, AttackMode>();
  for (const n of BOARD.byId[from].neighbours) if (s.map[n].owner !== me) out.set(n, 'LAND');
  if (me === 'NAVY' && BOARD.byId[from].coastal) {
    for (const r of BOARD.regions) {
      if (r.coastal && s.map[r.id].owner !== me && !out.has(r.id) && distance(from, r.id) <= AMPHIBIOUS_REACH) out.set(r.id, 'AMPHIBIOUS');
    }
  }
  if (me === 'COMMANDO' && !player(s, me).powerUsed && h.troops >= 3) {
    for (const n of BOARD.byId[from].neighbours) {
      for (const m of BOARD.byId[n].neighbours) {
        if (m !== from && s.map[m].owner !== me && !out.has(m)) out.set(m, 'INSERTION');
      }
    }
  }
  return [...out].map(([to, mode]) => ({ to, mode }));
}

export function canStrike(s: GameState): boolean {
  const me = current(s);
  return me === 'AIRFORCE' && s.phase === 'ASSAULT' && !s.pendingMove && s.reserve === 0 && !player(s, me).powerUsed;
}

/** Owned regions reachable from `from` through owned ground — redeploy destinations. */
export function connectedOwned(s: GameState, from: string): string[] {
  const me = s.map[from].owner;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const c = queue.pop()!;
    for (const n of BOARD.byId[c].neighbours) {
      if (!seen.has(n) && s.map[n].owner === me) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  seen.delete(from);
  return [...seen];
}

export function isValidSet(cards: Card[]): boolean {
  if (cards.length !== 3) return false;
  const kinds = cards.map((c) => c.kind).filter((k) => k !== 'WILD');
  const distinct = new Set(kinds).size;
  return distinct <= 1 || distinct === kinds.length;
}

/** The best tradeable set in a hand — prefers sets that don't burn a wild card. */
export function findSet(cards: Card[]): Card[] | null {
  let best: Card[] | null = null;
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      for (let k = j + 1; k < cards.length; k++) {
        const set = [cards[i], cards[j], cards[k]];
        if (!isValidSet(set)) continue;
        const wilds = set.filter((c) => c.kind === 'WILD').length;
        if (!best || wilds < best.filter((c) => c.kind === 'WILD').length) best = set;
      }
  return best;
}

export function missionProgress(s: GameState, f: FactionId): { done: boolean; text: string } {
  const m = player(s, f).mission;
  if (m.kind === 'SECTORS') {
    const held = m.sectors!.filter((sec) => ownsSector(s, f, sec)).length;
    return { done: held === m.sectors!.length, text: `${held}/${m.sectors!.length} sectors` };
  }
  if (m.kind === 'REGIONS') {
    const n = regionsOf(s, f).length;
    return { done: n >= m.regions!, text: `${n}/${m.regions} regions` };
  }
  const target = player(s, m.target!);
  return { done: !target.alive && target.eliminatedBy === f, text: target.alive ? `${regionsOf(s, m.target!).length} regions left` : 'eliminated' };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function log(s: GameState, who: FactionId | null, text: string) {
  s.log.push({ round: s.round, who, text });
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
}

function emit(s: GameState, event: GameEvent) {
  s.events.push({ tick: s.tick, event });
  if (s.events.length > 60) s.events.splice(0, s.events.length - 60);
}

function drawCard(s: GameState): Card | null {
  if (!s.deck.length) {
    s.deck = shuffle(s, s.discard);
    s.discard = [];
  }
  return s.deck.pop() ?? null;
}

function beginTurn(s: GameState) {
  const me = current(s);
  const p = player(s, me);
  p.conquered = false;
  p.powerUsed = false;
  s.phase = 'MOBILISE';
  s.pendingMove = null;
  const rf = reinforcement(s, me);
  s.reserve = rf.total;
  const extras = [...rf.sectors.map((x) => `${SECTORS[x.sector].name} +${x.bonus}`), ...(rf.faction ? [`NS Call-Up +${rf.faction}`] : [])];
  log(s, me, `${FACTIONS[me].name} mobilises ${rf.total} troops${extras.length ? ` (${extras.join(', ')})` : ''}.`);
  emit(s, { kind: 'TURN', who: me, round: s.round });
}

function declareWinner(s: GameState, who: FactionId, reason: string) {
  if (s.winner) return;
  s.winner = who;
  s.winReason = reason;
  s.phase = 'GAME_OVER';
  log(s, who, `${FACTIONS[who].name} wins — ${reason}`);
  emit(s, { kind: 'VICTORY', who, reason });
}

function checkVictory(s: GameState) {
  const alive = s.order.filter((f) => player(s, f).alive);
  if (alive.length === 1) return declareWinner(s, alive[0], 'last force standing on the island.');
  const me = current(s);
  if (missionProgress(s, me).done) declareWinner(s, me, `Ops Order complete: ${player(s, me).mission.text}`);
}

function sectorsHeld(s: GameState, f: FactionId): Set<SectorId> {
  return new Set(SECTOR_IDS.filter((sec) => ownsSector(s, f, sec)));
}

function eliminate(s: GameState, victim: FactionId, by: FactionId) {
  const v = player(s, victim);
  v.alive = false;
  v.eliminatedBy = by;
  const taken = v.cards.splice(0);
  player(s, by).cards.push(...taken);
  log(s, by, `${FACTIONS[victim].name} has been eliminated by the ${FACTIONS[by].name}${taken.length ? `, who seize ${taken.length} card(s)` : ''}.`);
  emit(s, { kind: 'ELIMINATED', who: victim, by });
  // Anyone ordered to eliminate the victim who didn't do it falls back to the region goal.
  for (const f of s.order) {
    const p = player(s, f);
    if (p.alive && p.mission.kind === 'ELIMINATE' && p.mission.target === victim && f !== by) p.mission = regionMission();
  }
}

function resolveBattle(s: GameState, from: string, to: string, blitz: boolean, mode: AttackMode) {
  const me = current(s);
  const defender = s.map[to].owner;
  const stronghold = BOARD.byId[to].stronghold;
  const maxDice = mode === 'AMPHIBIOUS' ? AMPHIBIOUS_MAX_DICE : 3;
  const rolls: DiceRoll[] = [];
  let atkLoss = 0, defLoss = 0;
  do {
    const nA = Math.min(maxDice, s.map[from].troops - 1);
    const nD = Math.min(2, s.map[to].troops);
    const atk = Array.from({ length: nA }, () => die(s)).sort((a, b) => b - a);
    const def = Array.from({ length: nD }, () => die(s)).sort((a, b) => b - a);
    if (stronghold) def[0] += 1;
    let aL = 0, dL = 0;
    for (let i = 0; i < Math.min(nA, nD); i++) {
      if (atk[i] > def[i]) dL++;
      else aL++;
    }
    s.map[from].troops -= aL;
    s.map[to].troops -= dL;
    atkLoss += aL;
    defLoss += dL;
    rolls.push({ attacker: me, defender, from, to, atk, def, atkLoss: aL, defLoss: dL, stronghold });
    s.stats.attacks++;
  } while (blitz && s.map[to].troops > 0 && s.map[from].troops >= 2);

  const captured = s.map[to].troops <= 0;
  emit(s, { kind: 'BATTLE', from, to, attacker: me, defender, rolls, atkLoss, defLoss, captured, mode });
  const verb = mode === 'AMPHIBIOUS' ? 'storms ashore at' : mode === 'INSERTION' ? 'inserts into' : 'attacks';
  log(s, me, `${FACTIONS[me].name} ${verb} ${BOARD.byId[to].name}: lost ${atkLoss}, killed ${defLoss}${captured ? ' — captured!' : '.'}`);
  if (!captured) return;

  const before = sectorsHeld(s, me);
  s.map[to] = { owner: me, troops: 0 };
  s.stats.captures++;
  player(s, me).conquered = true;
  emit(s, { kind: 'CAPTURE', region: to, by: me, from: defender });
  for (const sec of sectorsHeld(s, me)) {
    if (!before.has(sec)) {
      emit(s, { kind: 'SECTOR', sector: sec, by: me });
      log(s, me, `${FACTIONS[me].name} secures the ${SECTORS[sec].name}!`);
    }
  }
  if (!regionsOf(s, defender).length) eliminate(s, defender, me);

  const lastDice = rolls[rolls.length - 1].atk.length;
  const max = s.map[from].troops - 1;
  const min = Math.min(lastDice, max);
  if (min >= max) {
    s.map[from].troops -= max;
    s.map[to].troops = max;
  } else s.pendingMove = { from, to, min, max };
  checkVictory(s);
}

function endTurn(s: GameState) {
  const me = current(s);
  const p = player(s, me);
  if (p.conquered || me === 'DIS') {
    const card = drawCard(s);
    if (card) {
      p.cards.push(card);
      emit(s, { kind: 'CARD', who: me, card });
    }
  }
  s.stats.turns++;
  do {
    s.turnIndex = (s.turnIndex + 1) % s.order.length;
    if (s.turnIndex === 0) s.round++;
  } while (!player(s, current(s)).alive);

  if (s.round > MAX_ROUNDS) {
    const alive = s.order.filter((f) => player(s, f).alive);
    const best = alive.sort((a, b) => regionsOf(s, b).length - regionsOf(s, a).length || troopsOf(s, b) - troopsOf(s, a))[0];
    return declareWinner(s, best, `the exercise clock ran out with the ${FACTIONS[best].name} holding the most ground.`);
  }
  beginTurn(s);
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export class IllegalAction extends Error {}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new IllegalAction(msg);
}

export function apply(prev: GameState, action: Action): GameState {
  const s: GameState = structuredClone(prev);
  must(s.phase !== 'GAME_OVER', 'The exercise is over.');
  const me = current(s);
  const p = player(s, me);
  s.tick++;

  if (s.pendingMove && action.type !== 'MOVE_IN') throw new IllegalAction('Move troops into the captured region first.');

  switch (action.type) {
    case 'PLACE': {
      must(s.phase === 'MOBILISE' || (s.phase === 'ASSAULT' && s.reserve > 0), 'You can only place troops while mobilising.');
      must(s.map[action.region]?.owner === me, 'Place troops on your own regions.');
      const n = Math.min(Math.max(1, Math.floor(action.count)), s.reserve);
      must(n > 0, 'No troops left to place.');
      s.map[action.region].troops += n;
      s.reserve -= n;
      break;
    }
    case 'TRADE': {
      must(s.phase === 'MOBILISE' || (s.phase === 'ASSAULT' && p.cards.length > MAX_HAND), 'Trade cards while mobilising.');
      const cards = action.cardIds.map((id) => p.cards.find((c) => c.id === id));
      must(cards.every(Boolean), 'You do not hold those cards.');
      must(isValidSet(cards as Card[]), 'A set is three of a kind or one of each (wild cards match anything).');
      const value = tradeValue(s.tradesDone++) + (me === 'DIS' ? DIS_TRADE_BONUS : 0);
      s.reserve += value;
      let bonusRegion: string | null = null;
      for (const c of cards as Card[]) {
        if (!bonusRegion && c.region && s.map[c.region].owner === me) bonusRegion = c.region;
      }
      if (bonusRegion) s.map[bonusRegion].troops += CARD_REGION_BONUS;
      p.cards = p.cards.filter((c) => !action.cardIds.includes(c.id));
      s.discard.push(...(cards as Card[]));
      emit(s, { kind: 'TRADE', who: me, troops: value });
      log(s, me, `${FACTIONS[me].name} trades Asset Cards for ${value} troops${bonusRegion ? ` (+${CARD_REGION_BONUS} at ${BOARD.byId[bonusRegion].name})` : ''}.`);
      break;
    }
    case 'END_MOBILISE': {
      must(s.phase === 'MOBILISE', 'Not mobilising.');
      must(s.reserve === 0, 'Place all your troops first.');
      must(p.cards.length < MAX_HAND, `You hold ${p.cards.length} cards — trade a set first.`);
      s.phase = 'ASSAULT';
      break;
    }
    case 'ATTACK': {
      const opt = attackOptions(s, action.from).find((o) => o.to === action.to);
      must(opt, 'That attack is not possible.');
      if (opt.mode === 'INSERTION') p.powerUsed = true;
      resolveBattle(s, action.from, action.to, action.blitz || opt.mode === 'INSERTION', opt.mode);
      break;
    }
    case 'MOVE_IN': {
      const pm = s.pendingMove;
      must(pm, 'Nothing to move in.');
      const n = Math.min(pm.max, Math.max(pm.min, Math.floor(action.count)));
      s.map[pm.from].troops -= n;
      s.map[pm.to].troops += n;
      s.pendingMove = null;
      break;
    }
    case 'STRIKE': {
      must(canStrike(s), 'Precision Strike is not available.');
      const h = s.map[action.region];
      must(h && h.owner !== me, 'Strike an enemy region.');
      const killed = Math.min(STRIKE_DAMAGE, h.troops - 1);
      must(killed > 0, 'That region is down to its last troop — nothing to strike.');
      h.troops -= killed;
      p.powerUsed = true;
      emit(s, { kind: 'STRIKE', region: action.region, by: me, killed });
      log(s, me, `RSAF Precision Strike on ${BOARD.byId[action.region].name}: ${killed} troops lost.`);
      break;
    }
    case 'END_ASSAULT': {
      must(s.phase === 'ASSAULT' && s.reserve === 0, 'Finish placing troops first.');
      s.phase = 'REDEPLOY';
      break;
    }
    case 'REDEPLOY': {
      must(s.phase === 'ASSAULT' || s.phase === 'REDEPLOY', 'You can only redeploy at the end of your turn.');
      must(s.reserve === 0, 'Finish placing troops first.');
      must(s.map[action.from]?.owner === me && connectedOwned(s, action.from).includes(action.to), 'Redeploy between your own connected regions.');
      const n = Math.min(Math.floor(action.count), s.map[action.from].troops - 1);
      must(n > 0, 'Leave at least one troop behind.');
      s.map[action.from].troops -= n;
      s.map[action.to].troops += n;
      log(s, me, `${FACTIONS[me].name} redeploys ${n} troops to ${BOARD.byId[action.to].name}.`);
      endTurn(s);
      break;
    }
    case 'END_TURN': {
      must(s.phase === 'ASSAULT' || s.phase === 'REDEPLOY', 'Finish mobilising first.');
      must(s.reserve === 0, 'Finish placing troops first.');
      endTurn(s);
      break;
    }
  }
  return s;
}
