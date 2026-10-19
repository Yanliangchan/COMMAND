// ============================================================================
// ISLAND OPS — the board.
//
// A stylised Singapore: one main island cut into regions by a Voronoi diagram
// over hand-placed region sites, plus four offshore islands that are one
// region each. Everything here is computed once at module load and is pure
// data — the engine, the bots and the renderer all read the same BOARD.
//
// Coordinates live in a 1000 x 620 viewBox.
// ============================================================================

import { Delaunay } from 'd3-delaunay';

export type Pt = [number, number];

export type SectorId = 'WEST' | 'NORTH' | 'NORTHEAST' | 'EAST' | 'CENTRAL' | 'SOUTH';

export interface SectorDef {
  id: SectorId;
  name: string;
  /** Troops a turn for holding every region in the sector (RISK's continent bonus). */
  bonus: number;
  /** Where the faint sector name is painted on the map. */
  label: Pt;
}

export const SECTORS: Record<SectorId, SectorDef> = {
  WEST: { id: 'WEST', name: 'Western Sector', bonus: 3, label: [190, 300] },
  NORTH: { id: 'NORTH', name: 'Northern Sector', bonus: 3, label: [400, 150] },
  NORTHEAST: { id: 'NORTHEAST', name: 'North-East Sector', bonus: 3, label: [650, 200] },
  EAST: { id: 'EAST', name: 'Eastern Sector', bonus: 3, label: [800, 280] },
  CENTRAL: { id: 'CENTRAL', name: 'Central Sector', bonus: 5, label: [460, 270] },
  SOUTH: { id: 'SOUTH', name: 'Southern Sector', bonus: 4, label: [520, 380] },
};

export const SECTOR_IDS = Object.keys(SECTORS) as SectorId[];

export type Landmark = 'towers' | 'tower' | 'refinery' | 'palm' | 'camp' | 'hill' | 'causeway' | 'stadium' | 'airbase' | 'port';

interface RegionSeed {
  id: string;
  name: string;
  sector: SectorId;
  site: Pt;
  /** Close country (towns, hills): the defender adds +1 to their highest die. */
  stronghold?: boolean;
  landmark?: Landmark;
  /** Offshore island outline — such a region IS its island. */
  island?: Pt[];
}

// ---------------------------------------------------------------------------
// Outlines. Coarse control points, smoothed with Catmull-Rom below.
// ---------------------------------------------------------------------------

const MAINLAND_CTRL: Pt[] = [
  [55, 330], [90, 290], [150, 250], [185, 200], [230, 160], [290, 135], [350, 100], [410, 72],
  [470, 78], [520, 98], [570, 120], [620, 135], [680, 150], [735, 170], [790, 192], [845, 215],
  [905, 232], [945, 262], [930, 300], [880, 325], [810, 345], [740, 365], [670, 385], [610, 410],
  [560, 440], [505, 452], [450, 440], [395, 428], [340, 420], [285, 412], [230, 405], [170, 398],
  [110, 380], [70, 360],
];

const JURONG_ISLAND: Pt[] = [[195, 455], [235, 440], [285, 448], [300, 470], [270, 492], [220, 495], [190, 478]];
const SENTOSA: Pt[] = [[475, 500], [515, 488], [565, 494], [575, 510], [535, 522], [488, 518]];
const UBIN: Pt[] = [[728, 118], [770, 105], [815, 112], [822, 132], [785, 145], [740, 142]];
const TEKONG: Pt[] = [[860, 150], [895, 128], [940, 138], [952, 168], [920, 190], [872, 183]];

const REGION_SEEDS: RegionSeed[] = [
  // WEST
  { id: 'tuas', name: 'Tuas', sector: 'WEST', site: [110, 345], landmark: 'port' },
  { id: 'pioneer', name: 'Pioneer', sector: 'WEST', site: [185, 370] },
  { id: 'jurong-west', name: 'Jurong West', sector: 'WEST', site: [225, 315], stronghold: true },
  { id: 'jurong-east', name: 'Jurong East', sector: 'WEST', site: [300, 350], stronghold: true },
  { id: 'tengah', name: 'Tengah', sector: 'WEST', site: [265, 245], landmark: 'airbase' },
  { id: 'jurong-island', name: 'Jurong Island', sector: 'WEST', site: [245, 468], island: JURONG_ISLAND, landmark: 'refinery' },
  // NORTH
  { id: 'lim-chu-kang', name: 'Lim Chu Kang', sector: 'NORTH', site: [220, 200] },
  { id: 'kranji', name: 'Kranji', sector: 'NORTH', site: [315, 160] },
  { id: 'woodlands', name: 'Woodlands', sector: 'NORTH', site: [410, 108], landmark: 'causeway', stronghold: true },
  { id: 'sembawang', name: 'Sembawang', sector: 'NORTH', site: [495, 118] },
  { id: 'yishun', name: 'Yishun', sector: 'NORTH', site: [520, 175], stronghold: true },
  { id: 'mandai', name: 'Mandai', sector: 'NORTH', site: [390, 185] },
  // NORTHEAST
  { id: 'seletar', name: 'Seletar', sector: 'NORTHEAST', site: [592, 162], landmark: 'airbase' },
  { id: 'sengkang', name: 'Sengkang', sector: 'NORTHEAST', site: [635, 212], stronghold: true },
  { id: 'punggol', name: 'Punggol', sector: 'NORTHEAST', site: [695, 185] },
  { id: 'hougang', name: 'Hougang', sector: 'NORTHEAST', site: [650, 265], stronghold: true },
  { id: 'serangoon', name: 'Serangoon', sector: 'NORTHEAST', site: [585, 262] },
  { id: 'ubin', name: 'Pulau Ubin', sector: 'NORTHEAST', site: [775, 125], island: UBIN, landmark: 'palm' },
  // EAST
  { id: 'pasir-ris', name: 'Pasir Ris', sector: 'EAST', site: [775, 222] },
  { id: 'tampines', name: 'Tampines', sector: 'EAST', site: [740, 275], stronghold: true },
  { id: 'changi', name: 'Changi', sector: 'EAST', site: [878, 268], landmark: 'tower' },
  { id: 'bedok', name: 'Bedok', sector: 'EAST', site: [805, 312], stronghold: true },
  { id: 'paya-lebar', name: 'Paya Lebar', sector: 'EAST', site: [700, 315], landmark: 'airbase' },
  { id: 'tekong', name: 'Pulau Tekong', sector: 'EAST', site: [905, 160], island: TEKONG, landmark: 'camp' },
  // CENTRAL
  { id: 'bukit-panjang', name: 'Bukit Panjang', sector: 'CENTRAL', site: [335, 250] },
  { id: 'bukit-timah', name: 'Bukit Timah', sector: 'CENTRAL', site: [395, 305], landmark: 'hill', stronghold: true },
  { id: 'upper-thomson', name: 'Upper Thomson', sector: 'CENTRAL', site: [445, 225] },
  { id: 'ang-mo-kio', name: 'Ang Mo Kio', sector: 'CENTRAL', site: [525, 228], stronghold: true },
  { id: 'bishan', name: 'Bishan', sector: 'CENTRAL', site: [520, 285] },
  { id: 'toa-payoh', name: 'Toa Payoh', sector: 'CENTRAL', site: [580, 318], stronghold: true },
  { id: 'novena', name: 'Novena', sector: 'CENTRAL', site: [470, 335] },
  // SOUTH
  { id: 'clementi', name: 'Clementi', sector: 'SOUTH', site: [350, 380] },
  { id: 'queenstown', name: 'Queenstown', sector: 'SOUTH', site: [420, 395] },
  { id: 'bukit-merah', name: 'Bukit Merah', sector: 'SOUTH', site: [475, 418] },
  { id: 'tanjong-pagar', name: 'Tanjong Pagar', sector: 'SOUTH', site: [530, 425], stronghold: true },
  { id: 'marina-bay', name: 'Marina Bay', sector: 'SOUTH', site: [595, 395], landmark: 'towers', stronghold: true },
  { id: 'kallang', name: 'Kallang', sector: 'SOUTH', site: [635, 350], landmark: 'stadium' },
  { id: 'marine-parade', name: 'Marine Parade', sector: 'SOUTH', site: [710, 348] },
  { id: 'sentosa', name: 'Sentosa', sector: 'SOUTH', site: [522, 505], island: SENTOSA, landmark: 'palm' },
];

/** Bridges, causeways and ferry runs — the only way on or off an offshore island. */
const CROSSINGS: [string, string][] = [
  ['jurong-island', 'pioneer'],
  ['jurong-island', 'jurong-east'],
  ['sentosa', 'tanjong-pagar'],
  ['sentosa', 'bukit-merah'],
  ['ubin', 'punggol'],
  ['ubin', 'pasir-ris'],
  ['tekong', 'changi'],
  ['tekong', 'ubin'],
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function catmullRom(ctrl: Pt[], perSeg = 8): Pt[] {
  const out: Pt[] = [];
  const n = ctrl.length;
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyPath(poly: Pt[]): string {
  return 'M' + poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z';
}

function polygonCentroid(poly: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

// ---------------------------------------------------------------------------
// Build the board
// ---------------------------------------------------------------------------

export interface Region {
  id: string;
  index: number;
  name: string;
  sector: SectorId;
  site: Pt;
  /** Cell outline. Mainland cells extend into the sea and are clipped to the coast when drawn. */
  poly: Pt[];
  /** 'mainland' or the id of the island this region is. */
  landmass: string;
  stronghold: boolean;
  coastal: boolean;
  landmark?: Landmark;
  neighbours: string[];
}

export interface BorderSegment {
  a: string;
  b: string;
  from: Pt;
  to: Pt;
}

export interface Board {
  width: number;
  height: number;
  mainland: Pt[];
  islands: { id: string; poly: Pt[] }[];
  regions: Region[];
  byId: Record<string, Region>;
  /** Land borders between regions, clipped to the coast — used to draw sector boundaries. */
  borders: BorderSegment[];
  crossings: [string, string][];
}

function buildBoard(): Board {
  const width = 1000, height = 620;
  const mainland = catmullRom(MAINLAND_CTRL);
  const seeds = REGION_SEEDS;
  const mainSeeds = seeds.filter((s) => !s.island);

  for (const s of mainSeeds) {
    if (!pointInPolygon(s.site, mainland)) throw new Error(`region site off the island: ${s.id}`);
  }

  const delaunay = Delaunay.from(mainSeeds.map((s) => s.site));
  const voronoi = delaunay.voronoi([0, 0, width, height]);

  const regions: Region[] = seeds.map((s, index) => ({
    id: s.id,
    index,
    name: s.name,
    sector: s.sector,
    site: s.site,
    poly: [],
    landmass: s.island ? s.id : 'mainland',
    stronghold: !!s.stronghold,
    coastal: !!s.island,
    landmark: s.landmark,
    neighbours: [],
  }));
  const byId: Record<string, Region> = Object.fromEntries(regions.map((r) => [r.id, r]));
  const link = (a: string, b: string) => {
    if (!byId[a].neighbours.includes(b)) byId[a].neighbours.push(b);
    if (!byId[b].neighbours.includes(a)) byId[b].neighbours.push(a);
  };

  const borders: BorderSegment[] = [];
  mainSeeds.forEach((s, i) => {
    const cell = (voronoi.cellPolygon(i) as Pt[]).slice(0, -1);
    const r = byId[s.id];
    r.poly = cell;
    r.coastal = cell.some((p) => !pointInPolygon(p, mainland));
    for (const j of voronoi.neighbors(i)) {
      if (j < i) continue;
      const other = (voronoi.cellPolygon(j) as Pt[]).slice(0, -1);
      const shared = cell.filter((p) => other.some((q) => near(p, q)));
      if (shared.length < 2) continue;
      const [a, b] = shared;
      // Sample along the shared edge and keep only the part that is on land.
      const inside: Pt[] = [];
      for (let k = 0; k <= 24; k++) {
        const t = k / 24;
        const p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (pointInPolygon(p, mainland)) inside.push(p);
      }
      if (inside.length < 2) continue; // the cells only meet out at sea
      link(s.id, mainSeeds[j].id);
      borders.push({ a: s.id, b: mainSeeds[j].id, from: inside[0], to: inside[inside.length - 1] });
    }
  });

  const islands: { id: string; poly: Pt[] }[] = [];
  for (const s of seeds) {
    if (!s.island) continue;
    const poly = catmullRom(s.island, 6);
    byId[s.id].poly = poly;
    byId[s.id].site = polygonCentroid(poly);
    islands.push({ id: s.id, poly });
  }
  for (const [a, b] of CROSSINGS) link(a, b);

  return { width, height, mainland, islands, regions, byId, borders, crossings: CROSSINGS };
}

export const BOARD: Board = buildBoard();

export const REGION_IDS: string[] = BOARD.regions.map((r) => r.id);

export function regionsInSector(sector: SectorId): string[] {
  return BOARD.regions.filter((r) => r.sector === sector).map((r) => r.id);
}

export function distance(a: string, b: string): number {
  const p = BOARD.byId[a].site, q = BOARD.byId[b].site;
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}
