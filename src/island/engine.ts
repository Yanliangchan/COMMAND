// ============================================================================
// ISLAND OPS — rules engine.
//
// A round: every task force plans in secret (deploy, march, land, sail, fly,
// recon), submits, and when all are in the round resolves at once:
//   1. deployments land          4. every march and landing sets off together
//   2. fleets sail, then fight   5. forces meeting head-on clash en route
//   3. air strikes hit           6. each contested region fights it out
// then installations score and the next round opens.
//
// Pure functions over GameState; `viewFor` is what a player may see, and is
// all the bots (and, online, the clients) ever get. No dice anywhere — the RNG
// is only for setup.
// ============================================================================

import { BOARD, INSTALLATIONS, REGION_IDS, SEA_ZONES, ZONE_IDS, ZoneId, zonesOf } from './map';
import {
  BASE_INCOME, BASE_RECONS, HARIMAU_AMBUSH_BONUS, BASE_SORTIES, Budget, CAS_BONUS, DEFENCE_BONUS, FACTIONS, FactionId, GameState, HQ_TROOPS, INSTALLATION_INCOME, Intel,
  JERUNG_CAPACITY_BONUS, MAX_ROUNDS, NAVAL_GUNFIRE_BONUS, Order, Player, PlayerView, ReportStep, RoundReport, SHIP_CAPACITY, SHIP_REPAIR_ROUNDS, SINGA_BONUS,
  START_SHIPS, START_TROOPS_PER_REGION, STRIKE_DAMAGE, STRONGHOLD_BONUS, Ship, Side, VP_TARGET, companies,
} from './types';

// ---------------------------------------------------------------------------
// RNG (setup only)
// ---------------------------------------------------------------------------

function nextRandom(state: GameState): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

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

/** Headquarters spread round the island, so every task force starts with a coherent home ground. */
const HQ_SETS: Record<number, string[]> = {
  2: ['tuas', 'changi'],
  3: ['tuas', 'punggol', 'tanjong-pagar'],
  4: ['lim-chu-kang', 'punggol', 'bedok', 'queenstown'],
};

function graphDistances(from: string): Record<string, number> {
  const dist: Record<string, number> = { [from]: 0 };
  const queue = [from];
  while (queue.length) {
    const c = queue.shift()!;
    for (const n of BOARD.byId[c].neighbours) {
      if (dist[n] === undefined) {
        dist[n] = dist[c] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

function dealTerritories(s: GameState): { owner: Record<string, FactionId>; hqOf: Record<FactionId, string> } {
  const hqs = shuffle(s, [...HQ_SETS[s.factions.length]]);
  const hqOf = Object.fromEntries(s.factions.map((f, i) => [f, hqs[i]])) as Record<FactionId, string>;
  const dist = Object.fromEntries(s.factions.map((f) => [f, graphDistances(hqOf[f])])) as Record<FactionId, Record<string, number>>;
  // Grow outward from each HQ — always the smallest territory next — so they
  // come out contiguous and close in size.
  const owner: Record<string, FactionId> = {};
  for (const f of s.factions) owner[hqOf[f]] = f;
  const size = (f: FactionId) => Object.values(owner).filter((o) => o === f).length;
  const frontier = (f: FactionId) => REGION_IDS.filter((r) => !owner[r] && BOARD.byId[r].neighbours.some((n) => owner[n] === f));
  while (Object.keys(owner).length < REGION_IDS.length) {
    const growing = s.factions.filter((f) => frontier(f).length);
    if (!growing.length) break;
    const f = growing.sort((a, b) => size(a) - size(b) || nextRandom(s) - 0.5)[0];
    const next = frontier(f).sort((a, b) => dist[f][a] - dist[f][b] || nextRandom(s) - 0.5)[0];
    owner[next] = f;
  }
  return { owner, hqOf };
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
    phase: 'PLANNING',
    factions: [...opts.factions],
    players: {},
    map: {},
    ships: [],
    lastReport: null,
    log: [],
    winner: null,
    winReason: null,
    stats: { battles: 0, captures: 0 },
  };

  // Deal the island several ways and keep the fairest: even territories and,
  // above all, an even share of the Key Installations.
  let best: { owner: Record<string, FactionId>; hqOf: Record<FactionId, string>; score: number } | null = null;
  for (let attempt = 0; attempt < 60 && (!best || best.score > 1); attempt++) {
    const deal = dealTerritories(s);
    const sizes = s.factions.map((f) => Object.values(deal.owner).filter((o) => o === f).length);
    const kis = s.factions.map((f) => Object.keys(INSTALLATIONS).filter((r) => deal.owner[r] === f).length);
    const score = Math.max(...sizes) - Math.min(...sizes) + 3 * (Math.max(...kis) - Math.min(...kis));
    if (!best || score < best.score) best = { ...deal, score };
  }
  const { owner, hqOf } = best!;
  for (const r of REGION_IDS) s.map[r] = { owner: owner[r], troops: r === hqOf[owner[r]] ? HQ_TROOPS : START_TROOPS_PER_REGION, unit: '' };
  // Companies take up ground nearest the HQ first, so the battalions read as a coherent line.
  for (const f of s.factions) {
    const home = REGION_IDS.filter((r) => owner[r] === f).sort((a, b) => graphDistances(hqOf[f])[a] - graphDistances(hqOf[f])[b]);
    home.forEach((r) => (s.map[r].unit = nextCompany(s, f)));
  }

  for (const f of s.factions) {
    s.players[f] = { id: f, human: f === opts.human, alive: true, vp: 0, revealed: [], reconsUsed: 0, orders: null };
    // The fleet starts in whichever sea zone borders most of home.
    const home = REGION_IDS.filter((r) => owner[r] === f);
    const zone = [...ZONE_IDS].sort((a, b) => SEA_ZONES[b].coast.filter((r) => home.includes(r)).length - SEA_ZONES[a].coast.filter((r) => home.includes(r)).length)[0];
    const n = START_SHIPS + (f === 'JERUNG' ? 1 : 0);
    for (let i = 0; i < n; i++) s.ships.push({ id: `${f}-${i + 1}`, name: `${FACTIONS[f].squadron} · ${i + 1}`, owner: f, zone, repair: 0 });
  }

  log(s, null, `Exercise begins: ${s.factions.map((f) => FACTIONS[f].name).join(', ')}.`);
  return s;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const player = (s: GameState, f: FactionId): Player => s.players[f]!;
export const alive = (s: GameState): FactionId[] => s.factions.filter((f) => player(s, f).alive);

export function regionsOf(s: GameState, f: FactionId): string[] {
  return REGION_IDS.filter((r) => s.map[r].owner === f);
}

export function troopsOf(s: GameState, f: FactionId): number {
  return REGION_IDS.reduce((n, r) => n + (s.map[r].owner === f ? s.map[r].troops : 0), 0);
}

export function installationsOf(s: GameState, f: FactionId): string[] {
  return Object.keys(INSTALLATIONS).filter((r) => s.map[r].owner === f);
}

export function budget(s: GameState, f: FactionId): Budget {
  const regions = regionsOf(s, f).length;
  const held = installationsOf(s, f);
  const parts = [
    { label: 'Base', n: BASE_INCOME },
    { label: `${regions} regions`, n: Math.floor(regions / 3) },
  ];
  for (const r of held) {
    const n = INSTALLATION_INCOME[INSTALLATIONS[r]];
    if (n) parts.push({ label: BOARD.byId[r].name, n });
  }
  if (f === 'SINGA') parts.push({ label: 'Total Mobilisation', n: SINGA_BONUS });
  const airbases = held.filter((r) => INSTALLATIONS[r] === 'AIRBASE').length;
  const radars = held.filter((r) => INSTALLATIONS[r] === 'RADAR').length;
  return {
    troops: parts.reduce((n, p) => n + p.n, 0),
    sorties: BASE_SORTIES + airbases + (f === 'HELANG' ? 1 : 0),
    recons: BASE_RECONS + radars + (f === 'HARIMAU' ? 1 : 0),
    troopParts: parts.filter((p) => p.n > 0),
  };
}

/** The next company not already holding ground — a lost region's company is free again. */
export function nextCompany(s: GameState, f: FactionId): string {
  const used = new Set(REGION_IDS.filter((r) => s.map[r]?.owner === f).map((r) => s.map[r].unit));
  const free = companies(f).find((c) => !used.has(c));
  if (free) return free;
  let n = 1;
  while (used.has(`Composite Coy ${n}, ${FACTIONS[f].battalions[0]}`)) n++;
  return `Composite Coy ${n}, ${FACTIONS[f].battalions[0]}`;
}

export function shipCapacity(f: FactionId): number {
  return SHIP_CAPACITY + (f === 'JERUNG' ? JERUNG_CAPACITY_BONUS : 0);
}

export function shipsIn(ships: Ship[], zone: ZoneId): Ship[] {
  return ships.filter((sh) => sh.zone === zone);
}

/** A zone is yours if you have ships in it and nobody else does. */
export function controller(ships: Ship[], zone: ZoneId): FactionId | null {
  const owners = new Set(shipsIn(ships, zone).map((sh) => sh.owner));
  return owners.size === 1 ? [...owners][0] : null;
}

export function defenceBonus(region: string): number {
  return BOARD.byId[region].stronghold ? STRONGHOLD_BONUS : DEFENCE_BONUS;
}

/** The zones a landing from `from` to `to` could go through. */
export function sharedZones(from: string, to: string): ZoneId[] {
  const a = zonesOf(from);
  return zonesOf(to).filter((z) => a.includes(z));
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

export function band(troops: number): Intel {
  if (troops <= 2) return { kind: 'band', min: 1, max: 2 };
  if (troops <= 5) return { kind: 'band', min: 3, max: 5 };
  if (troops <= 9) return { kind: 'band', min: 6, max: 9 };
  return { kind: 'band', min: 10, max: 99 };
}

export function viewFor(s: GameState, me: FactionId): PlayerView {
  const p = player(s, me);
  const mine = new Set(regionsOf(s, me));
  const map: PlayerView['map'] = {};
  for (const r of REGION_IDS) {
    const h = s.map[r];
    let intel: Intel;
    if (h.owner === me || p.revealed.includes(r) || s.phase === 'GAME_OVER') intel = { kind: 'exact', troops: h.troops };
    else if (BOARD.byId[r].neighbours.some((n) => mine.has(n))) intel = me === 'HARIMAU' ? { kind: 'exact', troops: h.troops } : band(h.troops);
    else intel = { kind: 'hidden' };
    map[r] = { owner: h.owner, intel, unit: intel.kind === 'exact' ? h.unit : null };
  }
  const b = budget(s, me);
  return {
    me,
    round: s.round,
    phase: s.phase,
    map,
    ships: s.ships.map((sh) => ({ ...sh })),
    players: s.factions.map((f) => ({ id: f, alive: player(s, f).alive, vp: player(s, f).vp, regions: regionsOf(s, f).length, ready: player(s, f).orders !== null })),
    budget: b,
    reconsLeft: b.recons - p.reconsUsed,
    lastReport: s.lastReport,
    winner: s.winner,
    winReason: s.winReason,
  };
}

// ---------------------------------------------------------------------------
// Planning actions
// ---------------------------------------------------------------------------

export class IllegalAction extends Error {}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new IllegalAction(msg);
}

/** Recon is immediate: it changes what you know while you plan, not what happens. */
export function recon(prev: GameState, me: FactionId, region: string): GameState {
  const s = structuredClone(prev);
  const p = player(s, me);
  must(s.phase === 'PLANNING' && p.alive && p.orders === null, 'You can only recon while planning.');
  must(p.reconsUsed < budget(s, me).recons, 'No recon left this round.');
  must(BOARD.byId[region], 'Unknown region.');
  p.reconsUsed++;
  const reveal = [region, ...BOARD.byId[region].neighbours];
  p.revealed = [...new Set([...p.revealed, ...reveal])];
  return s;
}

/** Why a set of orders can't be submitted, or null if it can. */
export function validateOrders(s: GameState, me: FactionId, orders: Order[]): string | null {
  const b = budget(s, me);
  const available: Record<string, number> = {};
  for (const r of regionsOf(s, me)) available[r] = s.map[r].troops;
  let deployed = 0, sorties = 0;
  const sailing = new Set<string>();
  for (const o of orders) {
    switch (o.kind) {
      case 'DEPLOY':
        if (s.map[o.region]?.owner !== me) return 'Deploy troops in your own regions.';
        if (!(o.count > 0) || !Number.isInteger(o.count)) return 'Deploy a whole number of troops.';
        deployed += o.count;
        available[o.region] += o.count;
        break;
      case 'STRIKE':
      case 'CAS':
        if (!s.map[o.region]) return 'Unknown region.';
        if (o.kind === 'STRIKE' && s.map[o.region].owner === me) return "Don't bomb your own ground.";
        sorties++;
        break;
      case 'SAIL': {
        const ship = s.ships.find((sh) => sh.id === o.ship);
        if (!ship || ship.owner !== me || !ship.zone) return 'That ship is not yours to sail.';
        if (!SEA_ZONES[ship.zone].neighbours.includes(o.to)) return 'Ships sail one zone at a time.';
        if (sailing.has(o.ship)) return 'One order per ship.';
        sailing.add(o.ship);
        break;
      }
      default:
        break;
    }
  }
  if (deployed !== b.troops) return `Deploy all ${b.troops} new troops (${deployed} placed).`;
  if (sorties > b.sorties) return `You have ${b.sorties} air sortie${b.sorties === 1 ? '' : 's'}.`;

  const expectedShips = (zone: ZoneId) =>
    s.ships.filter((sh) => {
      if (sh.owner !== me || !sh.zone) return false;
      const sail = orders.find((o) => o.kind === 'SAIL' && o.ship === sh.id) as Extract<Order, { kind: 'SAIL' }> | undefined;
      return (sail ? sail.to : sh.zone) === zone;
    }).length;
  const lift: Partial<Record<ZoneId, number>> = {};
  for (const o of orders) {
    if (o.kind !== 'MOVE' && o.kind !== 'LAND') continue;
    if (s.map[o.from]?.owner !== me) return 'Send troops from your own regions.';
    if (!(o.count > 0) || !Number.isInteger(o.count)) return 'Send a whole number of troops.';
    available[o.from] -= o.count;
    if (available[o.from] < 1) return `${BOARD.byId[o.from].name} must keep at least one troop.`;
    if (o.kind === 'MOVE' && !BOARD.byId[o.from].neighbours.includes(o.to)) return `${BOARD.byId[o.to].name} isn't next to ${BOARD.byId[o.from].name}.`;
    if (o.kind === 'LAND') {
      if (o.from === o.to || !sharedZones(o.from, o.to).includes(o.zone)) return 'Land between two coasts on the same sea zone.';
      const ships = expectedShips(o.zone);
      if (!ships) return `You need a ship in the ${SEA_ZONES[o.zone].name} to land troops.`;
      lift[o.zone] = (lift[o.zone] ?? 0) + o.count;
      if (lift[o.zone]! > ships * shipCapacity(me)) return `Your ships in the ${SEA_ZONES[o.zone].name} can carry ${ships * shipCapacity(me)} troops.`;
    }
  }
  return null;
}

export function submitOrders(prev: GameState, me: FactionId, orders: Order[]): GameState {
  const err = validateOrders(prev, me, orders);
  if (err) throw new IllegalAction(err);
  const s = structuredClone(prev);
  must(s.phase === 'PLANNING' && player(s, me).alive, 'Not planning.');
  player(s, me).orders = orders;
  return s;
}

export const allReady = (s: GameState) => alive(s).every((f) => player(s, f).orders !== null);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function log(s: GameState, who: FactionId | null, text: string) {
  s.log.push({ round: s.round, who, text });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

interface Part {
  owner: FactionId;
  from: string;
  to: string;
  count: number;
  landing: boolean;
}

function side(s: GameState, owner: FactionId, troops: number, bonuses: Side['bonuses'], from: string[], units?: string[]): Side {
  const live = bonuses.filter((b) => b.n);
  return { owner, units: units ?? from.map((r) => s.map[r].unit), troops, bonuses: live, strength: troops + live.reduce((n, b) => n + b.n, 0), from };
}

export function resolveRound(prev: GameState): { state: GameState; report: RoundReport } {
  const s: GameState = structuredClone(prev);
  const steps: ReportStep[] = [];
  const orders = (f: FactionId) => player(s, f).orders ?? [];
  const live = alive(s);

  // 1. Deployments.
  for (const f of live) for (const o of orders(f)) if (o.kind === 'DEPLOY' && s.map[o.region].owner === f) s.map[o.region].troops += o.count;

  // 2. Fleets sail together, then fight wherever rivals meet.
  for (const f of live)
    for (const o of orders(f)) {
      if (o.kind !== 'SAIL') continue;
      const ship = s.ships.find((sh) => sh.id === o.ship && sh.owner === f);
      if (ship?.zone) ship.zone = o.to;
    }
  for (const zone of ZONE_IDS) {
    const here = shipsIn(s.ships, zone);
    const owners = [...new Set(here.map((sh) => sh.owner))];
    if (owners.length < 2) continue;
    const counts = owners.map((owner) => ({ owner, ships: here.filter((sh) => sh.owner === owner).length })).sort((a, b) => b.ships - a.ships);
    const top = counts[0].ships;
    const leaders = counts.filter((c) => c.ships === top);
    const sunk: Partial<Record<FactionId, number>> = {};
    const sink = (owner: FactionId, n: number) => {
      const fleet = here.filter((sh) => sh.owner === owner && sh.zone === zone).slice(0, n);
      for (const sh of fleet) {
        sh.zone = null;
        sh.repair = SHIP_REPAIR_ROUNDS;
      }
      if (fleet.length) sunk[owner] = fleet.length;
    };
    let winner: FactionId | null = null;
    if (leaders.length === 1) {
      winner = leaders[0].owner;
      sink(winner, Math.ceil(counts[1].ships / 2));
      for (const c of counts.slice(1)) sink(c.owner, c.ships);
    } else {
      // Evenly matched fleets maul each other; anyone smaller is sunk outright.
      for (const c of counts) sink(c.owner, c.ships === top ? 1 : c.ships);
    }
    steps.push({ kind: 'NAVAL', zone, sides: counts, winner, sunk });
  }

  // 3. Air strikes, before anyone moves.
  for (const f of live)
    for (const o of orders(f)) {
      if (o.kind !== 'STRIKE' || s.map[o.region].owner === f) continue;
      const killed = Math.min(STRIKE_DAMAGE, s.map[o.region].troops - 1);
      s.map[o.region].troops -= killed;
      steps.push({ kind: 'STRIKE', by: f, region: o.region, killed });
    }

  // 4. Everyone sets off at once. Strikes may have thinned a region below what
  //    was ordered out of it; a landing needs the sea still to be yours.
  const parts: Part[] = [];
  const lift: Record<string, number> = {};
  for (const f of live)
    for (const o of orders(f)) {
      if (o.kind !== 'MOVE' && o.kind !== 'LAND') continue;
      if (s.map[o.from].owner !== f) continue;
      let count = Math.min(o.count, s.map[o.from].troops - 1);
      if (o.kind === 'LAND') {
        const ships = shipsIn(s.ships, o.zone).filter((sh) => sh.owner === f).length;
        if (controller(s.ships, o.zone) !== f) {
          steps.push({ kind: 'FAILED', owner: f, text: `${FACTIONS[f].name} lost control of the ${SEA_ZONES[o.zone].name}: the landing at ${BOARD.byId[o.to].name} is off.` });
          continue;
        }
        const key = `${f}/${o.zone}`;
        count = Math.min(count, ships * shipCapacity(f) - (lift[key] ?? 0));
        lift[key] = (lift[key] ?? 0) + Math.max(0, count);
      }
      if (count <= 0) continue;
      s.map[o.from].troops -= count;
      parts.push({ owner: f, from: o.from, to: o.to, count, landing: o.kind === 'LAND' });
    }
  if (parts.length) steps.push({ kind: 'MOVES', moves: parts.map((p) => ({ owner: p.owner, from: p.from, to: p.to, count: p.count, landing: p.landing })) });

  // 5. Columns marching straight at each other meet on the road.
  for (const a of parts) {
    if (a.landing || a.count <= 0) continue;
    const b = parts.find((x) => !x.landing && x.count > 0 && x.owner !== a.owner && x.from === a.to && x.to === a.from);
    if (!b) continue;
    const sa = side(s, a.owner, a.count, [], [a.from]), sb = side(s, b.owner, b.count, [], [b.from]);
    let winner: FactionId | null = null;
    if (a.count > b.count) {
      winner = a.owner;
      a.count -= Math.ceil(b.count / 2);
      b.count = 0;
    } else if (b.count > a.count) {
      winner = b.owner;
      b.count -= Math.ceil(a.count / 2);
      a.count = 0;
    } else a.count = b.count = 0;
    steps.push({ kind: 'CLASH', a: sa, b: sb, at: [a.from, a.to], winner });
  }

  // 6. Every contested region fights it out, all against the board as it stood
  //    when the columns left — captures and retreats land afterwards.
  const navalSupport = (f: FactionId, region: string) => zonesOf(region).some((z) => controller(s.ships, z) === f);
  const gunfire = (f: FactionId) => NAVAL_GUNFIRE_BONUS * (f === 'JERUNG' ? 2 : 1);
  const cas = (f: FactionId, region: string) => orders(f).some((o) => o.kind === 'CAS' && o.region === region);
  const captures: { region: string; owner: FactionId; troops: number }[] = [];
  const returns: { owner: FactionId; to: string; count: number }[] = [];
  const holds: { region: string; troops: number }[] = [];
  const reinforcements: { region: string; count: number }[] = [];
  const targets = [...new Set(parts.filter((p) => p.count > 0).map((p) => p.to))];

  for (const region of targets) {
    const holder = s.map[region].owner;
    const incoming = parts.filter((p) => p.to === region && p.count > 0);
    const friendly = incoming.filter((p) => p.owner === holder);
    const hostile = incoming.filter((p) => p.owner !== holder);
    if (!hostile.length) {
      for (const p of friendly) reinforcements.push({ region, count: p.count });
      continue;
    }
    s.stats.battles++;
    const defTroops = s.map[region].troops + friendly.reduce((n, p) => n + p.count, 0);
    const defender = side(
      s,
      holder,
      defTroops,
      [
        { label: BOARD.byId[region].stronghold ? 'Stronghold' : 'Dug in', n: defenceBonus(region) },
        { label: 'Air support', n: cas(holder, region) ? CAS_BONUS : 0 },
        { label: 'Naval gunfire', n: navalSupport(holder, region) ? gunfire(holder) : 0 },
        { label: 'Ambush', n: holder === 'HARIMAU' ? HARIMAU_AMBUSH_BONUS : 0 },
      ],
      [],
      [s.map[region].unit],
    );
    const byOwner = new Map<FactionId, Part[]>();
    for (const p of hostile) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
    const attackers = [...byOwner].map(([owner, ps]) =>
      side(
        s,
        owner,
        ps.reduce((n, p) => n + p.count, 0),
        [
          { label: 'Air support', n: cas(owner, region) ? CAS_BONUS : 0 },
          { label: 'Naval gunfire', n: navalSupport(owner, region) ? gunfire(owner) : 0 },
        ],
        [...new Set(ps.map((p) => p.from))],
      ),
    );
    // Strongest wins; every tie goes to whoever already holds the ground.
    const ranked = [defender, ...attackers].sort((a, b) => b.strength - a.strength || (a === defender ? -1 : b === defender ? 1 : 0));
    const win = ranked[0];
    const runnerUp = ranked[1]?.strength ?? 0;
    const survivors = Math.max(1, win.troops - Math.ceil(runnerUp / 2));
    const captured = win !== defender;
    if (captured) {
      captures.push({ region, owner: win.owner, troops: survivors });
      s.stats.captures++;
    } else holds.push({ region, troops: survivors });
    // Beaten attackers lose half and fall back to where they came from.
    for (const a of attackers) {
      if (a === win) continue;
      const back = Math.floor(a.troops / 2);
      const origin = byOwner.get(a.owner)!.sort((x, y) => y.count - x.count)[0].from;
      if (back > 0) returns.push({ owner: a.owner, to: origin, count: back });
    }
    steps.push({ kind: 'BATTLE', region, defender, attackers, winner: win.owner, captured, survivors });
  }

  for (const h of holds) s.map[h.region].troops = h.troops;
  for (const r of reinforcements) s.map[r.region].troops += r.count;
  for (const c of captures) {
    s.map[c.region] = { owner: c.owner, troops: c.troops, unit: '' };
    s.map[c.region].unit = nextCompany(s, c.owner);
  }
  for (const r of returns) if (s.map[r.to].owner === r.owner) s.map[r.to].troops += r.count;

  // 7. Upkeep: eliminations, repairs, scoring, victory.
  for (const f of live) {
    if (regionsOf(s, f).length) continue;
    const p = player(s, f);
    p.alive = false;
    p.eliminatedRound = s.round;
    s.ships = s.ships.filter((sh) => sh.owner !== f);
    steps.push({ kind: 'ELIMINATED', who: f });
  }
  for (const sh of s.ships) {
    if (sh.zone) continue;
    if (sh.repair > 0) sh.repair--;
    if (sh.repair > 0) continue;
    const port = installationsOf(s, sh.owner).find((r) => INSTALLATIONS[r] === 'PORT');
    if (!port) continue;
    sh.zone = zonesOf(port)[0];
    steps.push({ kind: 'RECOMMISSION', owner: sh.owner, zone: sh.zone });
  }
  const gains: Partial<Record<FactionId, number>> = {};
  for (const f of alive(s)) {
    const n = installationsOf(s, f).length;
    player(s, f).vp += n;
    if (n) gains[f] = n;
  }
  steps.push({ kind: 'SCORE', gains });

  const standing = alive(s);
  const rank = (a: FactionId, b: FactionId) => player(s, b).vp - player(s, a).vp || regionsOf(s, b).length - regionsOf(s, a).length || troopsOf(s, b) - troopsOf(s, a);
  const leader = [...standing].sort(rank)[0];
  let reason: string | null = null;
  if (standing.length === 1) reason = 'last task force standing on the island.';
  else if (player(s, leader).vp >= VP_TARGET) reason = `first to ${VP_TARGET} victory points.`;
  else if (s.round >= MAX_ROUNDS) reason = `most victory points when the exercise clock ran out.`;
  if (reason && leader) {
    s.winner = leader;
    s.winReason = reason;
    s.phase = 'GAME_OVER';
    steps.push({ kind: 'VICTORY', who: leader, reason });
  }

  for (const step of steps) narrate(s, step);
  const report: RoundReport = { round: s.round, steps };
  s.lastReport = report;
  for (const f of s.factions) {
    const p = player(s, f);
    p.orders = null;
    p.revealed = [];
    p.reconsUsed = 0;
  }
  if (s.phase !== 'GAME_OVER') s.round++;
  return { state: s, report };
}

function narrate(s: GameState, step: ReportStep) {
  const n = (f: FactionId) => FACTIONS[f].name;
  const r = (id: string) => BOARD.byId[id].name;
  switch (step.kind) {
    case 'NAVAL':
      return log(s, step.winner, `Naval battle in the ${SEA_ZONES[step.zone].name}: ${step.winner ? `${n(step.winner)} wins` : 'no winner'}.`);
    case 'STRIKE':
      return log(s, step.by, `${n(step.by)} air strike on ${r(step.region)}: ${step.killed} troops lost.`);
    case 'FAILED':
      return log(s, step.owner, step.text);
    case 'CLASH':
      return log(s, step.winner, `Columns clash between ${r(step.at[0])} and ${r(step.at[1])}${step.winner ? `: ${n(step.winner)} pushes through` : ': both shattered'}.`);
    case 'BATTLE':
      return log(
        s,
        step.winner,
        step.captured
          ? `${r(step.region)} captured by ${n(step.winner)} (${step.attackers.find((a) => a.owner === step.winner)!.units.join(' & ')}).`
          : `${step.defender!.units[0]} (${n(step.winner)}) holds ${r(step.region)}.`,
      );
    case 'RECOMMISSION':
      return log(s, step.owner, `${n(step.owner)} recommissions a ship in the ${SEA_ZONES[step.zone].name}.`);
    case 'ELIMINATED':
      return log(s, step.who, `${n(step.who)} has been wiped off the island.`);
    case 'VICTORY':
      return log(s, step.who, `${n(step.who)} wins — ${step.reason}`);
    default:
      return;
  }
}
