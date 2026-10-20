// ============================================================================
// ISLAND OPS — rules checks and a bot-vs-bot balance/pacing sim.
//   npx tsx scripts/islandcheck.ts [games]        (default 1000 sim games)
//
// Bots plan from fogged PlayerViews exactly as a player would, submit through
// the same validation, and every round resolves through resolveRound. On top
// of rule spot checks and regression scenarios, this gates the things the
// design promises: lots of fighting every round, games that end on points
// inside the clock, every service of the fleet and air arm actually used, no
// Pasukan that dominates, difficulty levels that really differ, and an engine
// that shrugs off hostile input. Every seed is fixed, so results repeat.
// ============================================================================

import { BOARD, INSTALLATIONS, REGION_IDS, SEA_ZONES, ZONE_IDS, ZoneId } from '../src/island/map';
import {
  IllegalAction, allReady, alive, budget, defenceBonus, defenceEstimate, newGame, orderIssues, planSummary, player, recon, redactReport, regionsOf, resolveRound,
  submitOrders, troopsOf, validateOrders, viewFor,
} from '../src/island/engine';
import { BotLevel, LEVEL_HANDICAP, estimate, planBot } from '../src/island/bot';
import { CAS_BONUS, FACTION_IDS, FactionId, GameState, MAX_ROUNDS, Order, PlayerView, ReportStep, RoundReport } from '../src/island/types';

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};
const section = (t: string) => console.log(`\n--- ${t}`);
const nb = (r: string) => BOARD.byId[r].neighbours;

// A small deterministic RNG for the fuzzers.
let seedR = 12345;
const rnd = () => (seedR = (seedR * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

/** The faction line-up for sim game g: 3 or 4 players, rotating seats. */
function lineup(g: number): FactionId[] {
  const n = 3 + (g % 2);
  const pool = [...FACTION_IDS];
  const factions: FactionId[] = [];
  for (let i = 0; i < n; i++) factions.push(pool.splice((g * 5 + i * 3) % pool.length, 1)[0]);
  return factions;
}

const botPlan = (s: () => GameState, f: FactionId, set: (x: GameState) => void, level: BotLevel = 'REGULAR') =>
  planBot(
    () => viewFor(s(), f),
    (r) => set(recon(s(), f, r)),
    level,
  );

// --- board -----------------------------------------------------------------
section('board and setup');
check(BOARD.regions.length === 39, `39 regions (got ${BOARD.regions.length})`);
check(BOARD.regions.every((r) => r.neighbours.every((n) => BOARD.byId[n].neighbours.includes(r.id))), 'adjacency is symmetric');
{
  const reached = new Set([REGION_IDS[0]]);
  const queue = [REGION_IDS[0]];
  while (queue.length) for (const n of nb(queue.pop()!)) if (!reached.has(n)) (reached.add(n), queue.push(n));
  check(reached.size === REGION_IDS.length, 'every region is reachable over land and crossings');
}
const coastal = BOARD.regions.filter((r) => r.coastal).map((r) => r.id);
const zoned = new Set(ZONE_IDS.flatMap((z) => SEA_ZONES[z].coast));
check(coastal.every((r) => zoned.has(r)) && [...zoned].every((r) => coastal.includes(r)), 'sea zones border exactly the coastal regions');
check(ZONE_IDS.every((z) => SEA_ZONES[z].neighbours.every((n) => SEA_ZONES[n].neighbours.includes(z))), 'sea zone links are symmetric');
check(Object.keys(INSTALLATIONS).every((r) => BOARD.byId[r]), 'every installation is a real region');

for (const n of [3, 4]) {
  const s = newGame({ human: null, factions: FACTION_IDS.slice(0, n), seed: 11 });
  const contiguous = s.factions.every((f) => {
    const mine = regionsOf(s, f);
    const reach = new Set([mine[0]]);
    const q = [mine[0]];
    while (q.length) for (const x of nb(q.pop()!)) if (s.map[x].owner === f && !reach.has(x)) (reach.add(x), q.push(x));
    return reach.size === mine.length;
  });
  const sizes = s.factions.map((f) => regionsOf(s, f).length);
  check(contiguous, `${n} players: every starting territory is one connected piece`);
  check(Math.max(...sizes) - Math.min(...sizes) <= 2, `${n} players: starting territories are even (${sizes.join('/')})`);
}

// --- rules spot checks -----------------------------------------------------
section('rules spot checks');
{
  const s = newGame({ human: null, factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 3 });
  const f = 'SINGA' as FactionId;
  check(validateOrders(s, f, []) !== null, 'orders must deploy every new troop');
  const hidden = REGION_IDS.filter((r) => viewFor(s, f).map[r].intel.kind === 'hidden').length;
  check(hidden > 0, `fog: SINGA starts blind to ${hidden} regions`);
  const enemy = REGION_IDS.find((r) => s.map[r].owner !== f && viewFor(s, f).map[r].intel.kind === 'hidden')!;
  const after = recon(s, f, enemy);
  check(viewFor(after, f).map[enemy].intel.kind === 'exact', 'recon reveals exact strength');
  const throws = (fn: () => unknown) => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof IllegalAction;
    }
  };
  check(
    throws(() => {
      let t = after;
      for (let i = 0; i < 5; i++) t = recon(t, f, enemy);
    }),
    'recon is limited per round',
  );
  check(throws(() => recon(s, f, regionsOf(s, f)[0])), 'recon on your own ground is refused (GD-13)');
  check(throws(() => recon(s, f, 'atlantis')) && throws(() => recon(s, f, '__proto__')), 'recon on an unknown region is refused');

  // Handicaps: added to the troop budget, shown as a part, never below one troop.
  const h = newGame({ human: 'SINGA', factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 3, handicaps: { HELANG: 2, JERUNG: -50 } });
  check(budget(h, 'HELANG').troops === budget(s, 'HELANG').troops + 2 && budget(h, 'HELANG').troopParts.some((p) => p.label === 'Reinforcements'), 'a bot handicap adds troops, listed as Reinforcements');
  check(budget(h, 'JERUNG').troops === 1 && budget(h, 'JERUNG').troopParts.some((p) => p.n < 0), 'a negative handicap shows as a part but never cuts income below one troop');
  const half = newGame({ human: null, factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 3, handicaps: { HELANG: -0.5 } });
  const flow = [1, 2, 3, 4].map((round) => budget({ ...half, round }, 'HELANG').troops - budget({ ...s, round }, 'HELANG').troops);
  check(flow.join(',') === '-1,0,-1,0', `a fractional handicap pays out on a rhythm (−0.5 → ${flow.join(',')})`);
}

// --- hostile input (QA-07) -------------------------------------------------
section('hostile input');
{
  const s0 = newGame({ human: 'SINGA', factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 42 });
  const me: FactionId = 'SINGA';
  const B = budget(s0, me).troops;
  const src = regionsOf(s0, me).find((r) => nb(r).some((n) => s0.map[n].owner !== me))!;
  const foe = nb(src).find((n) => s0.map[n].owner !== me)!;
  const dep = (n = B, region = src): Order => ({ kind: 'DEPLOY', region, count: n });
  const ship = s0.ships.find((x) => x.owner === me)!;
  const bad = (o: unknown) => o as Order;
  const cases: [string, unknown][] = [
    ['fractional deploys', [dep(0.5), dep(B - 0.5)]],
    ['negative + oversized deploys', [dep(-5), dep(B + 5)]],
    ['a billion troops', [dep(1e9)]],
    ['NaN deploy', [dep(NaN)]],
    ['deploy in an unknown region', [dep(B, 'atlantis')]],
    ['deploy in "__proto__"', [dep(B, '__proto__')]],
    ['deploy in enemy ground', [dep(B, foe)]],
    ['march to an unknown region', [dep(), { kind: 'MOVE', from: src, to: 'atlantis', count: 1 }]],
    ['march from an unknown region', [dep(), { kind: 'MOVE', from: 'atlantis', to: src, count: 1 }]],
    ['march from "constructor"', [dep(), { kind: 'MOVE', from: 'constructor', to: src, count: 1 }]],
    ['march to itself', [dep(), { kind: 'MOVE', from: src, to: src, count: 1 }]],
    ['march with a string count', [dep(), { kind: 'MOVE', from: src, to: foe, count: '3' }]],
    ['landing through an unknown zone', [dep(), { kind: 'LAND', from: src, to: foe, zone: 'nope', count: 1 }]],
    ['landing at an unknown region', [dep(), { kind: 'LAND', from: src, to: 'atlantis', zone: ZONE_IDS[0], count: 1 }]],
    ['sail to an unknown zone', [dep(), { kind: 'SAIL', ship: ship.id, to: 'nope' }]],
    ['sail someone else\'s ship', [dep(), { kind: 'SAIL', ship: s0.ships.find((x) => x.owner !== me)!.id, to: 'NORTH' }]],
    ['one sortie more than there are', [dep(), { kind: 'CAS', region: foe }, ...Array.from({ length: budget(s0, me).sorties }, () => ({ kind: 'STRIKE', region: foe }))]],
    ['air support on an unknown region', [dep(), { kind: 'CAS', region: 'atlantis' }]],
    ['strike on an unknown region', [dep(), { kind: 'STRIKE', region: 'hasOwnProperty' }]],
    ['an unknown order kind', [dep(), { kind: 'NUKE', region: src }]],
    ['a null order', [dep(), null]],
    ['a string order', [dep(), 'MOVE']],
    ['an array order', [dep(), []]],
    ['orders = null', null],
    ['orders = an object', { 0: dep() }],
  ];
  const failed: string[] = [];
  for (const [label, orders] of cases) {
    try {
      const v = validateOrders(s0, me, orders as Order[]);
      orderIssues(s0, me, orders as Order[]);
      planSummary(s0, me, (Array.isArray(orders) ? orders : []) as Order[]);
      if (v === null) failed.push(`${label}: accepted`);
    } catch (e) {
      failed.push(`${label}: threw ${(e as Error).message}`);
    }
  }
  check(!failed.length, `${cases.length} hostile order sets are all rejected without throwing${failed.length ? ` — ${failed.join('; ')}` : ''}`);

  // The resolver never trusts orders either: junk slipped past validation is skipped.
  const junk = [null, 7, 'x', [], { kind: 'NUKE' }, dep(B, 'atlantis'), dep(NaN), { kind: 'MOVE', from: 'atlantis', to: src, count: 1 }, { kind: 'MOVE', from: src, to: foe, count: -3 },
    { kind: 'LAND', from: src, to: 'atlantis', zone: 'NORTH', count: 2 }, { kind: 'SAIL', ship: ship.id, to: 'nope' }, { kind: 'SAIL', ship: 'ghost', to: 'NORTH' },
    { kind: 'STRIKE', region: '__proto__' }, { kind: 'CAS', region: 'atlantis' }].map(bad);
  let crashed = '';
  for (let i = 0; i < junk.length; i++) {
    const s = structuredClone(s0);
    player(s, me).orders = [junk[i]];
    player(s, 'HELANG').orders = junk;
    player(s, 'JERUNG').orders = 'nonsense' as unknown as Order[];
    try {
      const { state } = resolveRound(s);
      if (REGION_IDS.some((r) => !(state.map[r].troops >= 1)) || Object.keys(state.map).length !== REGION_IDS.length) crashed = `board corrupted by ${JSON.stringify(junk[i])}`;
    } catch (e) {
      crashed = `${JSON.stringify(junk[i])}: ${(e as Error).message}`;
    }
  }
  check(!crashed, `resolveRound skips unvalidated junk orders${crashed ? ` — ${crashed}` : ''}`);
  const over = { ...structuredClone(s0), phase: 'GAME_OVER' as const };
  let guarded = false;
  try {
    resolveRound(over);
  } catch (e) {
    guarded = e instanceof IllegalAction;
  }
  check(guarded, 'resolveRound refuses a finished game');
  let refused = false;
  try {
    submitOrders(over, me, [dep()]);
  } catch (e) {
    refused = e instanceof IllegalAction;
  }
  check(refused, 'orders are refused once the game is over');
}

// --- regression scenarios --------------------------------------------------
section('regression scenarios');
/** A bare board: Shark holds everything with one troop, Lion and Eagle a token region each, no fleets. */
function bare(): GameState {
  const s = newGame({ human: 'SINGA', factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 1 });
  for (const r of REGION_IDS) s.map[r] = { owner: 'JERUNG', troops: 1, unit: 'x' };
  s.map['tuas'] = { owner: 'SINGA', troops: 1, unit: 'bank' };
  s.map['changi'] = { owner: 'HELANG', troops: 1, unit: 'bank' };
  s.ships = [];
  return s;
}
/** Resolve with these orders set directly (no deploy needed — scenarios test the resolver). */
function go(s: GameState, orders: Partial<Record<FactionId, Order[]>>) {
  for (const f of alive(s)) player(s, f).orders = orders[f] ?? [];
  return resolveRound(s);
}
const battleAt = (rep: RoundReport, region: string) => rep.steps.find((x): x is Extract<ReportStep, { kind: 'BATTLE' }> => x.kind === 'BATTLE' && x.region === region);
const X = 'ang-mo-kio', Y = nb(X)[0];
const Z = nb(Y).find((r) => r !== X && !nb(X).includes(r) && r !== 'tuas' && r !== 'changi')!;
const W = nb(X).find((r) => r !== Y && !nb(Y).includes(r) && r !== 'tuas' && r !== 'changi')!;
check(!!(Z && W), `scenario regions: ${X}, ${Y}, ${Z}, ${W}`);
{
  // QA-04: two attackers tie for strongest — seat order must not matter; they bounce and the defender holds.
  const perms: FactionId[][] = [];
  const fs: FactionId[] = ['SINGA', 'HELANG', 'JERUNG'];
  for (const a of fs) for (const b of fs) for (const c of fs) if (new Set([a, b, c]).size === 3) perms.push([a, b, c]);
  const tie = perms.map((order) => {
    const s = bare();
    s.factions = order;
    s.map[X] = { owner: 'SINGA', troops: 6, unit: 'a' };
    s.map[Z] = { owner: 'HELANG', troops: 6, unit: 'b' };
    const { report, state } = go(s, { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 5 }], HELANG: [{ kind: 'MOVE', from: Z, to: Y, count: 5 }] });
    const bt = battleAt(report, Y)!;
    return `${bt.winner}/${bt.bounced ? 'bounced' : '-'}/${state.map[Y].owner}/${state.map[X].troops}/${state.map[Z].troops}`;
  });
  check(new Set(tie).size === 1 && tie[0].startsWith('JERUNG/bounced/JERUNG'), `tied attackers bounce in all 6 seat orders (${tie[0]})`);
  const edge = perms.map((order) => {
    const s = bare();
    s.factions = order;
    s.map[X] = { owner: 'SINGA', troops: 7, unit: 'a' };
    s.map[Z] = { owner: 'HELANG', troops: 6, unit: 'b' };
    const { report } = go(s, { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 6 }], HELANG: [{ kind: 'MOVE', from: Z, to: Y, count: 5 }] });
    return battleAt(report, Y)!.winner;
  });
  check(edge.every((w) => w === 'SINGA'), 'the strictly strongest attacker wins whatever the seat order');
}
{
  // QA-03: beaten attackers whose home was captured meanwhile.
  const setup = () => {
    const s = bare();
    s.map[X] = { owner: 'SINGA', troops: 6, unit: 'a' };
    s.map[Y] = { owner: 'HELANG', troops: 9, unit: 'b' };
    s.map[W] = { owner: 'JERUNG', troops: 6, unit: 'c' };
    return s;
  };
  const orders = { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 5 } as Order], JERUNG: [{ kind: 'MOVE', from: W, to: X, count: 5 } as Order] };
  const lost = go(setup(), orders);
  const failed = lost.report.steps.find((x) => x.kind === 'FAILED' && x.owner === 'SINGA');
  check(lost.state.map[X].owner === 'JERUNG' && !!failed && failed.kind === 'FAILED' && /2 troops of Task Force Lion were cut off at .* and surrendered/.test(failed.text), `with nowhere to go, retreating troops surrender — and the report says so ("${failed && failed.kind === 'FAILED' ? failed.text : ''}")`);
  const V = nb(Y).find((r) => r !== X && r !== W && !nb(W).includes(r))!;
  const s = setup();
  s.map[V] = { owner: 'SINGA', troops: 1, unit: 'v' };
  const saved = go(s, orders);
  check(saved.state.map[V].troops === 3 && !saved.report.steps.some((x) => x.kind === 'FAILED'), 'they fall back to other ground of theirs next to the fight instead');
}
{
  // GD-03: a beaten defender keeps half and falls back next door.
  const setup = () => {
    const s = bare();
    s.map[X] = { owner: 'SINGA', troops: 11, unit: 'a' };
    s.map[Y] = { owner: 'HELANG', troops: 5, unit: 'b' };
    return s;
  };
  const U = nb(Y).find((r) => r !== X && !nb(X).includes(r))!;
  const s = setup();
  s.map[U] = { owner: 'HELANG', troops: 1, unit: 'u' };
  const { report, state } = go(s, { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 10 }] });
  const bt = battleAt(report, Y)!;
  check(bt.captured && bt.fallback?.to === U && bt.fallback.count === 2 && state.map[U].troops === 3, `a beaten defender of 5 falls back with 2 (${JSON.stringify(bt.fallback)})`);
  const alone = go(setup(), { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 10 }] });
  check(!battleAt(alone.report, Y)!.fallback && alone.report.steps.some((x) => x.kind === 'FAILED' && x.owner === 'HELANG' && x.text.includes('surrendered')), 'a defender with no ground next door is lost, and the report says so');
}
{
  // GD-06: splitting a column into 1-troop orders buys nothing.
  const outcome = (split: boolean) => {
    const s = bare();
    s.map[X] = { owner: 'SINGA', troops: 8, unit: 'a' };
    s.map[Y] = { owner: 'HELANG', troops: 5, unit: 'b' };
    const h: Order[] = split ? [1, 1, 1, 1].map(() => ({ kind: 'MOVE', from: Y, to: X, count: 1 })) : [{ kind: 'MOVE', from: Y, to: X, count: 4 }];
    const { report, state } = go(s, { SINGA: [{ kind: 'MOVE', from: X, to: Y, count: 7 }], HELANG: h });
    return JSON.stringify([state.map[X], state.map[Y], report.steps.filter((x) => x.kind === 'CLASH').length]);
  };
  check(outcome(true) === outcome(false), 'four 1-troop columns fight exactly like one 4-troop column');
}
{
  // GD-08: a landing trimmed because a raider sank a ship is reported with numbers.
  const s = bare();
  s.map['lim-chu-kang'] = { owner: 'SINGA', troops: 8, unit: 'a' };
  s.map['jurong-island'] = { owner: 'HELANG', troops: 1, unit: 'b' };
  s.ships = [
    { id: 'S1', name: 's1', owner: 'SINGA', zone: 'WEST', repair: 0 },
    { id: 'S2', name: 's2', owner: 'SINGA', zone: 'WEST', repair: 0 },
    { id: 'H1', name: 'h1', owner: 'HELANG', zone: 'SOUTH', repair: 0 },
  ];
  const { report } = go(s, { SINGA: [{ kind: 'LAND', from: 'lim-chu-kang', to: 'jurong-island', zone: 'WEST', count: 6 }], HELANG: [{ kind: 'SAIL', ship: 'H1', to: 'WEST' }] });
  const f = report.steps.find((x) => x.kind === 'FAILED');
  const mv = report.steps.find((x) => x.kind === 'MOVES');
  check(!!f && f.kind === 'FAILED' && f.text.includes('room for only 3 of 6 troops') && mv?.kind === 'MOVES' && mv.moves[0].count === 3, `a landing cut down for lack of ships says so ("${f && f.kind === 'FAILED' ? f.text : ''}")`);
}
{
  // ARC-02: a landing planned on a ship that is then sailed away is flagged.
  const s = bare();
  s.map['lim-chu-kang'] = { owner: 'SINGA', troops: 8, unit: 'a' };
  s.ships = [{ id: 'S1', name: 's1', owner: 'SINGA', zone: 'WEST', repair: 0 }];
  const land: Order = { kind: 'LAND', from: 'lim-chu-kang', to: 'jurong-island', zone: 'WEST', count: 3 };
  const draft: Order[] = [{ kind: 'DEPLOY', region: 'tuas', count: budget(s, 'SINGA').troops }, land];
  const sum = planSummary(s, 'SINGA', draft);
  check(orderIssues(s, 'SINGA', draft).every((x) => x === null) && sum.liftLeft('WEST') === 0 && sum.liftLeft('WEST', land) === 3 && sum.available('lim-chu-kang') === 4 && sum.available('lim-chu-kang', 1) === 7, 'planSummary: lift and availability, with and without the order being edited');
  const sailed = [...draft, { kind: 'SAIL', ship: 'S1', to: SEA_ZONES.WEST.neighbours[0] } as Order];
  const issues = orderIssues(s, 'SINGA', sailed);
  check(issues[1] !== null && issues[2] === null && validateOrders(s, 'SINGA', sailed) === issues[1] && planSummary(s, 'SINGA', sailed).shipsIn('WEST') === 0, `sailing the only ship away flags the landing ("${issues[1]}")`);
}

// --- order checks agree with validation (ARC-02) ---------------------------
section('order checks');
function randomOrders(s: GameState, me: FactionId, junk: boolean): Order[] {
  const mine = regionsOf(s, me);
  const out: Order[] = [];
  const b = budget(s, me).troops;
  // Mostly a full deployment, sometimes split, sometimes short.
  const split = Math.floor(rnd() * (b + 1));
  out.push({ kind: 'DEPLOY', region: pick(mine), count: rnd() < 0.85 ? b - split || b : b + 1 });
  if (split && split < b) out.push({ kind: 'DEPLOY', region: pick(mine), count: split });
  const n = Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const from = rnd() < 0.9 ? pick(mine) : pick(REGION_IDS);
    const k = rnd();
    if (junk && k < 0.08) out.push(pick([null, 'x', { kind: 'NUKE' }, { kind: 'MOVE', from, to: '__proto__', count: 1 }, { kind: 'STRIKE', region: 'atlantis' }]) as unknown as Order);
    else if (k < 0.45) out.push({ kind: 'MOVE', from, to: pick(nb(from)), count: 1 + Math.floor(rnd() * 5) });
    else if (k < 0.62) out.push({ kind: 'LAND', from, to: pick(REGION_IDS), zone: pick(ZONE_IDS), count: 1 + Math.floor(rnd() * 5) });
    else if (k < 0.75) {
      const sh = s.ships.filter((x) => x.owner === me && x.zone);
      if (sh.length) {
        const x = pick(sh);
        out.push({ kind: 'SAIL', ship: x.id, to: pick(SEA_ZONES[x.zone!].neighbours) });
      }
    } else if (k < 0.88) out.push({ kind: 'STRIKE', region: pick(REGION_IDS) });
    else out.push({ kind: 'CAS', region: pick(REGION_IDS) });
  }
  return out;
}
{
  let sets = 0, valid = 0, disagree = 0, summaryWrong = 0, threw = 0, botIssues = 0;
  for (let g = 0; g < 30; g++) {
    let s = newGame({ human: null, factions: lineup(g), seed: 500 + g });
    while (s.phase === 'PLANNING') {
      for (const f of alive(s)) {
        for (let k = 0; k < 6; k++) {
          const orders = randomOrders(s, f, k % 3 === 0);
          sets++;
          try {
            const v = validateOrders(s, f, orders);
            const issues = orderIssues(s, f, orders);
            const sum = planSummary(s, f, orders);
            if ((v === null) !== (issues.every((x) => x === null) && sum.deployLeft === 0)) disagree++;
            if (v !== null) continue;
            valid++;
            // Spend exactly what's available from a front region: fine; one more: flagged.
            const r = orders.find((o): o is Extract<Order, { kind: 'MOVE' }> => o.kind === 'MOVE')?.from ?? regionsOf(s, f)[0];
            const left = sum.available(r);
            const to = nb(r)[0];
            const more = (count: number) => orderIssues(s, f, [...orders, { kind: 'MOVE', from: r, to, count }]).at(-1);
            if ((left > 0 && more(left) !== null) || more(left + 1) === null) summaryWrong++;
            orders.forEach((o, i) => {
              if ((o.kind === 'MOVE' || o.kind === 'LAND') && sum.available(o.from, i) < o.count) summaryWrong++;
            });
          } catch {
            threw++;
          }
        }
        const plan = botPlan(() => s, f, (x) => (s = x));
        if (orderIssues(s, f, plan).some((x) => x !== null)) botIssues++;
        s = submitOrders(s, f, plan);
      }
      s = resolveRound(s).state;
    }
  }
  check(threw === 0, `order checks never throw (${sets} random order sets, a third with junk in)`);
  check(disagree === 0 && valid > 50, `validateOrders is null exactly when every orderIssues entry is null and deploy is complete (${valid} valid, ${disagree} disagreements)`);
  check(summaryWrong === 0, `planSummary.available matches what validation allows (${summaryWrong} mismatches)`);
  check(botIssues === 0, 'bot plans never carry a flagged order');
}

// --- picker estimate (GD-02) -----------------------------------------------
section('defence estimate');
{
  // With fleets held in port, every non-air bonus a defender gets must be
  // visible in defenceEstimate beforehand.
  let checked = 0, wrong = 0, airWrong = 0;
  for (let g = 0; g < 40; g++) {
    let s = newGame({ human: null, factions: lineup(g), seed: 800 + g });
    while (s.phase === 'PLANNING') {
      for (const f of alive(s)) {
        // Keep the fleet in port, and drop the landings that needed it to sail.
        const plan = botPlan(() => s, f, (x) => (s = x)).filter((o) => o.kind !== 'SAIL');
        const issues = orderIssues(s, f, plan);
        s = submitOrders(s, f, plan.filter((_, i) => issues[i] === null));
      }
      const before = s;
      const { state, report } = resolveRound(s);
      s = state;
      if (report.steps.some((x) => x.kind === 'NAVAL')) continue;
      for (const st of report.steps) {
        if (st.kind !== 'BATTLE' || !st.defender) continue;
        const est = defenceEstimate(viewFor(before, st.attackers[0].owner), st.region);
        const sum = (bs: { label: string; n: number }[]) => bs.reduce((n, b) => n + b.n, 0);
        checked++;
        if (sum(est.bonuses) !== sum(st.defender.bonuses.filter((b) => b.label !== 'Air support'))) wrong++;
        const air = st.defender.bonuses.find((b) => b.label === 'Air support');
        if (air && air.n > est.mayAddAir) airWrong++;
      }
    }
  }
  check(checked > 500 && wrong === 0, `defenceEstimate shows every non-air defence bonus (${checked} battles, ${wrong} wrong)`);
  check(airWrong === 0 && defenceEstimate(viewFor(newGame({ human: null, factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 1 }), 'SINGA'), 'changi').mayAddAir === CAS_BONUS, 'its mayAddAir covers the air support defenders actually fly');
}

// --- fog in the report (GD-10) and spectating (QA-02) ----------------------
section('fog in the report');
{
  let steps = 0, hiddenSteps = 0, leaks = 0, missingSelf = 0, viewMismatch = 0;
  for (let g = 0; g < 30; g++) {
    let s = newGame({ human: null, factions: lineup(g), seed: 900 + g });
    while (s.phase === 'PLANNING') {
      for (const f of alive(s)) s = submitOrders(s, f, botPlan(() => s, f, (x) => (s = x)));
      const { state, report } = resolveRound(s);
      s = state;
      for (const f of s.factions) {
        const red = redactReport(report, f);
        for (const st of red.steps) {
          if (st.kind === 'MOVES' && st.moves.some((m) => !m.seen.includes(f))) leaks++;
          if (st.kind === 'FAILED' && st.owner !== f) leaks++;
          if (st.kind !== 'BATTLE' && st.kind !== 'CLASH' && st.kind !== 'STRIKE') continue;
          steps++;
          const involved = st.kind === 'BATTLE' ? [st.defender!.owner, ...st.attackers.map((a) => a.owner)] : st.kind === 'CLASH' ? [st.a.owner, st.b.owner] : [st.by];
          if (involved.includes(f) && !st.seen.includes(f)) missingSelf++;
          if (st.seen.includes(f)) continue;
          hiddenSteps++;
          const numbers = st.kind === 'BATTLE' ? [st.survivors, st.defender!.troops, ...st.attackers.map((a) => a.strength + a.units.length)] : st.kind === 'CLASH' ? [st.a.troops, st.b.troops, st.a.units.length] : [st.killed];
          if (!st.redacted || numbers.some((n) => n !== 0)) leaks++;
        }
        if (s.phase === 'PLANNING' && player(s, f).alive && JSON.stringify(viewFor(s, f).lastReport) !== JSON.stringify(red)) viewMismatch++;
      }
    }
  }
  check(hiddenSteps > 100 && leaks === 0, `redactReport strips every fight a task force had no eyes on (${hiddenSteps} of ${steps} step views hidden, ${leaks} leaks)`);
  check(missingSelf === 0, 'a task force always sees the fights it takes part in');
  check(viewMismatch === 0, "viewFor's lastReport is the redacted report");
}
{
  // QA-02: the human seat is wiped out early; the bots play on to a result, and the dead watch with no fog.
  let s = newGame({ human: 'SINGA', factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 7 });
  const keep = regionsOf(s, 'SINGA')[0];
  const big = nb(keep)[0];
  for (const r of regionsOf(s, 'SINGA')) if (r !== keep) s.map[r].owner = 'JERUNG';
  s.map[keep].troops = 1;
  s.map[big] = { owner: 'HELANG', troops: 30, unit: 'h' };
  const out = go(s, { HELANG: [{ kind: 'MOVE', from: big, to: keep, count: 25 }] });
  s = out.state;
  check(!player(s, 'SINGA').alive && s.phase === 'PLANNING', 'the human seat can be eliminated while the game goes on');
  const ghost = viewFor(s, 'SINGA');
  check(REGION_IDS.every((r) => ghost.map[r].intel.kind === 'exact'), 'a wiped-out task force spectates with exact intel everywhere');
  let n = 0;
  while (s.phase === 'PLANNING' && n++ < MAX_ROUNDS + 2) {
    for (const f of alive(s)) s = submitOrders(s, f, botPlan(() => s, f, (x) => (s = x)));
    s = resolveRound(s).state;
  }
  check(s.phase === 'GAME_OVER' && !!s.winner && s.winner !== 'SINGA' && s.round <= MAX_ROUNDS, `the bots finish the game alone (${s.winner} in round ${s.round}: ${s.winReason})`);
}

// --- engine fuzz (invariants) ----------------------------------------------
section('engine fuzz');
{
  const fails: string[] = [];
  let games = 0, rounds = 0, botInvalid = 0;
  const levels: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];
  const modes = ['bot', 'passive', 'random', 'hostile'] as const;
  for (let i = 0; i < 160; i++) {
    const facs = [...FACTION_IDS].sort(() => rnd() - 0.5).slice(0, 3 + (i % 2));
    const human = facs[0];
    const mode = modes[i % modes.length];
    const level = levels[i % 3];
    let s = newGame({ human, factions: facs, seed: Math.floor(rnd() * 2 ** 31), handicaps: Object.fromEntries(facs.slice(1).map((f) => [f, LEVEL_HANDICAP[level]])) });
    games++;
    while (s.phase === 'PLANNING' && s.round <= MAX_ROUNDS + 2) {
      const prev = s;
      for (const f of alive(s)) {
        if (f === human && mode !== 'bot') {
          const fallback: Order[] = [{ kind: 'DEPLOY', region: regionsOf(s, f)[0], count: budget(s, f).troops }];
          const orders = mode === 'passive' ? fallback : randomOrders(s, f, mode === 'hostile');
          if (mode === 'hostile') {
            // Bypass validation entirely: the resolver must cope on its own.
            s = structuredClone(s);
            player(s, f).orders = orders;
          } else s = submitOrders(s, f, validateOrders(s, f, orders) ? fallback : orders);
          continue;
        }
        const plan = botPlan(() => s, f, (x) => (s = x), level);
        try {
          s = submitOrders(s, f, plan);
        } catch (e) {
          botInvalid++;
          fails.push(`bot ${f}: ${(e as Error).message}`);
          s = submitOrders(s, f, [{ kind: 'DEPLOY', region: regionsOf(s, f)[0], count: budget(s, f).troops }]);
        }
      }
      try {
        const next = resolveRound(s).state;
        rounds++;
        const live = new Set(alive(next));
        for (const r of REGION_IDS) {
          const h = next.map[r];
          if (!live.has(h.owner)) fails.push(`${r} held by a dead or unknown task force`);
          if (!(h.troops >= 1) || !Number.isInteger(h.troops)) fails.push(`${r} has ${h.troops} troops`);
        }
        if (Object.keys(next.map).length !== REGION_IDS.length) fails.push('the board grew extra keys');
        for (const sh of next.ships) if ((sh.zone !== null && !ZONE_IDS.includes(sh.zone as ZoneId)) || !live.has(sh.owner)) fails.push(`bad ship ${sh.id}`);
        for (const f of next.factions) if (player(next, f).vp < player(prev, f).vp || Number.isNaN(player(next, f).vp)) fails.push(`${f} lost VP`);
        for (const f of alive(prev)) if (troopsOf(next, f) > troopsOf(prev, f) + budget(prev, f).troops + 1000) fails.push(`${f} troops inflated`);
        s = next;
      } catch (e) {
        fails.push(`resolveRound threw: ${(e as Error).message}`);
        break;
      }
    }
    if (s.phase !== 'GAME_OVER' || s.round > MAX_ROUNDS) fails.push(`game ${i} did not end by round ${MAX_ROUNDS}`);
  }
  check(!fails.length, `${games} games, ${rounds} rounds with random, passive and hostile human seats: no exceptions, board always valid, VP never falls, every game ends by round ${MAX_ROUNDS}${fails.length ? ` — ${[...new Set(fails)].slice(0, 5).join('; ')}` : ''}`);
  check(botInvalid === 0, 'bots never submit an illegal order set under any difficulty');
}

// --- difficulty (GD-01) ----------------------------------------------------
section('difficulty');
/**
 * A scripted "sensible newcomer": recon the juiciest installation it borders,
 * guard its most threatened one, mass everything else on that target with air
 * support if the sums (read pessimistically) work, and push a second front
 * with what's left.
 */
function sensiblePlayer(get: () => GameState, me: FactionId, set: (x: GameState) => void): Order[] {
  const pess = (v: PlayerView, r: string) => {
    const i = v.map[r].intel;
    return i.kind === 'exact' ? i.troops : i.kind === 'band' ? Math.min(i.max, 12) : 6;
  };
  let v = viewFor(get(), me);
  const mine = REGION_IDS.filter((r) => v.map[r].owner === me);
  const score = (r: string) => (INSTALLATIONS[r] ? 10 : 1) / (pess(v, r) + defenceBonus(r));
  const cands = REGION_IDS.filter((r) => v.map[r].owner !== me && nb(r).some((n) => v.map[n].owner === me)).sort((a, b) => score(b) - score(a));
  if (cands[0] && v.reconsLeft > 0) {
    set(recon(get(), me, cands[0]));
    v = viewFor(get(), me);
  }
  const orders: Order[] = [];
  let troops = v.budget.troops, sorties = v.budget.sorties;
  const avail: Record<string, number> = {};
  for (const r of mine) avail[r] = estimate(v.map[r].intel);
  const kis = mine.filter((r) => INSTALLATIONS[r]);
  const danger = (r: string) => nb(r).filter((n) => v.map[n].owner !== me).reduce((a, n) => a + pess(v, n), 0) - avail[r];
  kis.sort((a, b) => danger(b) - danger(a));
  if (kis[0] && danger(kis[0]) > 0 && Math.floor(troops / 3)) {
    const n = Math.floor(troops / 3);
    orders.push({ kind: 'DEPLOY', region: kis[0], count: n });
    avail[kis[0]] += n;
    troops -= n;
  }
  const t = cands[0];
  if (!t) return [...orders, { kind: 'DEPLOY', region: mine[0], count: troops }];
  const srcs = nb(t).filter((n) => v.map[n].owner === me).sort((a, b) => avail[b] - avail[a]);
  orders.push({ kind: 'DEPLOY', region: srcs[0], count: troops });
  avail[srcs[0]] += troops;
  const keep = (r: string) => (INSTALLATIONS[r] ? 2 : 1);
  const total = srcs.reduce((a, r) => a + Math.max(0, avail[r] - keep(r)), 0);
  if (total + (sorties > 0 ? CAS_BONUS : 0) >= pess(v, t) + defenceBonus(t) + 1) {
    for (const r of srcs) if (avail[r] - keep(r) > 0) orders.push({ kind: 'MOVE', from: r, to: t, count: avail[r] - keep(r) });
    if (sorties > 0) (orders.push({ kind: 'CAS', region: t }), sorties--);
    if (sorties > 0) (orders.push({ kind: 'STRIKE', region: t }), sorties--);
  }
  for (const c of cands.slice(1)) {
    if (!INSTALLATIONS[c]) continue;
    const ss = nb(c).filter((n) => v.map[n].owner === me && !srcs.includes(n));
    if (ss.reduce((a, r) => a + Math.max(0, avail[r] - 1), 0) < pess(v, c) + defenceBonus(c) + 2) continue;
    for (const r of ss) if (avail[r] > 1) orders.push({ kind: 'MOVE', from: r, to: c, count: avail[r] - 1 });
    break;
  }
  for (const c of cands) if (sorties > 0 && !orders.some((o) => o.kind === 'STRIKE' && o.region === c)) (orders.push({ kind: 'STRIKE', region: c }), sorties--);
  return orders;
}
{
  // Two stand-ins for a human in seat 0 — a REGULAR bot with no handicap, and
  // the scripted newcomer — against bots at each level with its handicap.
  const G = 200;
  const levels: BotLevel[] = ['RECRUIT', 'REGULAR', 'VETERAN'];
  const proxies: [string, (get: () => GameState, f: FactionId, set: (x: GameState) => void) => Order[]][] = [
    ['REGULAR bot', (get, f, set) => botPlan(get, f, set, 'REGULAR')],
    ['scripted newcomer', sensiblePlayer],
  ];
  const rate: Record<string, Record<BotLevel, number>> = {};
  let proxyIllegal = 0;
  for (const [name, proxy] of proxies) {
    rate[name] = { RECRUIT: 0, REGULAR: 0, VETERAN: 0 };
    for (const level of levels) {
      let wins = 0;
      for (let g = 0; g < G; g++) {
        const fs = lineup(g);
        const hero = fs[0];
        let s = newGame({ human: hero, factions: fs, seed: 9000 + g, handicaps: Object.fromEntries(fs.slice(1).map((f) => [f, LEVEL_HANDICAP[level]])) });
        while (s.phase === 'PLANNING') {
          for (const f of alive(s)) {
            const orders = f === hero ? proxy(() => s, f, (x) => (s = x)) : botPlan(() => s, f, (x) => (s = x), level);
            if (f === hero && validateOrders(s, f, orders)) proxyIllegal++;
            s = submitOrders(s, f, orders);
          }
          s = resolveRound(s).state;
        }
        if (s.winner === hero) wins++;
      }
      rate[name][level] = (wins / G) * 100;
    }
    const r = rate[name];
    console.log(`  ${name.padEnd(18)} wins ${levels.map((l) => `${r[l].toFixed(1)}% vs ${l} (${LEVEL_HANDICAP[l] > 0 ? '+' : ''}${LEVEL_HANDICAP[l]})`).join(', ')} — ${G} games each`);
    check(r.RECRUIT - r.REGULAR >= 8 && r.REGULAR - r.VETERAN >= 8, `${name}: each difficulty step costs at least 8 points of win rate`);
  }
  check(proxyIllegal === 0, 'the stand-ins only ever submit legal orders');
  const mean = (l: BotLevel) => proxies.reduce((n, [name]) => n + rate[name][l], 0) / proxies.length;
  check(
    mean('RECRUIT') >= 42 && mean('RECRUIT') <= 55 && mean('REGULAR') >= 25 && mean('REGULAR') <= 36 && mean('VETERAN') >= 12 && mean('VETERAN') <= 22,
    `win rates sit near the 45–50 / 28–33 / 15–20% targets (mean of the stand-ins ${levels.map((l) => mean(l).toFixed(1)).join(' / ')})`,
  );
}

// --- sim -------------------------------------------------------------------
function playGame(factions: FactionId[], seed: number, level: BotLevel) {
  let s: GameState = newGame({ human: null, factions, seed });
  let illegal = 0, landings = 0, sails = 0, fallbacks = 0;
  const kinds: Record<string, number> = {};
  while (s.phase !== 'GAME_OVER' && s.round <= MAX_ROUNDS + 1) {
    for (const f of alive(s)) {
      const orders = botPlan(() => s, f, (x) => (s = x), level);
      for (const o of orders) {
        if (o.kind === 'LAND') landings++;
        if (o.kind === 'SAIL') sails++;
      }
      try {
        s = submitOrders(s, f, orders);
      } catch (e) {
        illegal++;
        if (illegal < 4) console.log('illegal', f, (e as Error).message);
        s = submitOrders(s, f, orders.filter((o) => o.kind === 'DEPLOY'));
      }
    }
    if (!allReady(s)) break;
    const res = resolveRound(s);
    s = res.state;
    for (const st of res.report.steps) {
      kinds[st.kind] = (kinds[st.kind] ?? 0) + 1;
      if (st.kind === 'BATTLE' && st.fallback) fallbacks++;
    }
  }
  return { s, illegal, kinds, landings, sails, fallbacks };
}

section('balance and pacing sim');
const GAMES = Number(process.argv[2] ?? 1000);
const started = Date.now();
const wins: Record<string, number> = {};
const fair: Record<string, number> = {};
const reasons: Record<string, number> = {};
let illegal = 0, finished = 0, rounds = 0, landings = 0, sails = 0, eliminations = 0, fallbacks = 0, battles = 0, captures = 0;
const kinds: Record<string, number> = {};
for (let g = 0; g < GAMES; g++) {
  const factions = lineup(g);
  for (const f of factions) fair[f] = (fair[f] ?? 0) + 1 / factions.length;
  const r = playGame(factions, 7000 + g, 'REGULAR');
  illegal += r.illegal;
  landings += r.landings;
  sails += r.sails;
  fallbacks += r.fallbacks;
  rounds += r.s.round;
  battles += r.s.stats.battles;
  captures += r.s.stats.captures;
  for (const [k, v] of Object.entries(r.kinds)) kinds[k] = (kinds[k] ?? 0) + v;
  eliminations += factions.filter((f) => !player(r.s, f).alive).length;
  if (r.s.winner) {
    finished++;
    wins[r.s.winner] = (wins[r.s.winner] ?? 0) + 1;
    const key = r.s.winReason!.startsWith('first') ? 'reached VP target' : r.s.winReason!.startsWith('last') ? 'last standing' : 'clock';
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
}

const per = (k: string) => ((kinds[k] ?? 0) / rounds).toFixed(2);
console.log(`${GAMES} games (3–4 bots each, REGULAR) in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`finished ${finished}, illegal order sets ${illegal}, rounds per game ${(rounds / GAMES).toFixed(1)}`);
console.log(`per round: battles ${per('BATTLE')}, clashes ${per('CLASH')}, naval battles ${per('NAVAL')}, strikes ${per('STRIKE')}, setbacks reported ${per('FAILED')}, defenders falling back ${(fallbacks / rounds).toFixed(2)}`);
console.log(`attacks that capture ${((captures / battles) * 100).toFixed(0)}%`);
console.log(`landings ordered per game ${(landings / GAMES).toFixed(1)}, sail orders per game ${(sails / GAMES).toFixed(1)}, eliminations per game ${(eliminations / GAMES).toFixed(2)}`);
console.log('win reasons', reasons);
const share = (f: string) => (wins[f] ?? 0) / fair[f];
for (const f of FACTION_IDS) console.log(`  ${f.padEnd(8)} won ${wins[f] ?? 0} — ${share(f).toFixed(2)}× its fair share`);

check(illegal === 0, 'bots never submit an illegal order set');
check(finished === GAMES, 'every game reaches a winner');
check((kinds.BATTLE ?? 0) / rounds >= 3, 'at least three battles every round on average');
check((reasons['reached VP target'] ?? 0) / GAMES >= 0.85, 'at least 85% of games end on the VP target, not the clock');
check(rounds / GAMES <= 11, 'games last 11 rounds or fewer on average');
check(landings / GAMES >= 1 && (kinds.NAVAL ?? 0) > 0, 'the fleet matters: landings are made and fleets do fight');
check(FACTION_IDS.every((f) => share(f) >= 0.8 && share(f) <= 1.2), 'every Pasukan wins within 0.8–1.2× its fair share');
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
