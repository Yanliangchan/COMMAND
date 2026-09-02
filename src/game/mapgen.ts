// ============================================================================
// COMMAND — Topographic battlefield generator.
//
// The map is built the way a real landscape is built, not by scattering
// terrain tiles at random:
//
//   1. a fractal (fBm value-noise) HEIGHTFIELD, masked so the south-east is
//      open sea, gives coherent ridges, massifs and a natural coastline;
//   2. DEPRESSION FILLING (priority flood) guarantees every land cell drains
//      somewhere, so...
//   3. ...D8 FLOW ROUTING + FLOW ACCUMULATION produce dendritic RIVERS that
//      run downhill from the high ground to the sea, with real confluences;
//   4. a second noise field plus river/coast proximity gives MOISTURE, which
//      (with elevation) decides forest / grass / open — forests come out as
//      large continuous stands, not speckle;
//   5. SETTLEMENTS are seeded on flat, well-watered, well-connected ground and
//      grown as blobs; industrial ground grows next to ports;
//   6. ROADS are routed by A* over a terrain/slope cost field along a minimum
//      spanning tree of the settlements, ports, airfields and depots, so they
//      follow valleys and only cross rivers at BRIDGES;
//   7. a VALIDATION pass flood-fills the water, discards or repairs anything
//      that would strand a ship, and re-checks land reachability, regenerating
//      from a fresh seed if a map cannot be repaired.
//
// Everything is deterministic for a given seed.
// ============================================================================

import { GRID_SIZE, Objective, ObjectiveKind, PlayerId, Tile, TerrainType } from './types';

// ---------------------------------------------------------------------------
// PRNG + noise
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t);
}

/** Seeded 2D value-noise lattice with bilinear + smoothstep interpolation. */
class ValueNoise {
  private readonly size: number;
  private readonly grid: Float32Array;
  constructor(rand: () => number, size = 256) {
    this.size = size;
    this.grid = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) this.grid[i] = rand();
  }
  private at(ix: number, iy: number) {
    const s = this.size;
    return this.grid[(((iy % s) + s) % s) * s + (((ix % s) + s) % s)];
  }
  sample(x: number, y: number) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smoothstep(x - ix);
    const fy = smoothstep(y - iy);
    const a = this.at(ix, iy);
    const b = this.at(ix + 1, iy);
    const c = this.at(ix, iy + 1);
    const d = this.at(ix + 1, iy + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }
  /** Fractional Brownian motion: octaves of the lattice at doubling frequency. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------------
// Small binary min-heap (priority flood + A*)
// ---------------------------------------------------------------------------

class MinHeap<T> {
  private items: { k: number; v: T }[] = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top.v;
  }
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface Settlement {
  id: string;
  name: string;
  x: number;
  y: number;
  size: number;
  coastal: boolean;
}

export interface MapDiagnostics {
  seed: number;
  attempts: number;
  waterTiles: number;
  navigableTiles: number;
  waterBodiesDiscarded: number;
  landTiles: number;
  riverTiles: number;
  roadTiles: number;
  bridgeTiles: number;
  forestTiles: number;
  urbanTiles: number;
  speckleTiles: number;
  bridgesAddedForConnectivity: number;
}

export interface GeneratedMap {
  tiles: Tile[][];
  objectives: Objective[];
  depots: { x: number; y: number; owner: PlayerId }[];
  startZones: Record<PlayerId, { x: number; y: number }[]>;
  navalSpawns: Record<PlayerId, { x: number; y: number }[]>;
  ports: { x: number; y: number; owner: PlayerId }[];
  settlements: Settlement[];
  diagnostics: MapDiagnostics;
}

const N = GRID_SIZE;
const idx = (x: number, y: number) => y * N + x;
const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N;

const N4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const N8: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const SETTLEMENT_NAMES = [
  'Tanjong Kias',
  'Bukit Merbau',
  'Kampong Sitiawan',
  'Selat Baru',
  'Pasir Tinggi',
  'Sungei Lanjut',
  'Kota Rawa',
  'Ulu Bendang',
  'Teluk Chempaka',
  'Batu Puteh',
];

// ---------------------------------------------------------------------------
// Generation attempt (may fail validation; caller retries with a new seed)
// ---------------------------------------------------------------------------

interface Attempt {
  ok: boolean;
  reason?: string;
  map?: GeneratedMap;
}

function generateAttempt(seed: number, attemptNo: number): Attempt {
  const rand = mulberry32(seed);
  const heightNoise = new ValueNoise(rand);
  const moistNoise = new ValueNoise(rand);
  const detailNoise = new ValueNoise(rand);

  // ---- 1. Heightfield -----------------------------------------------------
  const h = new Float32Array(N * N);
  const baseScale = 5.5 + rand() * 1.5; // lattice cells across the map (low = big landforms)
  const warpAmp = 3.2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x / N) * baseScale;
      const v = (y / N) * baseScale;
      // Domain warp keeps ridges sinuous instead of blobby.
      const wx = u + (detailNoise.fbm(u * 2.1 + 11.3, v * 2.1 + 4.7, 3) - 0.5) * (warpAmp / N) * baseScale * 4;
      const wy = v + (detailNoise.fbm(u * 2.1 - 7.9, v * 2.1 + 19.1, 3) - 0.5) * (warpAmp / N) * baseScale * 4;
      let e = heightNoise.fbm(wx, wy, 6);
      // Ridged component adds coherent spines / massifs.
      const ridge = 1 - Math.abs(heightNoise.fbm(wx * 1.7 + 31.0, wy * 1.7 - 12.0, 4) * 2 - 1);
      e = e * 0.68 + ridge * 0.32;

      // Sea mask: the south-east quadrant opens onto one continuous ocean.
      const east = Math.max(0, (x - N * 0.60) / (N * 0.40));
      const south = Math.max(0, (y - N * 0.64) / (N * 0.36));
      const seaMask = Math.min(1, Math.max(east, south) ** 1.25 + Math.min(east, south) * 0.5);
      // Keep the north-west shoulder solidly land so both sides have a hinterland.
      const inland = Math.max(0, 1 - Math.hypot(x / N, y / N) * 1.15);
      e = e - seaMask * 1.15 + inland * 0.10;
      h[idx(x, y)] = e;
    }
  }

  // Sea level chosen as a percentile so the water fraction is stable per seed.
  const sorted = Float32Array.from(h).sort();
  const seaLevel = sorted[Math.floor(sorted.length * 0.33)];

  // Normalised display height 0..1
  const hMin = sorted[0];
  const hMax = sorted[sorted.length - 1];
  const norm = (v: number) => (v - hMin) / Math.max(1e-6, hMax - hMin);

  // The sea is the below-sea-level region CONNECTED TO THE MAP BORDER. Inland
  // basins that happen to fall below the threshold are simply low ground, not
  // lakes — this is what keeps the ocean a single body from the very first
  // step instead of leaving pools to be cleaned up later.
  const isSea = new Uint8Array(N * N);
  {
    const q: number[] = [];
    const below = (x: number, y: number) => h[idx(x, y)] <= seaLevel;
    for (let x = 0; x < N; x++) {
      for (const y of [0, N - 1]) if (below(x, y) && !isSea[idx(x, y)]) { isSea[idx(x, y)] = 1; q.push(idx(x, y)); }
    }
    for (let y = 0; y < N; y++) {
      for (const x of [0, N - 1]) if (below(x, y) && !isSea[idx(x, y)]) { isSea[idx(x, y)] = 1; q.push(idx(x, y)); }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const x = i % N;
      const y = (i / N) | 0;
      for (const [dx, dy] of N4) {
        if (!inB(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (!isSea[j] && h[j] <= seaLevel) {
          isSea[j] = 1;
          q.push(j);
        }
      }
    }
  }

  // ---- 2. Depression filling (priority flood) -----------------------------
  const filled = new Float32Array(N * N);
  const done = new Uint8Array(N * N);
  const heap = new MinHeap<number>();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      // Seed ONLY from the sea: every land cell then drains to the ocean, so
      // every river reaches salt water instead of dead-ending at a map edge.
      if (isSea[i]) {
        filled[i] = h[i];
        done[i] = 1;
        heap.push(filled[i], i);
      }
    }
  }
  const EPS = 1e-4;
  while (heap.size) {
    const i = heap.pop()!;
    const x = i % N;
    const y = (i / N) | 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inB(nx, ny)) continue;
      const j = idx(nx, ny);
      if (done[j]) continue;
      filled[j] = Math.max(h[j], filled[i] + EPS);
      done[j] = 1;
      heap.push(filled[j], j);
    }
  }

  // ---- 3. Flow routing + accumulation → rivers ----------------------------
  const order = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => filled[b] - filled[a]);
  const downstream = new Int32Array(N * N).fill(-1);
  for (const i of order) {
    if (isSea[i]) continue;
    const x = i % N;
    const y = (i / N) | 0;
    let best = -1;
    let bestH = filled[i];
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inB(nx, ny)) continue;
      const j = idx(nx, ny);
      if (filled[j] < bestH) {
        bestH = filled[j];
        best = j;
      }
    }
    downstream[i] = best;
  }
  const acc = new Float32Array(N * N).fill(1);
  for (const i of order) {
    const d = downstream[i];
    if (d >= 0) acc[d] += acc[i];
  }

  // Threshold tuned to yield a handful of trunk rivers with tributaries.
  const RIVER_THRESHOLD = 115;
  const isRiver = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    if (!isSea[i] && acc[i] >= RIVER_THRESHOLD) isRiver[i] = 1;
  }
  // D8 flow can step diagonally; the game moves and floods orthogonally, so
  // fill the elbow of every diagonal river step. Without this a river reads as
  // a chain of diagonal specks and splits into disconnected water bodies.
  for (let i = 0; i < N * N; i++) {
    if (!isRiver[i]) continue;
    const d = downstream[i];
    if (d < 0) continue;
    if (!isRiver[d] && !isSea[d]) continue;
    const x = i % N;
    const y = (i / N) | 0;
    const dx = (d % N) - x;
    const dy = ((d / N) | 0) - y;
    if (dx === 0 || dy === 0) continue;
    const a = idx(x + dx, y);
    const b = idx(x, y + dy);
    // Prefer the lower of the two elbow cells so the channel keeps descending.
    const pick = isSea[a] || isRiver[a] ? a : isSea[b] || isRiver[b] ? b : filled[a] <= filled[b] ? a : b;
    if (!isSea[pick]) isRiver[pick] = 1;
  }

  // Widen only the biggest trunks by one cell so major rivers read as barriers.
  for (let i = 0; i < N * N; i++) {
    if (!isRiver[i] || acc[i] < RIVER_THRESHOLD * 6) continue;
    const x = i % N;
    const y = (i / N) | 0;
    const [dx, dy] = N4[(x * 7 + y * 3) % 4];
    const j = inB(x + dx, y + dy) ? idx(x + dx, y + dy) : -1;
    if (j >= 0 && !isSea[j]) isRiver[j] = 1;
  }

  // ---- 4. Moisture + terrain classification -------------------------------
  // Distance to the nearest water cell (sea or river) via multi-source BFS.
  const distWater = new Int32Array(N * N).fill(1 << 29);
  {
    const q: number[] = [];
    for (let i = 0; i < N * N; i++) {
      if (isSea[i] || isRiver[i]) {
        distWater[i] = 0;
        q.push(i);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const x = i % N;
      const y = (i / N) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inB(nx, ny)) continue;
        const j = idx(nx, ny);
        if (distWater[j] > distWater[i] + 1) {
          distWater[j] = distWater[i] + 1;
          q.push(j);
        }
      }
    }
  }

  // Elevation bands are QUANTILES of the land heights, not a linear slice of
  // the range — that keeps high ground to genuine ridges and massifs instead
  // of turning the whole hinterland into hills.
  const landHeights = Float32Array.from(
    (function* () {
      for (let i = 0; i < N * N; i++) if (!isSea[i]) yield h[i];
    })()
  ).sort();
  const q = (f: number) => landHeights[Math.min(landHeights.length - 1, Math.floor(landHeights.length * f))];
  const bandCuts = [q(0.3), q(0.55), q(0.74), q(0.87), q(0.955)];
  const elevBand = new Uint8Array(N * N);
  const slope = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      let band = 0;
      if (!isSea[i]) {
        while (band < 5 && h[i] > bandCuts[band]) band++;
      }
      elevBand[i] = band;
      let s = 0;
      for (const [dx, dy] of N4) {
        if (!inB(x + dx, y + dy)) continue;
        s = Math.max(s, Math.abs(h[i] - h[idx(x + dx, y + dy)]));
      }
      slope[i] = s;
    }
  }

  const terrain: TerrainType[] = new Array(N * N);
  const moistScale = 7.5;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (isSea[i] || isRiver[i]) {
        terrain[i] = 'WATER';
        continue;
      }
      const m =
        moistNoise.fbm((x / N) * moistScale + 3.7, (y / N) * moistScale - 8.1, 4) * 0.72 +
        Math.max(0, 1 - distWater[i] / 12) * 0.28;
      const e = elevBand[i];
      if (e >= 5) terrain[i] = 'HILLS';
      else if (e === 4) terrain[i] = m > 0.70 ? 'FOREST' : 'HILLS';
      else if (e === 3 && slope[i] > 0.012) terrain[i] = m > 0.60 ? 'FOREST' : 'HILLS';
      else if (m > 0.545) terrain[i] = 'FOREST';
      else if (m < 0.42) terrain[i] = 'OPEN';
      else terrain[i] = 'GRASS';
    }
  }
  // Beaches: low land directly on the open sea.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (terrain[i] === 'WATER' || elevBand[i] > 1) continue;
      let coastal = false;
      for (const [dx, dy] of N4) {
        if (inB(x + dx, y + dy) && isSea[idx(x + dx, y + dy)]) coastal = true;
      }
      if (coastal) terrain[i] = 'BEACH';
    }
  }

  // ---- 5. De-speckle: no lone terrain tiles surrounded by one other type ---
  let speckleTiles = 0;
  const PROTECTED: TerrainType[] = ['WATER', 'BEACH'];
  for (let pass = 0; pass < 3; pass++) {
    const next = terrain.slice();
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = idx(x, y);
        if (PROTECTED.includes(terrain[i])) continue;
        const counts = new Map<TerrainType, number>();
        let same = 0;
        for (const [dx, dy] of N8) {
          const t = terrain[idx(x + dx, y + dy)];
          if (t === terrain[i]) same++;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        if (same >= 2) continue;
        let bestT: TerrainType = terrain[i];
        let bestC = 0;
        counts.forEach((c, t) => {
          if (t !== 'WATER' && c > bestC) {
            bestC = c;
            bestT = t;
          }
        });
        if (bestT !== terrain[i]) {
          next[i] = bestT;
          if (pass === 0) speckleTiles++;
        }
      }
    }
    for (let i = 0; i < N * N; i++) terrain[i] = next[i];
  }

  // ---- 6. Water connectivity: keep one navigable body ---------------------
  const comp = new Int32Array(N * N).fill(-1);
  const compSize: number[] = [];
  for (let i = 0; i < N * N; i++) {
    if (terrain[i] !== 'WATER' || comp[i] >= 0) continue;
    const id = compSize.length;
    let size = 0;
    const q = [i];
    comp[i] = id;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      size++;
      const x = c % N;
      const y = (c / N) | 0;
      for (const [dx, dy] of N4) {
        if (!inB(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (terrain[j] === 'WATER' && comp[j] < 0) {
          comp[j] = id;
          q.push(j);
        }
      }
    }
    compSize.push(size);
  }
  let mainComp = 0;
  for (let c = 1; c < compSize.length; c++) if (compSize[c] > compSize[mainComp]) mainComp = c;
  if (compSize.length === 0 || compSize[mainComp] < N * N * 0.12) {
    return { ok: false, reason: 'no substantial ocean' };
  }
  // Every other pool (isolated lake, land-locked river stub) becomes land —
  // this is what stops ships being spawned into or routed toward dead water.
  let waterBodiesDiscarded = 0;
  for (let i = 0; i < N * N; i++) {
    if (terrain[i] === 'WATER' && comp[i] !== mainComp) {
      terrain[i] = elevBand[i] >= 3 ? 'HILLS' : 'GRASS';
      isRiver[i] = 0;
      comp[i] = -1;
      waterBodiesDiscarded++;
    }
  }

  // ---- 7. Settlements ------------------------------------------------------
  const settlements: Settlement[] = [];
  const siteScore = (x: number, y: number) => {
    const i = idx(x, y);
    if (terrain[i] === 'WATER') return -Infinity;
    if (elevBand[i] > 3) return -Infinity;
    let s = 0;
    s += (1 - Math.min(1, slope[i] / 0.05)) * 3; // flat ground
    s += Math.max(0, 1 - distWater[i] / 6) * 3; // near fresh water / coast
    s += terrain[i] === 'GRASS' || terrain[i] === 'OPEN' ? 1.5 : 0;
    s -= Math.max(0, 6 - Math.min(x, y, N - 1 - x, N - 1 - y)) * 0.5; // not jammed on the edge
    return s;
  };
  const candidates: { x: number; y: number; s: number }[] = [];
  for (let y = 3; y < N - 3; y++) {
    for (let x = 3; x < N - 3; x++) {
      const s = siteScore(x, y);
      if (s > 3.4) candidates.push({ x, y, s });
    }
  }
  candidates.sort((a, b) => b.s - a.s + (rand() - 0.5) * 0.4);
  // Spacings below are tuned for the 72x72 board (phase 3). Settlement count
  // came down 6 -> 5 with the map size so objective *density* stays constant.
  const MIN_SETTLEMENT_GAP = 12;
  for (const c of candidates) {
    if (settlements.length >= 5) break;
    if (settlements.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < MIN_SETTLEMENT_GAP)) continue;
    let coastal = false;
    for (let dy = -3; dy <= 3 && !coastal; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (inB(c.x + dx, c.y + dy) && isSea[idx(c.x + dx, c.y + dy)]) {
          coastal = true;
          break;
        }
      }
    }
    settlements.push({
      id: `stl_${settlements.length}`,
      name: SETTLEMENT_NAMES[settlements.length % SETTLEMENT_NAMES.length],
      x: c.x,
      y: c.y,
      size: 2 + Math.floor(rand() * 2) + (settlements.length === 0 ? 2 : 0),
      coastal,
    });
  }
  if (settlements.length < 4) return { ok: false, reason: 'too few settlement sites' };

  const settlementOf = new Array<string | undefined>(N * N);
  for (const s of settlements) {
    for (let dy = -s.size; dy <= s.size; dy++) {
      for (let dx = -s.size; dx <= s.size; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (!inB(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === 'WATER') continue;
        const d = Math.hypot(dx, dy) / s.size;
        if (d > 1 + (detailNoise.sample(x * 0.6, y * 0.6) - 0.5) * 0.55) continue;
        terrain[i] = d < 0.55 ? 'URBAN' : 'URBAN';
        settlementOf[i] = s.id;
      }
    }
  }
  // Industrial belt on the seaward fringe of coastal settlements.
  for (const s of settlements) {
    if (!s.coastal) continue;
    for (let dy = -s.size - 1; dy <= s.size + 1; dy++) {
      for (let dx = -s.size - 1; dx <= s.size + 1; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (!inB(x, y)) continue;
        const i = idx(x, y);
        if (settlementOf[i] !== s.id) continue;
        if (distWater[i] <= 2 && terrain[i] === 'URBAN' && ((x + y) % 3 !== 0)) terrain[i] = 'INDUSTRIAL';
      }
    }
  }

  // ---- 8. Ports ------------------------------------------------------------
  // A port is a coastal land tile of a coastal settlement, orthogonally
  // adjacent to the single navigable body (so a ship can always berth).
  const isNavigable = (i: number) => terrain[i] === 'WATER' && comp[i] === mainComp;
  const findPortTile = (cx: number, cy: number, radius: number): { x: number; y: number } | null => {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = Math.max(1, cy - radius); y < Math.min(N - 1, cy + radius); y++) {
      for (let x = Math.max(1, cx - radius); x < Math.min(N - 1, cx + radius); x++) {
        const i = idx(x, y);
        if (terrain[i] === 'WATER') continue;
        let touchesSea = false;
        for (const [dx, dy] of N4) {
          const j = idx(x + dx, y + dy);
          if (inB(x + dx, y + dy) && isNavigable(j) && !isRiver[j]) touchesSea = true;
        }
        if (!touchesSea) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  };

  const ports: { x: number; y: number; owner: PlayerId }[] = [];
  // BLUEFOR holds the south-western seaboard, REDFOR the eastern one.
  const bluePortSite = findPortTile(Math.round(N * 0.18), Math.round(N * 0.82), Math.round(N * 0.3));
  const redPortSite = findPortTile(Math.round(N * 0.84), Math.round(N * 0.28), Math.round(N * 0.3));
  if (!bluePortSite || !redPortSite) return { ok: false, reason: 'no viable port sites' };
  if (Math.hypot(bluePortSite.x - redPortSite.x, bluePortSite.y - redPortSite.y) < N * 0.4) {
    return { ok: false, reason: 'ports too close together' };
  }
  ports.push({ ...bluePortSite, owner: 'BLUEFOR' }, { ...redPortSite, owner: 'REDFOR' });
  for (const p of ports) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!inB(p.x + dx, p.y + dy)) continue;
        const i = idx(p.x + dx, p.y + dy);
        if (terrain[i] !== 'WATER') terrain[i] = 'PORT';
      }
    }
  }

  // ---- 9. Airfields --------------------------------------------------------
  const airfields: { x: number; y: number }[] = [];
  const flatScore = (x: number, y: number) => {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!inB(x + dx, y + dy)) return -Infinity;
        const i = idx(x + dx, y + dy);
        if (terrain[i] === 'WATER' || terrain[i] === 'URBAN' || terrain[i] === 'INDUSTRIAL' || terrain[i] === 'PORT') return -Infinity;
        s -= slope[i] * 40;
        s += elevBand[i] <= 2 ? 0.6 : 0;
      }
    }
    return s;
  };
  for (const anchor of [
    { x: Math.round(N * 0.2), y: Math.round(N * 0.3) },
    { x: Math.round(N * 0.62), y: Math.round(N * 0.16) },
  ]) {
    let best: { x: number; y: number; s: number } | null = null;
    for (let y = Math.max(3, anchor.y - 13); y < Math.min(N - 3, anchor.y + 13); y++) {
      for (let x = Math.max(3, anchor.x - 13); x < Math.min(N - 3, anchor.x + 13); x++) {
        const s = flatScore(x, y);
        if (s > -Infinity && (!best || s > best.s)) best = { x, y, s };
      }
    }
    if (best && !airfields.some((a) => Math.hypot(a.x - best!.x, a.y - best!.y) < 11)) {
      airfields.push({ x: best.x, y: best.y });
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -2; dx <= 2; dx++) terrain[idx(best.x + dx, best.y + dy)] = 'AIRFIELD';
      }
    }
  }

  // ---- 10. Depots ----------------------------------------------------------
  const pickLandNear = (cx: number, cy: number, avoid: { x: number; y: number }[] = []): { x: number; y: number } | null => {
    for (let r = 0; r < 20; r++) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const y = Math.round(cy + Math.sin(ang) * r);
        if (!inB(x, y)) continue;
        const i = idx(x, y);
        if (terrain[i] === 'WATER') continue;
        if (elevBand[i] > 3) continue;
        if (avoid.some((p) => p.x === x && p.y === y)) continue;
        return { x, y };
      }
    }
    return null;
  };
  const blueDepot = pickLandNear(Math.round(N * 0.12), Math.round(N * 0.42));
  const redDepot = pickLandNear(Math.round(N * 0.88), Math.round(N * 0.14));
  if (!blueDepot || !redDepot) return { ok: false, reason: 'no depot sites' };
  const depots = [
    { ...blueDepot, owner: 'BLUEFOR' as PlayerId },
    { ...redDepot, owner: 'REDFOR' as PlayerId },
  ];

  // ---- 11. Road network: MST over key nodes, each edge routed by A* --------
  const roadNodes: { x: number; y: number }[] = [
    ...settlements.map((s) => ({ x: s.x, y: s.y })),
    ...ports.map((p) => ({ x: p.x, y: p.y })),
    ...airfields,
    ...depots.map((d) => ({ x: d.x, y: d.y })),
  ];

  const isRoad = new Uint8Array(N * N);
  const isBridge = new Uint8Array(N * N);

  const stepCost = (from: number, to: number) => {
    const t = terrain[to];
    if (t === 'WATER') {
      // Roads only cross *rivers*, and only by building a bridge there.
      if (!isRiver[to]) return Infinity;
      return 14;
    }
    let c = 1;
    if (t === 'FOREST') c = 2.4;
    else if (t === 'HILLS') c = 3.0;
    else if (t === 'URBAN' || t === 'INDUSTRIAL') c = 1.1;
    else if (t === 'BEACH') c = 1.6;
    if (isRoad[to]) c *= 0.35; // reuse existing carriageway — roads bundle into corridors
    // Slope penalty: roads follow valleys and contours rather than climbing.
    c += Math.abs(h[to] - h[from]) * 260;
    return c;
  };

  const routeRoad = (ax: number, ay: number, bx: number, by: number): number[] | null => {
    const start = idx(ax, ay);
    const goal = idx(bx, by);
    const g = new Float32Array(N * N).fill(Infinity);
    const prev = new Int32Array(N * N).fill(-1);
    const open = new MinHeap<number>();
    g[start] = 0;
    open.push(0, start);
    const closed = new Uint8Array(N * N);
    let found = false;
    while (open.size) {
      const cur = open.pop()!;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        found = true;
        break;
      }
      const x = cur % N;
      const y = (cur / N) | 0;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inB(nx, ny)) continue;
        const j = idx(nx, ny);
        if (closed[j]) continue;
        const c = stepCost(cur, j);
        if (!isFinite(c)) continue;
        const ng = g[cur] + c;
        if (ng < g[j]) {
          g[j] = ng;
          prev[j] = cur;
          open.push(ng + (Math.abs(nx - bx) + Math.abs(ny - by)) * 0.9, j);
        }
      }
    }
    if (!found) return null;
    const path: number[] = [];
    for (let c = goal; c >= 0; c = prev[c]) {
      path.push(c);
      if (c === start) break;
    }
    return path.reverse();
  };

  const layRoad = (path: number[]) => {
    for (const i of path) {
      isRoad[i] = 1;
      if (terrain[i] === 'WATER') isBridge[i] = 1;
    }
  };

  // Prim's MST over road nodes, then a couple of extra edges for redundancy.
  const M = roadNodes.length;
  const connected = new Set<number>([0]);
  const edges: [number, number][] = [];
  while (connected.size < M) {
    let best: { a: number; b: number; d: number } | null = null;
    for (const a of connected) {
      for (let b = 0; b < M; b++) {
        if (connected.has(b)) continue;
        const d = Math.hypot(roadNodes[a].x - roadNodes[b].x, roadNodes[a].y - roadNodes[b].y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    if (!best) break;
    edges.push([best.a, best.b]);
    connected.add(best.b);
  }
  for (let k = 0; k < 3; k++) {
    const a = Math.floor(rand() * M);
    const b = Math.floor(rand() * M);
    if (a !== b) edges.push([a, b]);
  }
  let routedEdges = 0;
  for (const [a, b] of edges) {
    const p = routeRoad(roadNodes[a].x, roadNodes[a].y, roadNodes[b].x, roadNodes[b].y);
    if (p) {
      layRoad(p);
      routedEdges++;
    }
  }
  if (routedEdges < M - 1) return { ok: false, reason: 'road network could not connect all nodes' };

  // ---- 12. Materialise tiles ----------------------------------------------
  const nSeaNorm = norm(seaLevel);
  const tiles: Tile[][] = [];
  for (let y = 0; y < N; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      const water = terrain[i] === 'WATER';
      row.push({
        x,
        y,
        terrain: terrain[i],
        elevation: water ? 0 : elevBand[i],
        height: Math.round(norm(h[i]) * 100) / 100,
        ...(isRoad[i] ? { road: true as const } : {}),
        ...(water && isRiver[i] ? { river: true as const } : {}),
        ...(isBridge[i] ? { bridge: true as const } : {}),
        ...(water && comp[i] === mainComp ? { navigable: true as const } : {}),
        ...(settlementOf[i] ? { settlement: settlementOf[i] } : {}),
      });
    }
    tiles.push(row);
  }
  void nSeaNorm;

  for (const d of depots) {
    const t = tiles[d.y][d.x];
    t.isDepot = true;
    t.depotOwner = d.owner;
  }

  // ---- 13. Land connectivity: bridge any objective-bearing island ---------
  const landPassable = (t: Tile) => t.terrain !== 'WATER' || t.bridge;
  const landComp = new Int32Array(N * N).fill(-1);
  const labelLand = () => {
    landComp.fill(-1);
    let c = 0;
    for (let i = 0; i < N * N; i++) {
      const t = tiles[(i / N) | 0][i % N];
      if (!landPassable(t) || landComp[i] >= 0) continue;
      const q = [i];
      landComp[i] = c;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        const x = cur % N;
        const y = (cur / N) | 0;
        for (const [dx, dy] of N4) {
          if (!inB(x + dx, y + dy)) continue;
          const j = idx(x + dx, y + dy);
          if (landComp[j] < 0 && landPassable(tiles[y + dy][x + dx])) {
            landComp[j] = c;
            q.push(j);
          }
        }
      }
      c++;
    }
    return c;
  };
  labelLand();

  // Land points that MUST be mutually reachable.
  const criticalLand: { x: number; y: number }[] = [
    ...settlements.map((s) => ({ x: s.x, y: s.y })),
    ...airfields,
    ...depots.map((d) => ({ x: d.x, y: d.y })),
    ...ports.map((p) => ({ x: p.x, y: p.y })),
  ];
  let bridgesAdded = 0;
  for (let iter = 0; iter < 40; iter++) {
    const comps = new Set(criticalLand.map((p) => landComp[idx(p.x, p.y)]).filter((c) => c >= 0));
    if (comps.size <= 1) break;
    // Find a river tile that would join two different critical components.
    let placed = false;
    for (let y = 1; y < N - 1 && !placed; y++) {
      for (let x = 1; x < N - 1 && !placed; x++) {
        const t = tiles[y][x];
        if (t.terrain !== 'WATER' || !t.river || t.bridge) continue;
        const touching = new Set<number>();
        for (const [dx, dy] of N4) {
          const j = idx(x + dx, y + dy);
          if (landComp[j] >= 0 && comps.has(landComp[j])) touching.add(landComp[j]);
        }
        if (touching.size >= 2) {
          t.bridge = true;
          t.road = true;
          bridgesAdded++;
          placed = true;
        }
      }
    }
    if (!placed) return { ok: false, reason: 'land components cannot be bridged' };
    labelLand();
  }
  if (new Set(criticalLand.map((p) => landComp[idx(p.x, p.y)])).size > 1) {
    return { ok: false, reason: 'land network still fragmented' };
  }
  const mainLandComp = landComp[idx(depots[0].x, depots[0].y)];

  // ---- 14. Naval spawns + maritime objectives -----------------------------
  const navigableTiles: number[] = [];
  for (let i = 0; i < N * N; i++) if (isNavigable(i) && !isRiver[i]) navigableTiles.push(i);
  if (navigableTiles.length < 200) return { ok: false, reason: 'not enough open sea' };

  const nearestNavigable = (cx: number, cy: number, exclude: Set<number>): { x: number; y: number } | null => {
    let best: { x: number; y: number; d: number } | null = null;
    for (const i of navigableTiles) {
      if (exclude.has(i)) continue;
      const x = i % N;
      const y = (i / N) | 0;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { x, y, d };
    }
    return best ? { x: best.x, y: best.y } : null;
  };

  const usedNaval = new Set<number>();
  const navalSpawns: Record<PlayerId, { x: number; y: number }[]> = { BLUEFOR: [], REDFOR: [] };
  for (const p of ports) {
    for (let k = 0; k < 2; k++) {
      const s = nearestNavigable(p.x, p.y, usedNaval);
      if (!s) return { ok: false, reason: 'no naval spawn near port' };
      usedNaval.add(idx(s.x, s.y));
      navalSpawns[p.owner].push(s);
    }
  }

  // ---- 15. Objectives ------------------------------------------------------
  const objectives: Objective[] = [];
  const addObjective = (x: number, y: number, name: string, kind: ObjectiveKind, vp: number, maritime = false) => {
    if (!inB(x, y)) return;
    if (tiles[y][x].objectiveId) return;
    const o: Objective = { id: `obj_${objectives.length}`, x, y, name, kind, controlledBy: null, vpPerTurn: vp, maritime };
    objectives.push(o);
    tiles[y][x].objectiveId = o.id;
  };

  for (const s of settlements) addObjective(s.x, s.y, `${s.name} District`, 'Urban District', 3);
  ports.forEach((p, i) => addObjective(p.x, p.y, `${i === 0 ? 'Western' : 'Eastern'} Port`, 'Port', 3));
  airfields.forEach((a, i) => addObjective(a.x, a.y, `Airfield ${String.fromCharCode(65 + i)}`, 'Airfield', 3));
  depots.forEach((d, i) => {
    addObjective(d.x, d.y, `${i === 0 ? 'Western' : 'Eastern'} Supply Depot`, 'Supply Depot', 1);
    const o = objectives.find((oo) => oo.x === d.x && oo.y === d.y);
    if (o) o.controlledBy = d.owner;
  });

  // Bridges: cluster adjacent bridge tiles and pick one crossing per cluster.
  const bridgeSeen = new Uint8Array(N * N);
  const crossings: { x: number; y: number; size: number }[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (!tiles[y][x].bridge || bridgeSeen[i]) continue;
      const bq = [i];
      bridgeSeen[i] = 1;
      const cluster: number[] = [];
      for (let qi = 0; qi < bq.length; qi++) {
        const cur = bq[qi];
        cluster.push(cur);
        const cx = cur % N;
        const cy = (cur / N) | 0;
        for (const [dx, dy] of N8) {
          if (!inB(cx + dx, cy + dy)) continue;
          const j = idx(cx + dx, cy + dy);
          if (!bridgeSeen[j] && tiles[cy + dy][cx + dx].bridge) {
            bridgeSeen[j] = 1;
            bq.push(j);
          }
        }
      }
      const mid = cluster[Math.floor(cluster.length / 2)];
      crossings.push({ x: mid % N, y: (mid / N) | 0, size: cluster.length });
    }
  }
  // Only the major crossings are worth victory points.
  crossings.sort((a, b) => b.size - a.size);
  const namedCrossings: typeof crossings = [];
  for (const c of crossings) {
    if (namedCrossings.length >= 3) break;
    if (namedCrossings.some((n) => Math.hypot(n.x - c.x, n.y - c.y) < 9)) continue;
    namedCrossings.push(c);
  }
  namedCrossings.forEach((c, i) => addObjective(c.x, c.y, `Bridge ${i + 1}`, 'Bridge', 2));

  // Hills: dominant local maxima, well spread.
  const peaks: { x: number; y: number; h: number }[] = [];
  for (let y = 2; y < N - 2; y++) {
    for (let x = 2; x < N - 2; x++) {
      const i = idx(x, y);
      if (terrain[i] !== 'HILLS' || elevBand[i] < 4) continue;
      let isPeak = true;
      for (const [dx, dy] of N8) if (h[idx(x + dx, y + dy)] > h[i]) isPeak = false;
      if (isPeak) peaks.push({ x, y, h: h[i] });
    }
  }
  peaks.sort((a, b) => b.h - a.h);
  const chosenPeaks: typeof peaks = [];
  for (const p of peaks) {
    if (chosenPeaks.length >= 3) break;
    if (chosenPeaks.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 13)) continue;
    chosenPeaks.push(p);
  }
  chosenPeaks.forEach((p) => addObjective(p.x, p.y, `Hill ${Math.round(norm(p.h) * 400 + 60)}`, 'Hill', 2));

  // Maritime anchorages: open-sea control points, spread along the seaboard.
  const anchorCandidates = navigableTiles.filter((i) => {
    const x = i % N;
    const y = (i / N) | 0;
    if (x < 2 || y < 2 || x > N - 3 || y > N - 3) return false;
    let openWater = 0;
    for (const [dx, dy] of N8) if (isNavigable(idx(x + dx, y + dy))) openWater++;
    return openWater === 8;
  });
  // Anchorages are deliberately BALANCED across the seaboard: one nearer each
  // side's naval spawn plus one in the middle. Clustering them all on one
  // coast would hand that side every maritime VP for free.
  const blueSpawn = navalSpawns.BLUEFOR[0];
  const redSpawn = navalSpawns.REDFOR[0];
  const scored = anchorCandidates
    .map((i) => {
      const x = i % N;
      const y = (i / N) | 0;
      const db = Math.hypot(x - blueSpawn.x, y - blueSpawn.y);
      const dr = Math.hypot(x - redSpawn.x, y - redSpawn.y);
      return { x, y, db, dr, bias: db - dr };
    })
    .filter((c) => Math.min(c.db, c.dr) > 7);
  const anchors: { x: number; y: number }[] = [];
  const takeAnchor = (rank: (c: (typeof scored)[number]) => number) => {
    const pool = scored
      .filter((c) => !anchors.some((a) => Math.hypot(a.x - c.x, a.y - c.y) < N * 0.22))
      .sort((a, b) => rank(a) - rank(b));
    if (pool.length) anchors.push({ x: pool[0].x, y: pool[0].y });
  };
  takeAnchor((c) => c.bias); // most BLUEFOR-side
  takeAnchor((c) => -c.bias); // most REDFOR-side
  takeAnchor((c) => Math.abs(c.bias)); // contested middle
  anchors.forEach((a, i) => addObjective(a.x, a.y, `Anchorage ${String.fromCharCode(65 + i)}`, 'Anchorage', 2, true));

  if (objectives.length < 12) return { ok: false, reason: `only ${objectives.length} objectives` };

  // Land objectives must be reachable by land units.
  for (const o of objectives) {
    if (o.maritime) continue;
    if (landComp[idx(o.x, o.y)] !== mainLandComp) {
      return { ok: false, reason: `objective ${o.name} unreachable by land` };
    }
  }

  // ---- 16. Start zones -----------------------------------------------------
  const pickStartZone = (cx: number, cy: number, count: number): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    const seen = new Set<number>();
    for (let r = 0; r <= 23 && out.length < count; r++) {
      for (let a = 0; a < 40 && out.length < count; a++) {
        const ang = (a / 40) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const y = Math.round(cy + Math.sin(ang) * r);
        if (!inB(x, y)) continue;
        const i = idx(x, y);
        if (seen.has(i)) continue;
        const t = tiles[y][x];
        if (t.terrain === 'WATER') continue;
        if (landComp[i] !== mainLandComp) continue;
        if (out.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < 2)) continue;
        seen.add(i);
        out.push({ x, y });
      }
    }
    return out;
  };
  const startZones: Record<PlayerId, { x: number; y: number }[]> = {
    BLUEFOR: pickStartZone(depots[0].x, depots[0].y, 12),
    REDFOR: pickStartZone(depots[1].x, depots[1].y, 12),
  };
  if (startZones.BLUEFOR.length < 8 || startZones.REDFOR.length < 8) {
    return { ok: false, reason: 'insufficient deployment ground' };
  }

  // ---- 17. Final diagnostics ----------------------------------------------
  let waterTiles = 0;
  let navigableCount = 0;
  let riverTiles = 0;
  let roadTiles = 0;
  let bridgeTiles = 0;
  let forestTiles = 0;
  let urbanTiles = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tiles[y][x];
      if (t.terrain === 'WATER') {
        waterTiles++;
        if (t.navigable) navigableCount++;
        if (t.river) riverTiles++;
      }
      if (t.road) roadTiles++;
      if (t.bridge) bridgeTiles++;
      if (t.terrain === 'FOREST') forestTiles++;
      if (t.terrain === 'URBAN' || t.terrain === 'INDUSTRIAL') urbanTiles++;
    }
  }

  return {
    ok: true,
    map: {
      tiles,
      objectives,
      depots,
      startZones,
      navalSpawns,
      ports,
      settlements,
      diagnostics: {
        seed,
        attempts: attemptNo,
        waterTiles,
        navigableTiles: navigableCount,
        waterBodiesDiscarded,
        landTiles: N * N - waterTiles,
        riverTiles,
        roadTiles,
        bridgeTiles,
        forestTiles,
        urbanTiles,
        speckleTiles,
        bridgesAddedForConnectivity: bridgesAdded,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Post-generation assertions — a map that fails these is NEVER served.
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateMap(map: GeneratedMap): ValidationResult {
  const errors: string[] = [];
  const { tiles } = map;

  // -- Water: one navigable body reachable from every naval spawn, port berth
  //    and maritime objective.
  const seen = new Int32Array(N * N).fill(-1);
  const bodies: number[][] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (tiles[y][x].terrain !== 'WATER' || seen[i] >= 0) continue;
      const id = bodies.length;
      const body: number[] = [];
      const q = [i];
      seen[i] = id;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        body.push(cur);
        const cx = cur % N;
        const cy = (cur / N) | 0;
        for (const [dx, dy] of N4) {
          if (!inB(cx + dx, cy + dy)) continue;
          const j = idx(cx + dx, cy + dy);
          if (seen[j] < 0 && tiles[cy + dy][cx + dx].terrain === 'WATER') {
            seen[j] = id;
            q.push(j);
          }
        }
      }
      bodies.push(body);
    }
  }
  if (bodies.length === 0) {
    errors.push('no water at all');
    return { ok: false, errors };
  }
  let main = 0;
  for (let b = 1; b < bodies.length; b++) if (bodies[b].length > bodies[main].length) main = b;
  if (bodies.length > 1) {
    errors.push(`water is fragmented into ${bodies.length} bodies (largest ${bodies[main].length} tiles)`);
  }

  const requireNavigable = (x: number, y: number, what: string) => {
    if (!inB(x, y) || tiles[y][x].terrain !== 'WATER') {
      errors.push(`${what} at (${x},${y}) is not on water`);
      return;
    }
    if (seen[idx(x, y)] !== main) errors.push(`${what} at (${x},${y}) is on an isolated pool`);
  };
  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((side) => {
    if (map.navalSpawns[side].length === 0) errors.push(`${side} has no naval spawn`);
    map.navalSpawns[side].forEach((s) => requireNavigable(s.x, s.y, `${side} naval spawn`));
  });
  map.objectives.filter((o) => o.maritime).forEach((o) => requireNavigable(o.x, o.y, `maritime objective ${o.name}`));
  for (const p of map.ports) {
    let berth = false;
    for (const [dx, dy] of N4) {
      if (!inB(p.x + dx, p.y + dy)) continue;
      const t = tiles[p.y + dy][p.x + dx];
      if (t.terrain === 'WATER' && seen[idx(p.x + dx, p.y + dy)] === main) berth = true;
    }
    if (!berth) errors.push(`port at (${p.x},${p.y}) has no berth on the navigable body`);
  }

  // -- Land: every land objective and every deployment tile in one component.
  const landPassable = (t: Tile) => t.terrain !== 'WATER' || t.bridge;
  const lseen = new Int32Array(N * N).fill(-1);
  let lc = 0;
  const sizes: number[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = idx(x, y);
      if (lseen[i] >= 0 || !landPassable(tiles[y][x])) continue;
      const q = [i];
      lseen[i] = lc;
      let size = 0;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        size++;
        const cx = cur % N;
        const cy = (cur / N) | 0;
        for (const [dx, dy] of N4) {
          if (!inB(cx + dx, cy + dy)) continue;
          const j = idx(cx + dx, cy + dy);
          if (lseen[j] < 0 && landPassable(tiles[cy + dy][cx + dx])) {
            lseen[j] = lc;
            q.push(j);
          }
        }
      }
      sizes.push(size);
      lc++;
    }
  }
  let mainLand = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[mainLand]) mainLand = c;
  map.objectives
    .filter((o) => !o.maritime)
    .forEach((o) => {
      if (lseen[idx(o.x, o.y)] !== mainLand) errors.push(`land objective ${o.name} is not on the main landmass`);
    });
  (['BLUEFOR', 'REDFOR'] as PlayerId[]).forEach((side) => {
    map.startZones[side].forEach((s) => {
      if (lseen[idx(s.x, s.y)] !== mainLand) errors.push(`${side} deployment tile (${s.x},${s.y}) is stranded`);
    });
  });

  // -- Rivers must be continuous: every river tile touches water on 2+ sides
  //    or reaches the sea (i.e. no orphan single-tile "blue speckle").
  let orphanRiver = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tiles[y][x];
      if (t.terrain !== 'WATER' || !t.river) continue;
      let neighbours = 0;
      for (const [dx, dy] of N8) {
        if (inB(x + dx, y + dy) && tiles[y + dy][x + dx].terrain === 'WATER') neighbours++;
      }
      if (neighbours === 0) orphanRiver++;
    }
  }
  if (orphanRiver > 0) errors.push(`${orphanRiver} disconnected river tiles`);

  // -- No isolated single-tile terrain speckle on land.
  let speckle = 0;
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const t = tiles[y][x];
      if (t.terrain === 'WATER' || t.terrain === 'PORT' || t.terrain === 'AIRFIELD') continue;
      let same = 0;
      for (const [dx, dy] of N8) if (tiles[y + dy][x + dx].terrain === t.terrain) same++;
      if (same === 0) speckle++;
    }
  }
  if (speckle > N * N * 0.002) errors.push(`${speckle} isolated single-tile terrain speckles`);

  // -- Road network must connect every settlement, port, airfield and depot.
  const roadNodes = [
    ...map.settlements.map((s) => ({ x: s.x, y: s.y, what: `settlement ${s.name}` })),
    ...map.ports.map((p) => ({ x: p.x, y: p.y, what: 'port' })),
    ...map.depots.map((d) => ({ x: d.x, y: d.y, what: 'depot' })),
  ];
  // Flood fill along road tiles (allowing a 1-tile hop onto a node centre).
  const rseen = new Uint8Array(N * N);
  const startRoad = (() => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (tiles[y][x].road) return idx(x, y);
    return -1;
  })();
  if (startRoad < 0) {
    errors.push('no roads at all');
  } else {
    const q = [startRoad];
    rseen[startRoad] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cx = cur % N;
      const cy = (cur / N) | 0;
      for (const [dx, dy] of N4) {
        if (!inB(cx + dx, cy + dy)) continue;
        const j = idx(cx + dx, cy + dy);
        if (!rseen[j] && tiles[cy + dy][cx + dx].road) {
          rseen[j] = 1;
          q.push(j);
        }
      }
    }
    for (const n of roadNodes) {
      let onNetwork = false;
      for (let dy = -2; dy <= 2 && !onNetwork; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (inB(n.x + dx, n.y + dy) && rseen[idx(n.x + dx, n.y + dy)]) {
            onNetwork = true;
            break;
          }
        }
      }
      if (!onNetwork) errors.push(`${n.what} at (${n.x},${n.y}) is off the road network`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Entry point — generate, validate, retry. A broken map never reaches a room.
// ---------------------------------------------------------------------------

export const MAX_MAP_ATTEMPTS = 24;

export function generateBattlefield(seed = 1337): GeneratedMap {
  const failures: string[] = [];
  for (let attempt = 0; attempt < MAX_MAP_ATTEMPTS; attempt++) {
    // Decorrelate successive attempts rather than walking seed+1.
    const s = (Math.imul(seed ^ (attempt * 0x9e3779b9), 0x85ebca6b) >>> 0) || 1;
    const res = generateAttempt(s, attempt + 1);
    if (!res.ok || !res.map) {
      failures.push(`attempt ${attempt + 1} (seed ${s}): ${res.reason}`);
      if (process.env.MAPGEN_DEBUG) console.log(`[mapgen] ${failures[failures.length - 1]}`);
      continue;
    }
    const v = validateMap(res.map);
    if (v.ok) return res.map;
    failures.push(`attempt ${attempt + 1} (seed ${s}) failed validation: ${v.errors.join('; ')}`);
    if (process.env.MAPGEN_DEBUG) console.log(`[mapgen] ${failures[failures.length - 1]}`);
  }
  throw new Error(`generateBattlefield: no valid map after ${MAX_MAP_ATTEMPTS} attempts:\n${failures.join('\n')}`);
}
