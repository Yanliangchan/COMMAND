// ============================================================================
// ISLAND OPS — rules checks and a bot-vs-bot balance/pacing sim.
//   npx tsx scripts/islandcheck.ts [games]
//
// Bots plan from fogged PlayerViews exactly as a player would, submit through
// the same validation, and every round resolves through resolveRound. The sim
// gates the things the design promises: lots of fighting every round, games
// that end on points or conquest inside the clock, every service of the fleet
// and air arm actually used, and no Pasukan that dominates.
// ============================================================================

import { BOARD, INSTALLATIONS, REGION_IDS, SEA_ZONES, ZONE_IDS } from '../src/island/map';
import { IllegalAction, allReady, alive, newGame, player, recon, regionsOf, resolveRound, submitOrders, validateOrders, viewFor } from '../src/island/engine';
import { BotLevel, planBot } from '../src/island/bot';
import { FACTION_IDS, FactionId, GameState, MAX_ROUNDS } from '../src/island/types';

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

// --- board -----------------------------------------------------------------
check(BOARD.regions.length === 39, `39 regions (got ${BOARD.regions.length})`);
check(BOARD.regions.every((r) => r.neighbours.every((n) => BOARD.byId[n].neighbours.includes(r.id))), 'adjacency is symmetric');
const seen = new Set([REGION_IDS[0]]);
const queue = [REGION_IDS[0]];
while (queue.length) for (const n of BOARD.byId[queue.pop()!].neighbours) if (!seen.has(n)) (seen.add(n), queue.push(n));
check(seen.size === REGION_IDS.length, 'every region is reachable over land and crossings');
const coastal = BOARD.regions.filter((r) => r.coastal).map((r) => r.id);
const zoned = new Set(ZONE_IDS.flatMap((z) => SEA_ZONES[z].coast));
check(coastal.every((r) => zoned.has(r)) && [...zoned].every((r) => coastal.includes(r)), 'sea zones border exactly the coastal regions');
check(ZONE_IDS.every((z) => SEA_ZONES[z].neighbours.every((n) => SEA_ZONES[n].neighbours.includes(z))), 'sea zone links are symmetric');
check(Object.keys(INSTALLATIONS).every((r) => BOARD.byId[r]), 'every installation is a real region');

// --- setup -----------------------------------------------------------------
for (const n of [3, 4]) {
  const s = newGame({ human: null, factions: FACTION_IDS.slice(0, n), seed: 11 });
  const contiguous = s.factions.every((f) => {
    const mine = regionsOf(s, f);
    const reach = new Set([mine[0]]);
    const q = [mine[0]];
    while (q.length) for (const x of BOARD.byId[q.pop()!].neighbours) if (s.map[x].owner === f && !reach.has(x)) (reach.add(x), q.push(x));
    return reach.size === mine.length;
  });
  const sizes = s.factions.map((f) => regionsOf(s, f).length);
  check(contiguous, `${n} players: every starting territory is one connected piece`);
  check(Math.max(...sizes) - Math.min(...sizes) <= 2, `${n} players: starting territories are even (${sizes.join('/')})`);
}

// --- rules spot checks -----------------------------------------------------
{
  const s = newGame({ human: null, factions: ['SINGA', 'HELANG', 'JERUNG'], seed: 3 });
  const f = 'SINGA' as FactionId;
  check(validateOrders(s, f, []) !== null, 'orders must deploy every new troop');
  const hidden = REGION_IDS.filter((r) => viewFor(s, f).map[r].intel.kind === 'hidden').length;
  check(hidden > 0, `fog: SINGA starts blind to ${hidden} regions`);
  const enemy = REGION_IDS.find((r) => s.map[r].owner !== f && viewFor(s, f).map[r].intel.kind === 'hidden')!;
  const after = recon(s, f, enemy);
  check(viewFor(after, f).map[enemy].intel.kind === 'exact', 'recon reveals exact strength');
  let threw = false;
  try {
    let t = after;
    for (let i = 0; i < 5; i++) t = recon(t, f, enemy);
  } catch (e) {
    threw = e instanceof IllegalAction;
  }
  check(threw, 'recon is limited per round');
}

// --- sim -------------------------------------------------------------------
function playGame(factions: FactionId[], seed: number, level: BotLevel) {
  let s: GameState = newGame({ human: null, factions, seed });
  let illegal = 0;
  const kinds: Record<string, number> = {};
  let landings = 0, sails = 0;
  while (s.phase !== 'GAME_OVER' && s.round <= MAX_ROUNDS + 1) {
    for (const f of alive(s)) {
      const orders = planBot(
        () => viewFor(s, f),
        (r) => (s = recon(s, f, r)),
        level,
      );
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
    for (const st of res.report.steps) kinds[st.kind] = (kinds[st.kind] ?? 0) + 1;
  }
  return { s, illegal, kinds, landings, sails };
}

const GAMES = Number(process.argv[2] ?? 300);
const wins: Record<string, number> = {};
const fair: Record<string, number> = {};
const reasons: Record<string, number> = {};
let illegal = 0, finished = 0, rounds = 0, landings = 0, sails = 0, eliminations = 0;
const kinds: Record<string, number> = {};
for (let g = 0; g < GAMES; g++) {
  const n = 3 + (g % 2);
  const pool = [...FACTION_IDS];
  const factions: FactionId[] = [];
  for (let i = 0; i < n; i++) factions.push(pool.splice((g * 5 + i * 3) % pool.length, 1)[0]);
  for (const f of factions) fair[f] = (fair[f] ?? 0) + 1 / n;
  const r = playGame(factions, 7000 + g, 'REGULAR');
  illegal += r.illegal;
  landings += r.landings;
  sails += r.sails;
  rounds += r.s.round;
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
console.log(`\n${GAMES} games (3–4 bots each, REGULAR)`);
console.log(`finished ${finished}, illegal order sets ${illegal}, rounds per game ${(rounds / GAMES).toFixed(1)}`);
console.log(`per round: battles ${per('BATTLE')}, clashes ${per('CLASH')}, naval battles ${per('NAVAL')}, strikes ${per('STRIKE')}, failed landings ${per('FAILED')}`);
console.log(`landings ordered per game ${(landings / GAMES).toFixed(1)}, sail orders per game ${(sails / GAMES).toFixed(1)}, eliminations per game ${(eliminations / GAMES).toFixed(2)}`);
console.log('win reasons', reasons);
const share = (f: string) => (wins[f] ?? 0) / fair[f];
for (const f of FACTION_IDS) console.log(`  ${f.padEnd(8)} won ${wins[f] ?? 0} — ${share(f).toFixed(2)}× its fair share`);

check(illegal === 0, 'bots never submit an illegal order set');
check(finished === GAMES, 'every game reaches a winner');
check((kinds.BATTLE ?? 0) / rounds >= 3, 'at least three battles every round on average');
check((reasons.clock ?? 0) / GAMES < 0.25, 'most games end before the clock');
check(landings / GAMES >= 1 && (kinds.NAVAL ?? 0) > 0, 'the fleet matters: landings are made and fleets do fight');
check(FACTION_IDS.every((f) => share(f) > 0.75 && share(f) < 1.3), 'every Pasukan wins within 0.75–1.3× its fair share');
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
