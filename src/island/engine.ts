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
  const sizes: Partial<Record<FactionId, number>> = {};
  for (const f of s.factions) sizes[f] = 1;
  // Each task force's frontier (unowned regions next to it), kept incrementally
  // and read back in board order so the shuffle stays the same for a seed.
  const front = new Map(s.factions.map((f) => [f, new Set<string>()]));
  const claim = (r: string, f: FactionId) => {
    owner[r] = f;
    for (const fr of front.values()) fr.delete(r);
    for (const n of BOARD.byId[r].neighbours) if (!owner[n]) front.get(f)!.add(n);
  };
  for (const f of s.factions) claim(hqOf[f], f);
  for (let dealt = s.factions.length; dealt < REGION_IDS.length; dealt++) {
    const growing = s.factions.filter((f) => front.get(f)!.size);
    if (!growing.length) break;
    const f = growing.sort((a, b) => sizes[a]! - sizes[b]! || nextRandom(s) - 0.5)[0];
    const next = REGION_IDS.filter((r) => front.get(f)!.has(r)).sort((a, b) => dist[f][a] - dist[f][b] || nextRandom(s) - 0.5)[0];
    claim(next, f);
    sizes[f]!++;
  }
  return { owner, hqOf };
}

export interface NewGameOptions {
  human: FactionId | null;
  factions: FactionId[];
  seed?: number;
  /** Extra new troops a round per task force (negative: fewer; fractions pay out every few rounds) — the difficulty setting. */
  handicaps?: Partial<Record<FactionId, number>>;
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
    const d = graphDistances(hqOf[f]);
    const home = REGION_IDS.filter((r) => owner[r] === f).sort((a, b) => d[a] - d[b]);
    home.forEach((r) => (s.map[r].unit = nextCompany(s, f)));
  }

  for (const f of s.factions) {
    s.players[f] = { id: f, human: f === opts.human, alive: true, vp: 0, revealed: [], reconsUsed: 0, orders: null };
    const handicap = opts.handicaps?.[f];
    if (handicap && Number.isFinite(handicap)) s.players[f]!.handicap = handicap;
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
  // A fractional handicap pays out whole troops on a fixed rhythm: −0.5 is one
  // troop fewer every other round.
  const h = s.players[f]?.handicap ?? 0;
  const handicap = Math.floor(s.round * h) - Math.floor((s.round - 1) * h);
  if (handicap) parts.push({ label: handicap > 0 ? 'Reinforcements' : 'Exercise handicap', n: handicap });
  const airbases = held.filter((r) => INSTALLATIONS[r] === 'AIRBASE').length;
  const radars = held.filter((r) => INSTALLATIONS[r] === 'RADAR').length;
  return {
    // A handicap can thin the flow but never stop it.
    troops: Math.max(1, parts.reduce((n, p) => n + p.n, 0)),
    sorties: BASE_SORTIES + airbases + (f === 'HELANG' ? 1 : 0),
    recons: BASE_RECONS + radars + (f === 'HARIMAU' ? 1 : 0),
    troopParts: parts.filter((p) => p.n !== 0),
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

/** Naval gunfire a task force adds to a fight on a coast whose sea it holds alone. */
export function gunfireBonus(f: FactionId): number {
  return NAVAL_GUNFIRE_BONUS * (f === 'JERUNG' ? 2 : 1);
}

/** The zones a landing from `from` to `to` could go through. */
export function sharedZones(from: string, to: string): ZoneId[] {
  const a = zonesOf(from);
  return zonesOf(to).filter((z) => a.includes(z));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Orders arrive from a UI, a bot or (online) a client: nothing about their
// shape is trusted. Lookups go through Sets so "__proto__" is just unknown.
const REGION_SET = new Set(REGION_IDS);
const ZONE_SET = new Set<string>(ZONE_IDS);
const isRegion = (r: unknown): r is string => typeof r === 'string' && REGION_SET.has(r);
const isZone = (z: unknown): z is ZoneId => typeof z === 'string' && ZONE_SET.has(z);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
type Loose = Record<string, unknown>;
const isObject = (o: unknown): o is Loose => typeof o === 'object' && o !== null && !Array.isArray(o);

/** An order the resolver can act on without tripping: right shape, real places, sane numbers. */
function wellFormed(o: unknown): o is Order {
  if (!isObject(o)) return false;
  switch (o.kind) {
    case 'DEPLOY':
      return isRegion(o.region) && isCount(o.count);
    case 'MOVE':
      return isRegion(o.from) && isRegion(o.to) && isCount(o.count) && BOARD.byId[o.from].neighbours.includes(o.to);
    case 'LAND':
      return isRegion(o.from) && isRegion(o.to) && o.from !== o.to && isZone(o.zone) && isCount(o.count) && sharedZones(o.from, o.to).includes(o.zone);
    case 'SAIL':
      return typeof o.ship === 'string' && isZone(o.to);
    case 'STRIKE':
    case 'CAS':
      return isRegion(o.region);
    default:
      return false;
  }
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
  // Once it's over — for everyone, or just for you — the fog lifts: a
  // wiped-out commander watches the rest of the exercise as a spectator.
  const spectator = s.phase === 'GAME_OVER' || !p.alive;
  const map: PlayerView['map'] = {};
  for (const r of REGION_IDS) {
    const h = s.map[r];
    let intel: Intel;
    if (spectator || h.owner === me || p.revealed.includes(r)) intel = { kind: 'exact', troops: h.troops };
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
    lastReport: s.lastReport && !spectator ? redactReport(s.lastReport, me) : s.lastReport,
    winner: s.winner,
    winReason: s.winReason,
  };
}

/**
 * The round report as one task force is entitled to see it: fights it had no
 * eyes on keep their place and outcome but lose every number and unit; marches
 * it couldn't see and other task forces' failures drop out.
 */
export function redactReport(report: RoundReport, me: FactionId): RoundReport {
  const blank = (sd: Side): Side => ({ owner: sd.owner, units: [], troops: 0, bonuses: [], strength: 0, from: [] });
  const steps: ReportStep[] = [];
  for (const st of report.steps) {
    switch (st.kind) {
      case 'STRIKE':
        steps.push(st.seen.includes(me) ? st : { ...st, killed: 0, redacted: true });
        break;
      case 'CLASH':
        steps.push(st.seen.includes(me) ? st : { ...st, a: blank(st.a), b: blank(st.b), redacted: true });
        break;
      case 'BATTLE':
        steps.push(
          st.seen.includes(me)
            ? st
            : {
                ...st,
                defender: st.defender && blank(st.defender),
                attackers: st.attackers.map(blank),
                survivors: 0,
                ...(st.fallback ? { fallback: { to: st.fallback.to, count: 0 } } : {}),
                redacted: true,
              },
        );
        break;
      case 'MOVES': {
        const moves = st.moves.filter((m) => m.seen.includes(me));
        if (moves.length) steps.push({ ...st, moves });
        break;
      }
      case 'FAILED':
        if (st.owner === me) steps.push(st);
        break;
      default:
        steps.push(st);
    }
  }
  return { round: report.round, steps: structuredClone(steps) };
}

export interface DefenceEstimate {
  /** What you know of the garrison. */
  troops: Intel;
  /** Every bonus the defender will get that public information can show. */
  bonuses: { label: string; n: number }[];
  /** Close air support the defender could still fly in (secret until the round resolves). */
  mayAddAir: number;
}

/**
 * The defence you'd be attacking at `region`, from what this view shows. Naval
 * gunfire is judged on the ships as they stand — fleets sail before the fight.
 * Not counted: troops the defender marches in, and its air support (mayAddAir).
 */
export function defenceEstimate(view: PlayerView, region: string): DefenceEstimate {
  const rv = view.map[region];
  const owner = rv.owner;
  const bonuses = [{ label: BOARD.byId[region].stronghold ? 'Stronghold' : 'Dug in', n: defenceBonus(region) }];
  if (owner === 'HARIMAU') bonuses.push({ label: 'Ambush', n: HARIMAU_AMBUSH_BONUS });
  if (zonesOf(region).some((z) => controller(view.ships, z) === owner)) bonuses.push({ label: 'Naval gunfire (if their ships stay)', n: gunfireBonus(owner) });
  const ownerAlive = view.players.find((p) => p.id === owner)?.alive ?? false;
  return { troops: rv.intel, bonuses, mayAddAir: ownerAlive ? CAS_BONUS : 0 };
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
  const p = player(prev, me);
  must(prev.phase === 'PLANNING' && p.alive && p.orders === null, 'You can only recon while planning.');
  must(p.reconsUsed < budget(prev, me).recons, 'No recon left this round.');
  must(isRegion(region), 'Unknown region.');
  must(prev.map[region].owner !== me, 'Recon looks at enemy ground, not your own.');
  const s = structuredClone(prev);
  const q = player(s, me);
  q.reconsUsed++;
  const reveal = [region, ...BOARD.byId[region].neighbours];
  q.revealed = [...new Set([...q.revealed, ...reveal])];
  return s;
}

/**
 * One pass over a plan, in the order written. Deployments and sails count
 * wherever they sit in the list — they happen before anyone marches — so
 * troops deployed later in the list may already march, and a landing is
 * judged on where the fleet will be once it has sailed. An order with a
 * problem uses up nothing, so the rest are judged as if it weren't there.
 */
function analyse(s: GameState, me: FactionId, raw: unknown) {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const b = budget(s, me);
  const own = (r: unknown): r is string => isRegion(r) && s.map[r].owner === me;
  const myShip = (id: unknown) => s.ships.find((sh) => sh.id === id && sh.owner === me && sh.zone);

  const pool: Record<string, number> = {};
  for (const r of regionsOf(s, me)) pool[r] = s.map[r].troops;
  let toDeploy = b.troops;
  const sailTo = new Map<string, ZoneId>();
  for (const o of list) {
    if (!isObject(o)) continue;
    if (o.kind === 'DEPLOY' && own(o.region) && isCount(o.count) && o.count <= toDeploy) {
      pool[o.region] += o.count;
      toDeploy -= o.count;
    }
    if (o.kind === 'SAIL') {
      const ship = myShip(o.ship);
      if (ship && isZone(o.to) && SEA_ZONES[ship.zone!].neighbours.includes(o.to) && !sailTo.has(ship.id)) sailTo.set(ship.id, o.to);
    }
  }
  const shipsAfter = (zone: ZoneId) => s.ships.filter((sh) => sh.owner === me && sh.zone && (sailTo.get(sh.id) ?? sh.zone) === zone).length;
  const capacity = shipCapacity(me);

  let deployed = 0, sorties = 0;
  const left = { ...pool };
  const lift: Partial<Record<ZoneId, number>> = {};
  const sailed = new Set<string>();
  const issues = list.map((o): string | null => {
    if (!isObject(o)) return 'Unknown order.';
    switch (o.kind) {
      case 'DEPLOY':
        if (!own(o.region)) return 'Deploy troops in your own regions.';
        if (!isCount(o.count)) return 'Deploy a whole number of troops.';
        if (deployed + o.count > b.troops) return `Only ${plural(b.troops, 'new troop')} to deploy this round.`;
        deployed += o.count;
        return null;
      case 'STRIKE':
      case 'CAS':
        if (!isRegion(o.region)) return 'Unknown region.';
        if (o.kind === 'STRIKE' && own(o.region)) return "Don't bomb your own ground.";
        if (sorties >= b.sorties) return `You have ${plural(b.sorties, 'air sortie')}.`;
        sorties++;
        return null;
      case 'SAIL': {
        const ship = myShip(o.ship);
        if (!ship) return 'That ship is not yours to sail.';
        if (!isZone(o.to) || !SEA_ZONES[ship.zone!].neighbours.includes(o.to)) return 'Ships sail one zone at a time.';
        if (sailed.has(ship.id)) return 'One order per ship.';
        sailed.add(ship.id);
        return null;
      }
      case 'MOVE':
      case 'LAND': {
        if (!own(o.from)) return 'Send troops from your own regions.';
        if (!isRegion(o.to)) return 'Unknown region.';
        if (!isCount(o.count)) return 'Send a whole number of troops.';
        const from = BOARD.byId[o.from].name, to = BOARD.byId[o.to].name;
        if (o.kind === 'MOVE' && !BOARD.byId[o.from].neighbours.includes(o.to)) return `${to} isn't next to ${from}.`;
        if (left[o.from] - o.count < 1) return `${from} must keep at least one troop.`;
        if (o.kind === 'LAND') {
          if (o.from === o.to || !isZone(o.zone) || !sharedZones(o.from, o.to).includes(o.zone)) return 'Land between two coasts on the same sea zone.';
          const ships = shipsAfter(o.zone);
          const sea = SEA_ZONES[o.zone].name;
          if (!ships) return `You need a ship in the ${sea} to land troops.`;
          if ((lift[o.zone] ?? 0) + o.count > ships * capacity) return `Your ships in the ${sea} can carry ${plural(ships * capacity, 'troop')}.`;
          lift[o.zone] = (lift[o.zone] ?? 0) + o.count;
        }
        left[o.from] -= o.count;
        return null;
      }
      default:
        return 'Unknown order.';
    }
  });
  return { issues, budget: b, deployed, sorties, left, lift, shipsAfter, capacity, isList: Array.isArray(raw) };
}

/** Per order: what's wrong with it, or null if it's fine — for flagging a plan while it's drafted. */
export function orderIssues(s: GameState, me: FactionId, orders: Order[]): (string | null)[] {
  return analyse(s, me, orders).issues;
}

export interface PlanSummary {
  /** New troops still to place. */
  deployLeft: number;
  sortiesLeft: number;
  /**
   * Troops that may still leave one of your regions (all but one stay),
   * counting every deployment in the plan. `except` leaves one order out —
   * the one being edited — given as the order itself or its index.
   */
  available: (region: string, except?: Order | number) => number;
  /** Troops your fleet in a zone can still carry, after planned sails and landings. */
  liftLeft: (zone: ZoneId, except?: Order | number) => number;
  /** Your ships in a zone once planned sails are done. */
  shipsIn: (zone: ZoneId) => number;
}

/** What a plan leaves to spend — the same arithmetic validateOrders uses. */
export function planSummary(s: GameState, me: FactionId, orders: Order[]): PlanSummary {
  const all = analyse(s, me, orders);
  const without = (except?: Order | number) => {
    const i = typeof except === 'number' ? except : except === undefined ? -1 : orders.indexOf(except);
    return i < 0 ? all : analyse(s, me, orders.filter((_, j) => j !== i));
  };
  return {
    deployLeft: all.budget.troops - all.deployed,
    sortiesLeft: all.budget.sorties - all.sorties,
    available: (region, except) => {
      const a = without(except);
      return isRegion(region) && region in a.left ? Math.max(0, a.left[region] - 1) : 0;
    },
    liftLeft: (zone, except) => {
      const a = without(except);
      return isZone(zone) ? Math.max(0, a.shipsAfter(zone) * a.capacity - (a.lift[zone] ?? 0)) : 0;
    },
    shipsIn: (zone) => (isZone(zone) ? all.shipsAfter(zone) : 0),
  };
}

/** Why a set of orders can't be submitted, or null if it can. Null exactly when every order is fine and every new troop is placed. */
export function validateOrders(s: GameState, me: FactionId, orders: Order[]): string | null {
  const a = analyse(s, me, orders);
  if (!a.isList) return 'Orders must be a list.';
  const issue = a.issues.find((x) => x !== null);
  if (issue) return issue;
  if (a.deployed !== a.budget.troops) return `Deploy all ${plural(a.budget.troops, 'new troop')} (${a.deployed} placed).`;
  return null;
}

export function submitOrders(prev: GameState, me: FactionId, orders: Order[]): GameState {
  must(prev.phase === 'PLANNING' && player(prev, me)?.alive, 'Not planning.');
  const err = validateOrders(prev, me, orders);
  if (err) throw new IllegalAction(err);
  const s = structuredClone(prev);
  player(s, me).orders = structuredClone(orders);
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
  zone: ZoneId | null;
}

function side(s: GameState, owner: FactionId, troops: number, bonuses: Side['bonuses'], from: string[], units?: string[]): Side {
  const live = bonuses.filter((b) => b.n);
  return { owner, units: units ?? from.map((r) => s.map[r].unit), troops, bonuses: live, strength: troops + live.reduce((n, b) => n + b.n, 0), from };
}

/**
 * Rule switches, for the sim to measure variants against; the game never
 * changes them. defenderFallback: a beaten defender keeps half its troops and
 * falls back to ground it still holds next door, so losing ground isn't
 * losing the army (measured in README "Measured").
 */
export const RULES = { defenderFallback: true };

export function resolveRound(prev: GameState): { state: GameState; report: RoundReport } {
  must(prev.phase === 'PLANNING', 'The exercise is over.');
  const s: GameState = structuredClone(prev);
  const steps: ReportStep[] = [];
  const live = alive(s);
  // Orders are re-checked for shape here too: whatever slipped past
  // validation is skipped, never allowed to throw.
  const plans = new Map<FactionId, Order[]>();
  for (const f of live) {
    const raw = player(s, f).orders;
    plans.set(f, Array.isArray(raw) ? raw.filter(wellFormed) : []);
  }
  const orders = (f: FactionId) => plans.get(f) ?? [];
  const name = (f: FactionId) => FACTIONS[f].name;
  const place = (r: string) => BOARD.byId[r].name;

  // Who had eyes on what, as the round opened (see ReportStep.seen).
  const startOwner: Record<string, FactionId> = {};
  for (const r of REGION_IDS) startOwner[r] = s.map[r].owner;
  const watchers = (regions: string[], also: FactionId[]): FactionId[] =>
    s.factions.filter(
      (f) =>
        also.includes(f) ||
        (live.includes(f) &&
          regions.some((r) => startOwner[r] === f || player(s, f).revealed.includes(r) || BOARD.byId[r].neighbours.some((n) => startOwner[n] === f))),
    );

  // 1. Deployments.
  for (const f of live) for (const o of orders(f)) if (o.kind === 'DEPLOY' && s.map[o.region].owner === f) s.map[o.region].troops += o.count;

  // 2. Fleets sail together, then fight wherever rivals meet.
  const sailed = new Set<string>();
  for (const f of live)
    for (const o of orders(f)) {
      if (o.kind !== 'SAIL' || sailed.has(o.ship)) continue;
      const ship = s.ships.find((sh) => sh.id === o.ship && sh.owner === f);
      if (ship?.zone && SEA_ZONES[ship.zone].neighbours.includes(o.to)) {
        ship.zone = o.to;
        sailed.add(o.ship);
      }
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
      steps.push({ kind: 'STRIKE', by: f, region: o.region, killed, seen: watchers([o.region], [f, s.map[o.region].owner]) });
    }

  // 4. Everyone sets off at once. Strikes may have thinned a region below what
  //    was ordered out of it; a landing needs the sea still to be yours and
  //    room on the ships that are left. Orders over the same road (or the same
  //    crossing) travel as one column — splitting a force buys nothing.
  const parts: Part[] = [];
  const lift: Record<string, number> = {};
  for (const f of live)
    for (const o of orders(f)) {
      if (o.kind !== 'MOVE' && o.kind !== 'LAND') continue;
      if (s.map[o.from].owner !== f) continue;
      let count = Math.min(o.count, s.map[o.from].troops - 1);
      if (count <= 0) continue;
      if (o.kind === 'LAND') {
        const sea = SEA_ZONES[o.zone].name;
        if (controller(s.ships, o.zone) !== f) {
          steps.push({ kind: 'FAILED', owner: f, text: `${name(f)} lost control of the ${sea}: the landing at ${place(o.to)} is off.` });
          continue;
        }
        const key = `${f}/${o.zone}`;
        const room = shipsIn(s.ships, o.zone).filter((sh) => sh.owner === f).length * shipCapacity(f) - (lift[key] ?? 0);
        if (count > room) {
          steps.push({
            kind: 'FAILED',
            owner: f,
            text:
              room > 0
                ? `${name(f)} has room for only ${room} of ${plural(count, 'troop')} in the ${sea}: ${plural(count - room, 'troop')} stay in ${place(o.from)}.`
                : `${name(f)} has no room left on its ships in the ${sea}: the landing of ${plural(count, 'troop')} at ${place(o.to)} is off.`,
          });
          count = room;
        }
        if (count <= 0) continue;
        lift[key] = (lift[key] ?? 0) + count;
      }
      s.map[o.from].troops -= count;
      const zone = o.kind === 'LAND' ? o.zone : null;
      const same = parts.find((p) => p.owner === f && p.from === o.from && p.to === o.to && p.zone === zone);
      if (same) same.count += count;
      else parts.push({ owner: f, from: o.from, to: o.to, count, landing: o.kind === 'LAND', zone });
    }
  if (parts.length)
    steps.push({
      kind: 'MOVES',
      moves: parts.map((p) => ({ owner: p.owner, from: p.from, to: p.to, count: p.count, landing: p.landing, seen: watchers([p.from, p.to], [p.owner]) })),
    });

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
    steps.push({ kind: 'CLASH', a: sa, b: sb, at: [a.from, a.to], winner, seen: watchers([a.from, a.to], [a.owner, b.owner]) });
  }

  // 6. Every contested region fights it out, all against the board as it stood
  //    when the columns left — captures and retreats land afterwards.
  const navalSupport = (f: FactionId, region: string) => zonesOf(region).some((z) => controller(s.ships, z) === f);
  const cas = (f: FactionId, region: string) => orders(f).some((o) => o.kind === 'CAS' && o.region === region);
  const captures: { region: string; owner: FactionId; troops: number }[] = [];
  const retreats: { owner: FactionId; region: string; origins: string[]; count: number; step?: Extract<ReportStep, { kind: 'BATTLE' }> }[] = [];
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
        { label: 'Naval gunfire', n: navalSupport(holder, region) ? gunfireBonus(holder) : 0 },
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
          { label: 'Naval gunfire', n: navalSupport(owner, region) ? gunfireBonus(owner) : 0 },
        ],
        [...new Set(ps.map((p) => p.from))],
      ),
    );
    // Strongest wins, and the defender wins any tie it's part of. Attackers
    // tied for strongest get in each other's way: the defender holds — so seat
    // order never decides a fight.
    const top = Math.max(...attackers.map((a) => a.strength));
    const leaders = attackers.filter((a) => a.strength === top);
    const bounced = top > defender.strength && leaders.length > 1;
    const win = top > defender.strength && !bounced ? leaders[0] : defender;
    const runnerUp = Math.max(0, ...[defender, ...attackers].filter((x) => x !== win).map((x) => x.strength));
    const survivors = Math.max(1, win.troops - Math.ceil(runnerUp / 2));
    const captured = win !== defender;
    const step: Extract<ReportStep, { kind: 'BATTLE' }> = {
      kind: 'BATTLE',
      region,
      defender,
      attackers,
      winner: win.owner,
      captured,
      survivors,
      seen: watchers([region], [holder, ...attackers.map((a) => a.owner)]),
      ...(bounced ? { bounced: true as const } : {}),
    };
    if (captured) {
      captures.push({ region, owner: win.owner, troops: survivors });
      s.stats.captures++;
      const back = Math.floor(defTroops / 2);
      if (RULES.defenderFallback && back > 0) retreats.push({ owner: holder, region, origins: [], count: back, step });
    } else holds.push({ region, troops: survivors });
    // Beaten attackers lose half and fall back the way they came.
    for (const a of attackers) {
      if (a === win) continue;
      const back = Math.floor(a.troops / 2);
      const origins = [...byOwner.get(a.owner)!].sort((x, y) => y.count - x.count).map((p) => p.from);
      if (back > 0) retreats.push({ owner: a.owner, region, origins: [...new Set(origins)], count: back });
    }
    steps.push(step);
  }

  for (const h of holds) s.map[h.region].troops = h.troops;
  for (const r of reinforcements) s.map[r.region].troops += r.count;
  for (const c of captures) {
    s.map[c.region] = { owner: c.owner, troops: c.troops, unit: '' };
    s.map[c.region].unit = nextCompany(s, c.owner);
  }
  // Retreats go home if home is still theirs, else to any of their ground
  // next to the fight. With nowhere to go, they're cut off and surrender.
  for (const r of retreats) {
    const to =
      r.origins.find((o) => s.map[o].owner === r.owner) ??
      BOARD.byId[r.region].neighbours.filter((n) => s.map[n].owner === r.owner).sort((a, b) => s.map[b].troops - s.map[a].troops)[0];
    if (to) {
      s.map[to].troops += r.count;
      if (r.step) r.step.fallback = { to, count: r.count };
    } else steps.push({ kind: 'FAILED', owner: r.owner, text: `${plural(r.count, 'troop')} of ${name(r.owner)} were cut off at ${place(r.region)} and surrendered.` });
  }

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
      return log(s, step.by, `${n(step.by)} air strike on ${r(step.region)}: ${plural(step.killed, 'troop')} lost.`);
    case 'FAILED':
      return log(s, step.owner, step.text);
    case 'CLASH':
      return log(s, step.winner, `Columns clash between ${r(step.at[0])} and ${r(step.at[1])}${step.winner ? `: ${n(step.winner)} pushes through` : ': both shattered'}.`);
    case 'BATTLE': {
      if (step.captured) {
        const fell = step.fallback ? ` The defenders fall back to ${r(step.fallback.to)}.` : '';
        return log(s, step.winner, `${r(step.region)} captured by ${n(step.winner)} (${step.attackers.find((a) => a.owner === step.winner)!.units.join(' & ')}).${fell}`);
      }
      const tie = step.bounced ? `${step.attackers.filter((a) => a.strength === Math.max(...step.attackers.map((x) => x.strength))).map((a) => n(a.owner)).join(' and ')} get in each other's way: ` : '';
      return log(s, step.winner, `${tie}${step.defender!.units[0]} (${n(step.winner)}) holds ${r(step.region)}.`);
    }
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
