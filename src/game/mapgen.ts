import { GRID_SIZE, Objective, PlayerId, Tile, TerrainType } from './types';

// Deterministic PRNG (mulberry32) so the battlefield is reproducible across
// re-renders within a session while still looking hand-varied.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function makeTile(x: number, y: number, terrain: TerrainType, rand: () => number): Tile {
  return {
    x,
    y,
    terrain,
    elevation: 0,
    road: false,
    river: false,
    bridge: false,
    noiseSeed: rand(),
  };
}

function drawLine(tiles: Tile[][], x0: number, y0: number, x1: number, y1: number, fn: (t: Tile) => void) {
  // Simple orthogonal-ish line: step diagonally then straighten (good enough for roads).
  let x = x0;
  let y = y0;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    x = Math.round(x0 + (x1 - x0) * t);
    y = Math.round(y0 + (y1 - y0) * t);
    if (tiles[y] && tiles[y][x]) fn(tiles[y][x]);
  }
}

export interface GeneratedMap {
  tiles: Tile[][];
  objectives: Objective[];
  depots: { x: number; y: number; owner: PlayerId }[];
  startZones: Record<PlayerId, { x: number; y: number }[]>;
  ports: { x: number; y: number; owner: PlayerId }[];
}

export function generateBattlefield(seed = 1337): GeneratedMap {
  const rand = mulberry32(seed);
  const size = GRID_SIZE;
  const tiles: Tile[][] = [];
  for (let y = 0; y < size; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < size; x++) {
      row.push(makeTile(x, y, 'GRASS', rand));
    }
    tiles.push(row);
  }

  // --- Coastline: eastern edge is sea, jagged via noise threshold. ---
  for (let y = 0; y < size; y++) {
    const coastBase = 50 + Math.sin(y / 7) * 3 + Math.sin(y / 3.1) * 1.5;
    for (let x = 0; x < size; x++) {
      if (x > coastBase + (rand() - 0.5) * 2) {
        tiles[y][x].terrain = 'WATER';
        tiles[y][x].elevation = -1;
      }
    }
  }

  // --- Southwest bay: gives BLUEFOR coastal/naval access too, mirroring the east coast. ---
  for (let y = 50; y < size; y++) {
    for (let x = 0; x < 14; x++) {
      const d = Math.hypot(x - 2, y - 58) / 13 + (rand() - 0.5) * 0.3;
      if (d < 0.9) {
        tiles[y][x].terrain = 'WATER';
        tiles[y][x].elevation = -1;
      }
    }
  }

  // --- River: north-south winding channel, roughly x ~ 26-34, width 1-2. ---
  const riverBridgeYs = [12, 46];
  for (let y = 0; y < size; y++) {
    const cx = Math.round(28 + Math.sin(y / 9) * 5 + Math.sin(y / 4.3) * 1.5);
    const width = y % 17 === 0 ? 2 : 1;
    for (let w = -width; w <= width; w++) {
      const x = cx + w;
      if (x < 0 || x >= size) continue;
      if (tiles[y][x].terrain === 'WATER') continue; // don't overwrite sea
      tiles[y][x].terrain = 'WATER';
      tiles[y][x].river = true;
      tiles[y][x].elevation = -1;
    }
  }
  // Bridges at two crossing points.
  const bridgeXs: number[] = [];
  for (const by of riverBridgeYs) {
    const cx = Math.round(28 + Math.sin(by / 9) * 5 + Math.sin(by / 4.3) * 1.5);
    bridgeXs.push(cx);
    for (let w = -2; w <= 2; w++) {
      const t = tiles[by]?.[cx + w];
      if (t && t.river) {
        t.bridge = true;
        t.road = true;
      }
    }
  }

  // --- Hills clusters (elevation shading). ---
  const hillCenters = [
    { x: 12, y: 42, r: 8 },
    { x: 46, y: 12, r: 6 },
    { x: 18, y: 10, r: 5 },
  ];
  for (const hc of hillCenters) {
    for (let y = Math.max(0, hc.y - hc.r); y < Math.min(size, hc.y + hc.r); y++) {
      for (let x = Math.max(0, hc.x - hc.r); x < Math.min(size, hc.x + hc.r); x++) {
        const t = tiles[y][x];
        if (t.terrain === 'WATER') continue;
        const d = Math.hypot(x - hc.x, y - hc.y) / hc.r + (rand() - 0.5) * 0.35;
        if (d < 1) {
          t.terrain = 'HILLS';
          t.elevation = d < 0.35 ? 3 : d < 0.7 ? 2 : 1;
        }
      }
    }
  }

  // --- Forest clusters via random-walk blobs. ---
  const forestClusters = 9;
  for (let c = 0; c < forestClusters; c++) {
    let x = Math.floor(rand() * size);
    let y = Math.floor(rand() * size);
    const steps = 60 + Math.floor(rand() * 80);
    for (let i = 0; i < steps; i++) {
      x = Math.min(size - 1, Math.max(0, x + Math.floor((rand() - 0.5) * 3)));
      y = Math.min(size - 1, Math.max(0, y + Math.floor((rand() - 0.5) * 3)));
      const t = tiles[y][x];
      if (t.terrain === 'GRASS' || t.terrain === 'OPEN') {
        t.terrain = 'FOREST';
      }
    }
  }

  // --- Open terrain scatter (patches of flat open ground amid grass). ---
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = tiles[y][x];
      if (t.terrain === 'GRASS' && rand() < 0.12) t.terrain = 'OPEN';
    }
  }

  // --- Urban district (central city, contested). ---
  const cityX0 = 30,
    cityY0 = 26,
    cityX1 = 37,
    cityY1 = 33;
  for (let y = cityY0; y <= cityY1; y++) {
    for (let x = cityX0; x <= cityX1; x++) {
      if (tiles[y]?.[x] && tiles[y][x].terrain !== 'WATER') {
        tiles[y][x].terrain = 'URBAN';
        tiles[y][x].elevation = 0;
      }
    }
  }
  // Secondary town near the west depot.
  for (let y = 30; y <= 33; y++) {
    for (let x = 6; x <= 9; x++) {
      if (tiles[y]?.[x] && tiles[y][x].terrain !== 'WATER') tiles[y][x].terrain = 'URBAN';
    }
  }

  // --- Industrial zone near the port. ---
  for (let y = 20; y <= 24; y++) {
    for (let x = 44; x <= 48; x++) {
      if (tiles[y]?.[x] && tiles[y][x].terrain !== 'WATER') tiles[y][x].terrain = 'INDUSTRIAL';
    }
  }

  // --- Airfield: flat rectangle inland (west-central). ---
  const airfield = { x: 16, y: 26 };
  for (let y = airfield.y; y <= airfield.y + 2; y++) {
    for (let x = airfield.x; x <= airfield.x + 4; x++) {
      if (tiles[y]?.[x]) {
        tiles[y][x].terrain = 'AIRFIELD';
        tiles[y][x].elevation = 0;
      }
    }
  }

  // --- Ports: coastal tiles, one per side's coastline. ---
  const port = { x: 47, y: 22 };
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = tiles[port.y + dy]?.[port.x + dx];
      if (t && t.terrain !== 'WATER') t.terrain = 'PORT';
    }
  }
  const westPort = { x: 8, y: 50 };
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = tiles[westPort.y + dy]?.[westPort.x + dx];
      if (t && t.terrain !== 'WATER') t.terrain = 'PORT';
    }
  }

  // --- Roads connecting key points. ---
  const roadPoints: [number, number][] = [
    [8, 30],
    [16, 27],
    [28, bridgeXs.length ? riverBridgeYs[0] : 12],
    [bridgeXs[0], riverBridgeYs[0]],
    [33, 29],
    [47, 22],
    [bridgeXs[1], riverBridgeYs[1]],
    [12, 42],
  ];
  const markRoad = (t: Tile) => {
    if (t.terrain === 'WATER' && !t.bridge) return;
    t.road = true;
  };
  drawLine(tiles, 8, 30, 16, 27, markRoad);
  drawLine(tiles, 16, 27, bridgeXs[0], riverBridgeYs[0], markRoad);
  drawLine(tiles, bridgeXs[0], riverBridgeYs[0], 33, 29, markRoad);
  drawLine(tiles, 33, 29, 47, 22, markRoad);
  drawLine(tiles, 8, 30, 12, 42, markRoad);
  drawLine(tiles, 12, 42, bridgeXs[1], riverBridgeYs[1], markRoad);
  drawLine(tiles, bridgeXs[1], riverBridgeYs[1], 33, 30, markRoad);

  // --- Supply depots. ---
  const depots: { x: number; y: number; owner: PlayerId }[] = [
    { x: 6, y: 28, owner: 'BLUEFOR' },
    { x: 44, y: 18, owner: 'REDFOR' },
  ];
  for (const d of depots) {
    const t = tiles[d.y][d.x];
    t.isDepot = true;
    t.depotOwner = d.owner;
    if (t.terrain === 'WATER') t.terrain = 'OPEN';
  }

  // --- Objectives (5-8 capture points). ---
  const objectives: Objective[] = [
    { id: 'obj_bridge_n', x: bridgeXs[0], y: riverBridgeYs[0], name: 'North Bridge', kind: 'Bridge', controlledBy: null, vpPerTurn: 2 },
    { id: 'obj_bridge_s', x: bridgeXs[1], y: riverBridgeYs[1], name: 'South Bridge', kind: 'Bridge', controlledBy: null, vpPerTurn: 2 },
    { id: 'obj_port', x: port.x, y: port.y, name: 'Harbor Port', kind: 'Port', controlledBy: null, vpPerTurn: 3 },
    { id: 'obj_airfield', x: airfield.x + 2, y: airfield.y + 1, name: 'Airfield', kind: 'Airfield', controlledBy: null, vpPerTurn: 3 },
    { id: 'obj_city', x: 33, y: 29, name: 'City Center', kind: 'Urban District', controlledBy: null, vpPerTurn: 4 },
    { id: 'obj_hill', x: 46, y: 12, name: 'Hill 214', kind: 'Hill', controlledBy: null, vpPerTurn: 2 },
    { id: 'obj_depot_blue', x: depots[0].x, y: depots[0].y, name: 'West Supply Depot', kind: 'Supply Depot', controlledBy: 'BLUEFOR', vpPerTurn: 1 },
    { id: 'obj_depot_red', x: depots[1].x, y: depots[1].y, name: 'East Supply Depot', kind: 'Supply Depot', controlledBy: 'REDFOR', vpPerTurn: 1 },
  ];
  for (const o of objectives) {
    if (tiles[o.y]?.[o.x]) tiles[o.y][o.x].objectiveId = o.id;
  }

  const startZones: Record<PlayerId, { x: number; y: number }[]> = {
    BLUEFOR: [
      { x: 5, y: 26 },
      { x: 5, y: 29 },
      { x: 5, y: 32 },
      { x: 7, y: 35 },
      { x: 9, y: 24 },
      { x: 4, y: 38 },
      { x: 10, y: 45 },
      { x: 6, y: 20 },
    ],
    REDFOR: [
      { x: 43, y: 16 },
      { x: 43, y: 19 },
      { x: 43, y: 22 },
      { x: 41, y: 25 },
      { x: 45, y: 28 },
      { x: 40, y: 12 },
      { x: 47, y: 30 },
      { x: 43, y: 9 },
    ],
  };

  const ports: { x: number; y: number; owner: PlayerId }[] = [
    { x: westPort.x, y: westPort.y - 2, owner: 'BLUEFOR' },
    { x: port.x, y: port.y - 2, owner: 'REDFOR' },
  ];

  return { tiles, objectives, depots, startZones, ports };
}
