// ============================================================================
// ISLAND OPS — board checks and a bot-vs-bot balance/pacing sim.
//   npx tsx scripts/islandcheck.ts [games]
//
// The relaunch targets this sim measures against: a capture every turn,
// several attacks per turn, games that finish, and no faction that dominates.
// ============================================================================

import { BOARD, REGION_IDS } from '../src/island/map';
import { apply, newGame } from '../src/island/engine';
import { botAction } from '../src/island/bot';
import { captureChance } from '../src/island/odds';
import { FACTION_IDS, FactionId } from '../src/island/types';

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

// --- board -----------------------------------------------------------------
check(BOARD.regions.length === 39, `39 regions (got ${BOARD.regions.length})`);
check(BOARD.regions.every((r) => r.neighbours.every((n) => BOARD.byId[n].neighbours.includes(r.id))), 'adjacency is symmetric');
check(BOARD.regions.every((r) => r.neighbours.length >= 2), 'every region has at least two neighbours');
const seen = new Set([REGION_IDS[0]]);
const queue = [REGION_IDS[0]];
while (queue.length) for (const n of BOARD.byId[queue.pop()!].neighbours) if (!seen.has(n)) (seen.add(n), queue.push(n));
check(seen.size === REGION_IDS.length, 'every region is reachable over land and crossings');

// --- rules spot checks -----------------------------------------------------
{
  // Troops are conserved through a full bot game except for dice losses, strikes and new troops.
  let s = newGame({ human: null, factions: ['ARMY', 'NAVY', 'DIS'], seed: 7 });
  let ok = true, emptyAfterCapture = false;
  for (let i = 0; i < 3000 && s.phase !== 'GAME_OVER'; i++) {
    s = apply(s, botAction(s));
    if (REGION_IDS.some((r) => s.map[r].troops < 1)) emptyAfterCapture = true;
    if (s.pendingMove && s.map[s.pendingMove.to].troops !== s.pendingMove.min) ok = false;
  }
  check(!emptyAfterCapture, 'no region ever sits at 0 troops, even mid-capture');
  check(ok, 'a pending move-in already holds its minimum force');
}

// --- odds: the preview must match what the engine actually rolls -----------
{
  // A neighbouring pair; one plain, one stronghold target, at a few strengths.
  const from = 'jurong-west', plain = 'tengah', strong = 'jurong-east';
  const cases: [string, number, number][] = [[plain, 4, 2], [plain, 6, 5], [strong, 5, 3], [strong, 9, 6], [plain, 3, 3]];
  let worst = 0;
  for (const [to, a, d] of cases) {
    const trials = 4000;
    let wins = 0;
    for (let t = 0; t < trials; t++) {
      const s = newGame({ human: null, factions: ['ARMY', 'NAVY', 'DIS'], seed: 90000 + t * 7 });
      const me = s.order[s.turnIndex];
      const foe = s.order.find((f) => f !== me)!;
      s.map[from] = { owner: me, troops: a };
      s.map[to] = { owner: foe, troops: d };
      s.phase = 'ASSAULT';
      s.reserve = 0;
      const after = apply(s, { type: 'ATTACK', from, to, blitz: true });
      if (after.map[to].owner === me) wins++;
    }
    const exact = captureChance(a, d, BOARD.byId[to].stronghold);
    worst = Math.max(worst, Math.abs(wins / trials - exact));
  }
  check(worst < 0.025, `capture odds match 4,000 real engine blitzes per case (worst gap ${(worst * 100).toFixed(1)} pts)`);
  check(Math.abs(captureChance(2, 1, false) - 15 / 36) < 1e-9, 'one die vs one die: attacker wins 15/36');
}

// --- sim -------------------------------------------------------------------
const GAMES = Number(process.argv[2] ?? 300);
const wins: Record<string, number> = {};
const seats: Record<string, number> = {};
const fair: Record<string, number> = {};
let turns = 0, attacks = 0, captures = 0, rounds = 0, finished = 0, timeouts = 0, illegal = 0;
const reasons: Record<string, number> = {};
const turnsPerGame: number[] = [];

for (let g = 0; g < GAMES; g++) {
  const n = 3 + (g % 2);
  const pool = [...FACTION_IDS];
  const factions: FactionId[] = [];
  for (let i = 0; i < n; i++) factions.push(pool.splice((g * 7 + i * 3) % pool.length, 1)[0]);
  factions.forEach((f) => {
    seats[f] = (seats[f] ?? 0) + 1;
    fair[f] = (fair[f] ?? 0) + 1 / n;
  });
  let s = newGame({ human: null, factions, seed: 1000 + g });
  let steps = 0;
  while (s.phase !== 'GAME_OVER' && steps < 20000) {
    try {
      s = apply(s, botAction(s));
    } catch (e) {
      illegal++;
      console.log('illegal', (e as Error).message);
      break;
    }
    steps++;
  }
  if (s.winner) {
    finished++;
    wins[s.winner] = (wins[s.winner] ?? 0) + 1;
    const key = s.winReason!.startsWith('Ops') ? player0(s.winReason!) : s.winReason!.startsWith('last') ? 'last standing' : 'clock';
    reasons[key] = (reasons[key] ?? 0) + 1;
    if (key === 'clock') timeouts++;
  }
  turns += s.stats.turns;
  attacks += s.stats.attacks;
  captures += s.stats.captures;
  rounds += s.round;
  turnsPerGame.push(s.stats.turns);
}
function player0(r: string) {
  return r.includes('Secure') ? 'mission: sectors' : r.includes('Eliminate') ? 'mission: eliminate' : 'mission: regions';
}

turnsPerGame.sort((a, b) => a - b);
console.log(`\n${GAMES} games (3–4 bots each)`);
console.log(`finished ${finished}, illegal actions ${illegal}, decided on the clock ${timeouts}`);
console.log(`dice rolls per turn ${(attacks / turns).toFixed(2)}, captures per turn ${(captures / turns).toFixed(2)}`);
console.log(`rounds per game ${(rounds / GAMES).toFixed(1)}, turns per game median ${turnsPerGame[GAMES >> 1]} (p90 ${turnsPerGame[Math.floor(GAMES * 0.9)]})`);
console.log('win reasons', reasons);
const share = (f: string) => (wins[f] ?? 0) / fair[f];
for (const f of FACTION_IDS)
  console.log(`  ${f.padEnd(9)} won ${wins[f] ?? 0} of ${seats[f]} seats — ${share(f).toFixed(2)}× its fair share`);

check(illegal === 0, 'bots never attempt an illegal action');
check(finished === GAMES, 'every game reaches a winner');
check(captures / turns >= 1, 'at least one capture per turn on average');
check(timeouts / GAMES < 0.05, 'under 5% of games go to the clock');
check(FACTION_IDS.every((f) => share(f) > 0.75 && share(f) < 1.3), 'every faction wins within 0.75–1.3× its fair share');
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
