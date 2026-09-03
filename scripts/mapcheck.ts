// ============================================================================
// COMMAND — map-generation soak test.
//   npx tsx scripts/mapcheck.ts [count]
// Generates N battlefields from independent seeds and asserts every invariant
// the game depends on: navigable-water connectivity, land reachability, river
// continuity, road connectivity and the absence of terrain speckle.
// ============================================================================

import { generateBattlefield, validateMap, MapDiagnostics } from '../src/game/mapgen';
import { SCENARIOS } from '../src/game/scenarios';
import { GRID_SIZE, PlayerId, Tile } from '../src/game/types';

const COUNT = Number(process.argv[2] ?? 60);
const N = GRID_SIZE;
const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;
const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

let pass = 0;
const failures: string[] = [];
const stats: MapDiagnostics[] = [];
let genMs = 0;

/** Shared per-seed validation body — used for both the random soak and the curated pool below. */
function checkSeed(seed: number, label: string): boolean {
  try {
    const t0 = Date.now();
    const map = generateBattlefield(seed);
    genMs += Date.now() - t0;
    stats.push(map.diagnostics);
    const errs: string[] = [...validateMap(map).errors];

    const reach = navalReachability(map.tiles, map.navalSpawns.SABRE[0]);
    (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((side) => {
      map.navalSpawns[side].forEach((s) => {
        if (!reach.has(s.y * N + s.x)) errs.push(`${side} naval spawn (${s.x},${s.y}) unreachable by sea`);
      });
    });
    map.objectives.filter((o) => o.maritime).forEach((o) => {
      if (!reach.has(o.y * N + o.x)) errs.push(`maritime objective ${o.name} unreachable by sea`);
    });
    for (const p of map.ports) {
      const berth = N4.some(([dx, dy]) => inB(p.x + dx, p.y + dy) && reach.has((p.y + dy) * N + (p.x + dx)));
      if (!berth) errs.push(`port (${p.x},${p.y}) unreachable by sea`);
    }
    if (map.objectives.length < 12) errs.push(`only ${map.objectives.length} objectives`);

    (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((side) => {
      if (map.startZones[side].length < 10) errs.push(`${side} deployment zone seats only ${map.startZones[side].length} land formations (need >= 10)`);
    });

    if (errs.length) {
      failures.push(`${label} (seed ${seed}): ${errs.join(' | ')}`);
      return false;
    }
    pass++;
    return true;
  } catch (e) {
    failures.push(`${label} (seed ${seed}): THREW ${(e as Error).message.split('\n')[0]}`);
    return false;
  }
}

/** Independent re-derivation of the naval reachability claim (not the generator's own). */
function navalReachability(tiles: Tile[][], from: { x: number; y: number }): Set<number> {
  const seen = new Set<number>();
  const q = [from.y * N + from.x];
  seen.add(q[0]);
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cx = cur % N;
    const cy = (cur / N) | 0;
    for (const [dx, dy] of N4) {
      if (!inB(cx + dx, cy + dy)) continue;
      const j = (cy + dy) * N + (cx + dx);
      if (seen.has(j)) continue;
      if (tiles[cy + dy][cx + dx].terrain !== 'WATER') continue;
      seen.add(j);
      q.push(j);
    }
  }
  return seen;
}

for (let i = 0; i < COUNT; i++) {
  checkSeed(100000 + i * 7919, 'random');
}

const randomPass = pass;
const avg = (f: (d: MapDiagnostics) => number) =>
  stats.length ? Math.round((stats.reduce((s, d) => s + f(d), 0) / stats.length) * 10) / 10 : 0;

console.log(`\nCOMMAND map soak — ${COUNT} random seeds on a ${N}x${N} grid`);
console.log(`  pass:   ${randomPass}/${COUNT}  (${((randomPass / COUNT) * 100).toFixed(1)}%)`);
console.log(`  gen time: ${(genMs / COUNT).toFixed(0)} ms/map avg`);
console.log(`  avg attempts/map:  ${avg((d) => d.attempts)}`);
console.log(`  avg water tiles:   ${avg((d) => d.waterTiles)} (navigable ${avg((d) => d.navigableTiles)})`);
console.log(`  avg pools discarded: ${avg((d) => d.waterBodiesDiscarded)}`);
console.log(`  avg river tiles:   ${avg((d) => d.riverTiles)}`);
console.log(`  avg road tiles:    ${avg((d) => d.roadTiles)}  bridges ${avg((d) => d.bridgeTiles)}`);
console.log(`  avg forest tiles:  ${avg((d) => d.forestTiles)}  urban ${avg((d) => d.urbanTiles)}`);
console.log(`  avg speckle fixed: ${avg((d) => d.speckleTiles)}`);

// ---------------------------------------------------------------------------
// Phase 11 §1 — the ten curated, named scenario maps. Every one of these
// ships to real matches (see scenarios.ts / server room creation), so they
// are validated explicitly here rather than only hoping they show up in the
// random sample above.
// ---------------------------------------------------------------------------
console.log(`\nCOMMAND curated scenario pool — ${SCENARIOS.length} named maps`);
let curatedPass = 0;
for (const s of SCENARIOS) {
  const ok = checkSeed(s.seed, `scenario "${s.name}"`);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${s.name} (${s.id}, seed ${s.seed})`);
  if (ok) curatedPass++;
}
console.log(`  curated pass: ${curatedPass}/${SCENARIOS.length}`);

if (failures.length) {
  console.log(`\n  FAILURES (${failures.length}):`);
  failures.slice(0, 20).forEach((f) => console.log(`   - ${f}`));
  process.exitCode = 1;
}
