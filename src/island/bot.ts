// ============================================================================
// ISLAND OPS — bot commanders.
//
// Bots plan from a PlayerView — the same fogged picture a human gets — so they
// guess at enemy strength from bands and blanks just like you do. A plan is:
// recon the most valuable unknown, pick the best targets it can afford, mass
// the new troops behind them, back the main push with air, and use the fleet
// to land where the coast is weak.
// ============================================================================

import { BOARD, INSTALLATIONS, REGION_IDS, SEA_ZONES, ZoneId } from './map';
import { controller, defenceBonus, shipCapacity } from './engine';
import { CAS_BONUS, Intel, Order, PlayerView } from './types';

export type BotLevel = 'RECRUIT' | 'REGULAR' | 'VETERAN';

/** Extra strength a bot wants over its estimate of the defence before it commits. */
const MARGIN: Record<BotLevel, number> = { RECRUIT: 3, REGULAR: 2, VETERAN: 1 };

export function estimate(intel: Intel): number {
  if (intel.kind === 'exact') return intel.troops;
  if (intel.kind === 'band') return intel.max >= 99 ? 12 : Math.ceil((intel.min + intel.max) / 2);
  return 4;
}

function value(view: PlayerView, region: string): number {
  const owner = view.map[region].owner;
  const ownerVp = view.players.find((p) => p.id === owner)?.vp ?? 0;
  const leaderVp = Math.max(...view.players.filter((p) => p.alive).map((p) => p.vp));
  let v = INSTALLATIONS[region] ? 6 : 1;
  if (ownerVp === leaderVp && ownerVp > 0) v += 2; // knock the leader back
  return v;
}

/** The region the bot most wants to see before planning, or null. */
export function botRecon(view: PlayerView): string | null {
  if (view.reconsLeft <= 0) return null;
  let best: string | null = null, bestScore = 0;
  for (const r of REGION_IDS) {
    const rv = view.map[r];
    if (rv.owner === view.me || rv.intel.kind === 'exact') continue;
    const touching = BOARD.byId[r].neighbours.some((n) => view.map[n].owner === view.me);
    if (!touching) continue;
    const score = value(view, r) + (rv.intel.kind === 'hidden' ? 2 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

interface Target {
  region: string;
  need: number;
  value: number;
  sources: string[];
}

export function botOrders(view: PlayerView, level: BotLevel = 'REGULAR'): Order[] {
  const me = view.me;
  const orders: Order[] = [];
  const mine = REGION_IDS.filter((r) => view.map[r].owner === me);
  const troops: Record<string, number> = {};
  for (const r of mine) troops[r] = estimate(view.map[r].intel);
  const enemyNear = (r: string) => BOARD.byId[r].neighbours.filter((n) => view.map[n].owner !== me);
  const threat = (r: string) => enemyNear(r).reduce((n, e) => n + estimate(view.map[e].intel), 0);

  // --- targets: enemy regions next to us, best value for the strength needed ---
  const targets: Target[] = [];
  for (const r of REGION_IDS) {
    if (view.map[r].owner === me) continue;
    const sources = BOARD.byId[r].neighbours.filter((n) => view.map[n].owner === me);
    if (!sources.length) continue;
    const need = estimate(view.map[r].intel) + defenceBonus(r) + MARGIN[level];
    targets.push({ region: r, need, value: value(view, r), sources });
  }
  targets.sort((a, b) => b.value / b.need - a.value / a.need);

  // --- deploy: mass behind the best one or two targets, guard threatened installations ---
  let reserve = view.budget.troops;
  const deploy: Record<string, number> = {};
  const add = (r: string, n: number) => {
    deploy[r] = (deploy[r] ?? 0) + n;
    troops[r] += n;
  };
  for (const r of mine) {
    if (!INSTALLATIONS[r] || reserve <= 0) continue;
    const short = threat(r) - (troops[r] + defenceBonus(r));
    if (short > 0) {
      const n = Math.min(reserve, Math.ceil(short / 2));
      add(r, n);
      reserve -= n;
    }
  }
  for (const t of targets.slice(0, 2)) {
    if (reserve <= 0) break;
    const stage = [...t.sources].sort((a, b) => troops[b] - troops[a])[0];
    const n = Math.ceil(reserve * 0.6);
    add(stage, n);
    reserve -= n;
  }
  if (reserve > 0) add(mine.length ? [...mine].sort((a, b) => threat(b) - threat(a))[0] : mine[0], reserve);
  for (const [region, count] of Object.entries(deploy)) orders.push({ kind: 'DEPLOY', region, count });

  // --- air: close support for the main push, strikes on the next targets ---
  let sorties = view.budget.sorties;
  const casOn = new Set<string>();

  // --- marches ---
  const spare = (r: string) => {
    // Installations under threat keep a garrison.
    const keep = INSTALLATIONS[r] ? Math.max(1, Math.ceil(threat(r) / 2)) : 1;
    return Math.max(0, troops[r] - keep);
  };
  const used = new Set<string>();
  for (const t of targets) {
    const sources = t.sources.filter((s) => !used.has(s) && spare(s) > 0);
    const avail = sources.reduce((n, s) => n + spare(s), 0);
    const air = sorties > 0 ? CAS_BONUS : 0;
    if (avail + air < t.need || avail < 2) continue;
    if (avail < t.need) {
      orders.push({ kind: 'CAS', region: t.region });
      casOn.add(t.region);
      sorties--;
    }
    for (const s of sources) {
      const n = spare(s);
      orders.push({ kind: 'MOVE', from: s, to: t.region, count: n });
      troops[s] -= n;
      used.add(s);
    }
  }

  // --- fleet: sail toward the zone with the softest valuable coast, then land there ---
  const myShips = view.ships.filter((sh) => sh.owner === me && sh.zone);
  const zoneScore = (z: ZoneId) =>
    SEA_ZONES[z].coast.reduce((n, r) => (view.map[r].owner === me ? n : n + value(view, r) / (estimate(view.map[r].intel) + 1)), 0);
  for (const ship of myShips) {
    const here = ship.zone!;
    // Go where the coast is softest, but never into a fleet bigger than ours.
    const options = [here, ...SEA_ZONES[here].neighbours].filter(
      (z) => view.ships.filter((sh) => sh.zone === z && sh.owner !== me).length <= myShips.filter((sh) => sh.zone === z).length,
    );
    const best = options.sort((a, b) => zoneScore(b) - zoneScore(a))[0] ?? SEA_ZONES[here].neighbours[0];
    if (best !== here) {
      orders.push({ kind: 'SAIL', ship: ship.id, to: best });
      ship.zone = best;
    }
  }
  for (const z of Object.keys(SEA_ZONES) as ZoneId[]) {
    if (controller(view.ships, z) !== me) continue;
    let capacity = myShips.filter((sh) => sh.zone === z).length * shipCapacity(me);
    const landings = SEA_ZONES[z].coast
      .filter((r) => view.map[r].owner !== me && !orders.some((o) => (o.kind === 'MOVE' || o.kind === 'LAND') && o.to === r))
      .sort((a, b) => value(view, b) / (estimate(view.map[b].intel) + 1) - value(view, a) / (estimate(view.map[a].intel) + 1));
    for (const target of landings) {
      if (capacity < 2) break;
      const need = estimate(view.map[target].intel) + defenceBonus(target) + MARGIN[level];
      const from = SEA_ZONES[z].coast.filter((r) => view.map[r].owner === me && !used.has(r) && spare(r) > 0).sort((a, b) => spare(b) - spare(a))[0];
      if (!from) break;
      const n = Math.min(spare(from), capacity);
      if (n + 1 < need) continue; // + naval gunfire
      orders.push({ kind: 'LAND', from, to: target, zone: z, count: n });
      troops[from] -= n;
      capacity -= n;
      used.add(from);
    }
  }

  // --- leftover sorties: strike what we're attacking, else what threatens us ---
  const attacked = orders.filter((o): o is Extract<Order, { kind: 'MOVE' | 'LAND' }> => o.kind === 'MOVE' || o.kind === 'LAND').map((o) => o.to);
  for (const r of [...new Set(attacked)]) {
    if (sorties <= 0) break;
    if (casOn.has(r)) continue;
    orders.push({ kind: 'STRIKE', region: r });
    sorties--;
  }
  while (sorties > 0) {
    const r = mine.flatMap(enemyNear).sort((a, b) => estimate(view.map[b].intel) - estimate(view.map[a].intel))[0];
    if (!r) break;
    orders.push({ kind: 'STRIKE', region: r });
    sorties--;
  }
  return orders;
}

/** Plan a whole round for a bot: recon first (which changes what it sees), then orders. */
export function planBot(
  getView: () => PlayerView,
  doRecon: (region: string) => void,
  level: BotLevel = 'REGULAR',
): Order[] {
  for (let i = 0; i < 4; i++) {
    const target = botRecon(getView());
    if (!target) break;
    doRecon(target);
  }
  return botOrders(getView(), level);
}

