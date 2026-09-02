// ============================================================================
// COMMAND — Battlefield renderer (2D canvas).
//
// Phase-2 cartographic pass. The terrain is no longer painted as one filled
// rectangle per tile: the visible window is rasterised into a small offscreen
// image (a few pixels per tile), bilinearly *interpolated* on upscale by the
// browser, so colour, coastline and relief shading vary continuously across
// tile boundaries. Contours, coastlines, rivers, roads, sprites, labels and
// unit markers are then drawn crisply at full resolution on top.
//
// Everything here reads GameState and draws pixels — no game rules live here.
// ============================================================================

import { FORMATION_DEFS } from '../game/data';
import { Formation, GameState, GRID_SIZE, Objective, PlayerId, Tile } from '../game/types';
import { PLAYER_COLORS, TERRAIN_COLORS, UI } from './colors';

/** Contour interval, as a fraction of the full 0..1 height range. */
const CONTOUR_BANDS = 20;
/** Every Nth contour is an "index" contour — thicker and darker, as on a real sheet. */
const INDEX_EVERY = 5;
/** Subpixel budget for the relief raster; drives the adaptive supersample factor. */
const RELIEF_PIXEL_BUDGET = 46000;

export interface Camera {
  x: number; // world-space (tile units) of viewport center
  y: number;
  scale: number; // pixels per tile
}

export interface Overlays {
  terrain: boolean;
  movement: boolean;
  intel: boolean;
  supply: boolean;
  objectives: boolean;
}

export interface MapLabel {
  x: number;
  y: number;
  name: string;
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: Camera;
  state: GameState;
  viewer: PlayerId;
  selected: Formation | null;
  reachable: Map<string, number>;
  attackable: Set<string>; // formation ids attackable from selection
  overlays: Overlays;
  supplySet: Set<string>;
  hoverTile: { x: number; y: number } | null;
  /** Settlement names to letter onto the sheet at sufficient zoom. */
  labels?: MapLabel[];
  /** Tiles to flash (e.g. the two ends of the engagement a battle report describes). */
  flashTiles?: { x: number; y: number }[];
  /** 0..1 animation phase for pulsing selection / flash effects. */
  pulse?: number;
}

function worldToScreen(camera: Camera, width: number, height: number, x: number, y: number) {
  return {
    sx: width / 2 + (x - camera.x) * camera.scale,
    sy: height / 2 + (y - camera.y) * camera.scale,
  };
}

export function screenToTile(camera: Camera, width: number, height: number, sx: number, sy: number) {
  const x = (sx - width / 2) / camera.scale + camera.x;
  const y = (sy - height / 2) / camera.scale + camera.y;
  return { x: Math.floor(x + 0.5), y: Math.floor(y + 0.5) };
}

function visibleTileRange(camera: Camera, width: number, height: number) {
  const halfW = width / 2 / camera.scale;
  const halfH = height / 2 / camera.scale;
  const x0 = Math.max(0, Math.floor(camera.x - halfW - 1));
  const x1 = Math.min(GRID_SIZE - 1, Math.ceil(camera.x + halfW + 1));
  const y0 = Math.max(0, Math.floor(camera.y - halfH - 1));
  const y1 = Math.min(GRID_SIZE - 1, Math.ceil(camera.y + halfH + 1));
  return { x0, x1, y0, y1 };
}

/**
 * Deterministic per-tile pseudo-random value in [0,1). Derived here rather than
 * carried on every tile over the wire — the state payload stays small.
 */
function tileNoise(x: number, y: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + amt)));
  g = Math.max(0, Math.min(255, Math.round(g + amt)));
  b = Math.max(0, Math.min(255, Math.round(b + amt)));
  return `rgb(${r},${g},${b})`;
}

function isFormationVisible(rc: RenderContext, f: Formation): boolean {
  if (f.owner === rc.viewer) return true;
  return !!rc.state.players[rc.viewer].contacts[f.id];
}

export function objectiveGlyph(kind: Objective['kind']) {
  switch (kind) {
    case 'Bridge':
      return '⌢';
    case 'Port':
      return '⚓';
    case 'Airfield':
      return '✈';
    case 'Urban District':
      return '▣';
    case 'Hill':
      return '▲';
    case 'Supply Depot':
      return '⛽';
    case 'Anchorage':
      return '⚓';
    default:
      return '★';
  }
}

export function formationGlyph(type: Formation['type']) {
  switch (type) {
    case 'INFANTRY':
      return 'IN';
    case 'COMMANDO':
      return 'CD';
    case 'ARMOUR':
      return 'AR';
    case 'ARTILLERY':
      return 'TY';
    case 'ENGINEER':
      return 'EN';
    case 'RECON':
      return 'RC';
    case 'FRIGATE':
      return 'FF';
    case 'CORVETTE':
      return 'CV';
    default:
      return '??';
  }
}

// ---------------------------------------------------------------------------
// Cached per-map field derivation
//
// The heightfield, its smoothed gradient and the water mask never change for a
// given map (bridges aside, which do not touch these fields), so they are
// derived once per tile-grid identity and reused every frame.
// ---------------------------------------------------------------------------

interface TerrainFields {
  /** Smoothed height, 0..1, one entry per tile (water forced toward 0). */
  h: Float32Array;
  /** Smoothed height gradient, used for hillshade. */
  gx: Float32Array;
  gy: Float32Array;
  /** 1 for water tiles, 0 otherwise. */
  water: Float32Array;
  /** Per-tile base colour channels of the terrain palette. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

let fieldCacheKey: Tile[][] | null = null;
let fieldCache: TerrainFields | null = null;

function terrainFields(tiles: Tile[][]): TerrainFields {
  if (fieldCacheKey === tiles && fieldCache) return fieldCache;
  const N = GRID_SIZE;
  const raw = new Float32Array(N * N);
  const water = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  const g = new Float32Array(N * N);
  const b = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tiles[y][x];
      const i = y * N + x;
      raw[i] = t.height;
      water[i] = t.terrain === 'WATER' ? 1 : 0;
      const hex = TERRAIN_COLORS[t.terrain].base;
      const n = parseInt(hex.slice(1), 16);
      // A touch of deterministic per-tile variance keeps large flats from
      // reading as flat vector fill once the raster is smoothed.
      const jitter = (tileNoise(x, y) - 0.5) * 10;
      r[i] = ((n >> 16) & 255) + jitter;
      g[i] = ((n >> 8) & 255) + jitter;
      b[i] = (n & 255) + jitter;
    }
  }
  // 3x3 box blur of the heightfield — the relief shading reads as landform
  // rather than per-tile facets when the gradient comes off a smoothed field.
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          sum += raw[ny * N + nx];
          cnt++;
        }
      }
      h[y * N + x] = sum / cnt;
    }
  }
  const gx = new Float32Array(N * N);
  const gy = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const xe = h[y * N + Math.min(N - 1, x + 1)];
      const xw = h[y * N + Math.max(0, x - 1)];
      const yn = h[Math.max(0, y - 1) * N + x];
      const ys = h[Math.min(N - 1, y + 1) * N + x];
      gx[y * N + x] = (xe - xw) * 0.5;
      gy[y * N + x] = (ys - yn) * 0.5;
    }
  }
  fieldCache = { h, gx, gy, water, r, g, b };
  fieldCacheKey = tiles;
  return fieldCache;
}

// Reused offscreen raster for the relief pass.
let reliefCanvas: HTMLCanvasElement | null = null;
let reliefCtx: CanvasRenderingContext2D | null = null;
let reliefImage: ImageData | null = null;

function bilinear(field: Float32Array, x0: number, y0: number, fx: number, fy: number, N: number) {
  const x1 = x0 + 1 < N ? x0 + 1 : N - 1;
  const y1 = y0 + 1 < N ? y0 + 1 : N - 1;
  const a = field[y0 * N + x0];
  const bq = field[y0 * N + x1];
  const c = field[y1 * N + x0];
  const d = field[y1 * N + x1];
  const top = a + (bq - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/** Deep-water and shoal colours for the interpolated coastline blend. */
const WATER_DEEP = [26, 62, 92];
const WATER_SHALLOW = [61, 124, 166];

/**
 * Rasterise the visible window into a small offscreen image and blit it up with
 * smoothing on. This is what turns "squares of colour" into a continuous sheet:
 * terrain colour, coastline and hillshade are all sampled bilinearly, so no
 * tile boundary survives as a hard edge unless something is drawn there later.
 */
function drawRelief(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera, state } = rc;
  const N = GRID_SIZE;
  const f = terrainFields(state.tiles);
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const ss = Math.max(2, Math.min(6, Math.floor(Math.sqrt(RELIEF_PIXEL_BUDGET / Math.max(1, tw * th)))));
  const pw = tw * ss;
  const ph = th * ss;

  if (!reliefCanvas) {
    reliefCanvas = document.createElement('canvas');
    reliefCtx = reliefCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!reliefCtx) return;
  if (reliefCanvas.width !== pw || reliefCanvas.height !== ph) {
    reliefCanvas.width = pw;
    reliefCanvas.height = ph;
    reliefImage = null;
  }
  if (!reliefImage || reliefImage.width !== pw || reliefImage.height !== ph) {
    reliefImage = reliefCtx.createImageData(pw, ph);
  }
  const data = reliefImage.data;

  const inv = 1 / ss;
  let p = 0;
  for (let py = 0; py < ph; py++) {
    // World v of this raster row, in tile units (tile centres sit on integers).
    const v = y0 - 0.5 + (py + 0.5) * inv;
    const vy = v < 0 ? 0 : v > N - 1 ? N - 1 : v;
    const iy = Math.min(N - 1, Math.floor(vy));
    const fy = vy - iy;
    for (let px = 0; px < pw; px++) {
      const u = x0 - 0.5 + (px + 0.5) * inv;
      const ux = u < 0 ? 0 : u > N - 1 ? N - 1 : u;
      const ix = Math.min(N - 1, Math.floor(ux));
      const fx = ux - ix;

      const wet = bilinear(f.water, ix, iy, fx, fy, N);
      const hh = bilinear(f.h, ix, iy, fx, fy, N);

      let cr: number;
      let cg: number;
      let cb: number;

      if (wet > 0.995) {
        // Open water: depth ramp off the (already low) heightfield.
        const t = Math.max(0, Math.min(1, hh * 3.2));
        cr = WATER_DEEP[0] + (WATER_SHALLOW[0] - WATER_DEEP[0]) * t;
        cg = WATER_DEEP[1] + (WATER_SHALLOW[1] - WATER_DEEP[1]) * t;
        cb = WATER_DEEP[2] + (WATER_SHALLOW[2] - WATER_DEEP[2]) * t;
      } else {
        cr = bilinear(f.r, ix, iy, fx, fy, N);
        cg = bilinear(f.g, ix, iy, fx, fy, N);
        cb = bilinear(f.b, ix, iy, fx, fy, N);
        // Hypsometric tint: high ground warms and lightens, valleys cool.
        const tint = (hh - 0.45) * 46;
        cr += tint * 1.05;
        cg += tint * 0.95;
        cb += tint * 0.6;
        if (wet > 0.12) {
          // Shoreline blend — a soft wet fringe instead of a stair-stepped edge.
          // Kept deliberately narrow so a one-tile river channel does not bleed
          // a two-tile blue smear across the bank.
          const k = Math.max(0, Math.min(1, (wet - 0.18) / 0.42)) * 0.9;
          cr += (WATER_SHALLOW[0] - cr) * k;
          cg += (WATER_SHALLOW[1] - cg) * k;
          cb += (WATER_SHALLOW[2] - cb) * k;
        }
        // Hillshade from a north-west light over the smoothed gradient.
        const dx = bilinear(f.gx, ix, iy, fx, fy, N);
        const dy = bilinear(f.gy, ix, iy, fx, fy, N);
        let lit = (-dx - dy) * 13;
        lit = lit > 1 ? 1 : lit < -1 ? -1 : lit;
        const dry = 1 - Math.min(1, wet * 2);
        if (lit > 0) {
          const k = lit * 0.34 * dry;
          cr += (255 - cr) * k;
          cg += (250 - cg) * k;
          cb += (228 - cb) * k;
        } else {
          const k = -lit * 0.42 * dry;
          cr += (12 - cr) * k;
          cg += (16 - cg) * k;
          cb += (22 - cb) * k;
        }
      }

      data[p++] = cr < 0 ? 0 : cr > 255 ? 255 : cr;
      data[p++] = cg < 0 ? 0 : cg > 255 ? 255 : cg;
      data[p++] = cb < 0 ? 0 : cb > 255 ? 255 : cb;
      data[p++] = 255;
    }
  }
  reliefCtx.putImageData(reliefImage, 0, 0);

  const tl = worldToScreen(camera, width, height, x0 - 0.5, y0 - 0.5);
  const br = worldToScreen(camera, width, height, x1 + 0.5, y1 + 0.5);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(reliefCanvas, tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy);
}

// ---------------------------------------------------------------------------
// Marching-squares contours and coastline
// ---------------------------------------------------------------------------

/** Height at a tile *corner* (x-0.5, y-0.5) = mean of the four tiles meeting there. */
function cornerH(f: TerrainFields, x: number, y: number) {
  const N = GRID_SIZE;
  const xa = Math.max(0, x - 1);
  const xb = Math.min(N - 1, x);
  const ya = Math.max(0, y - 1);
  const yb = Math.min(N - 1, y);
  return (f.h[ya * N + xa] + f.h[ya * N + xb] + f.h[yb * N + xa] + f.h[yb * N + xb]) * 0.25;
}

function cornerWater(f: TerrainFields, x: number, y: number) {
  const N = GRID_SIZE;
  const xa = Math.max(0, x - 1);
  const xb = Math.min(N - 1, x);
  const ya = Math.max(0, y - 1);
  const yb = Math.min(N - 1, y);
  return (f.water[ya * N + xa] + f.water[ya * N + xb] + f.water[yb * N + xa] + f.water[yb * N + xb]) * 0.25;
}

/**
 * Emit the marching-squares segments for one cell at one level into `path`.
 * Corner values a=TL, b=TR, c=BR, d=BL; sx/sy is the cell's top-left in screen
 * space and s the cell edge length in pixels.
 */
function msCell(path: Path2D, a: number, b: number, c: number, d: number, L: number, sx: number, sy: number, s: number) {
  const code = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
  if (code === 0 || code === 15) return;
  const lerp = (v0: number, v1: number) => (L - v0) / (v1 - v0 || 1e-6);
  const top = () => ({ x: sx + s * lerp(a, b), y: sy });
  const right = () => ({ x: sx + s, y: sy + s * lerp(b, c) });
  const bottom = () => ({ x: sx + s * lerp(d, c), y: sy + s });
  const left = () => ({ x: sx, y: sy + s * lerp(a, d) });
  const seg = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    path.moveTo(p.x, p.y);
    path.lineTo(q.x, q.y);
  };
  switch (code) {
    case 1:
    case 14:
      seg(left(), top());
      break;
    case 2:
    case 13:
      seg(top(), right());
      break;
    case 3:
    case 12:
      seg(left(), right());
      break;
    case 4:
    case 11:
      seg(right(), bottom());
      break;
    case 6:
    case 9:
      seg(top(), bottom());
      break;
    case 7:
    case 8:
      seg(left(), bottom());
      break;
    case 5:
      seg(left(), top());
      seg(right(), bottom());
      break;
    case 10:
      seg(top(), right());
      seg(left(), bottom());
      break;
    default:
      break;
  }
}

function drawContours(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const f = terrainFields(state.tiles);
  const minor = new Path2D();
  const index = new Path2D();
  const coast = new Path2D();
  const showMinor = s >= 7;

  for (let y = y0; y <= y1 + 1; y++) {
    for (let x = x0; x <= x1 + 1; x++) {
      const a = cornerH(f, x, y);
      const b = cornerH(f, x + 1, y);
      const c = cornerH(f, x + 1, y + 1);
      const d = cornerH(f, x, y + 1);
      const { sx, sy } = worldToScreen(camera, width, height, x - 0.5, y - 0.5);

      // Coastline: the 0.5 iso-line of the water mask, so the shore is a smooth
      // curve rather than a staircase of tile edges.
      const wa = cornerWater(f, x, y);
      const wb = cornerWater(f, x + 1, y);
      const wc = cornerWater(f, x + 1, y + 1);
      const wd = cornerWater(f, x, y + 1);
      if (Math.max(wa, wb, wc, wd) > 0.5 && Math.min(wa, wb, wc, wd) <= 0.5) {
        msCell(coast, wa, wb, wc, wd, 0.5, sx, sy, s);
      }

      // Contours are suppressed over open water.
      if (Math.min(wa, wb, wc, wd) > 0.6) continue;
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      const kStart = Math.floor(lo * CONTOUR_BANDS) + 1;
      const kEnd = Math.floor(hi * CONTOUR_BANDS);
      for (let k = kStart; k <= kEnd; k++) {
        const isIndex = k % INDEX_EVERY === 0;
        if (!isIndex && !showMinor) continue;
        msCell(isIndex ? index : minor, a, b, c, d, k / CONTOUR_BANDS, sx, sy, s);
      }
    }
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (showMinor) {
    ctx.strokeStyle = 'rgba(58,40,20,0.30)';
    ctx.lineWidth = Math.max(0.6, s * 0.022);
    ctx.stroke(minor);
  }
  ctx.strokeStyle = 'rgba(50,32,12,0.55)';
  ctx.lineWidth = Math.max(1, s * 0.055);
  ctx.stroke(index);
  ctx.strokeStyle = 'rgba(14,32,48,0.75)';
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.stroke(coast);
}

/** A neat drawn edge to the sheet, so the map ends deliberately. */
function drawSheetEdge(rc: RenderContext) {
  const { ctx, width, height, camera } = rc;
  const tl = worldToScreen(camera, width, height, -0.5, -0.5);
  const br = worldToScreen(camera, width, height, GRID_SIZE - 0.5, GRID_SIZE - 0.5);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18;
  ctx.strokeStyle = 'rgba(215,232,245,0.32)';
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy);
  ctx.restore();
}

/** Faint graticule so scale stays legible without a hard per-tile grid. */
function drawGraticule(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const path = new Path2D();
  const gx0 = Math.ceil((x0 - 0.5) / 10) * 10;
  const gy0 = Math.ceil((y0 - 0.5) / 10) * 10;
  const top = worldToScreen(camera, width, height, x0 - 0.5, y0 - 0.5);
  const bot = worldToScreen(camera, width, height, x1 + 0.5, y1 + 0.5);
  for (let gx = gx0; gx <= x1 + 0.5; gx += 10) {
    const { sx } = worldToScreen(camera, width, height, gx - 0.5, 0);
    path.moveTo(sx, top.sy);
    path.lineTo(sx, bot.sy);
  }
  for (let gy = gy0; gy <= y1 + 0.5; gy += 10) {
    const { sy } = worldToScreen(camera, width, height, 0, gy - 0.5);
    path.moveTo(top.sx, sy);
    path.lineTo(bot.sx, sy);
  }
  ctx.strokeStyle = 'rgba(215,232,245,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke(path);

  // Per-tile grid only whispers in at close zoom, and never competes with the
  // terrain: it is there to make tile boundaries countable, not visible.
  if (s >= 15) {
    const fine = new Path2D();
    for (let x = x0; x <= x1 + 1; x++) {
      const { sx } = worldToScreen(camera, width, height, x - 0.5, 0);
      fine.moveTo(sx, top.sy);
      fine.lineTo(sx, bot.sy);
    }
    for (let y = y0; y <= y1 + 1; y++) {
      const { sy } = worldToScreen(camera, width, height, 0, y - 0.5);
      fine.moveTo(top.sx, sy);
      fine.lineTo(bot.sx, sy);
    }
    ctx.strokeStyle = `rgba(230,240,250,${Math.min(0.05, (s - 15) * 0.006 + 0.02)})`;
    ctx.lineWidth = 1;
    ctx.stroke(fine);
  }
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

export function render(rc: RenderContext) {
  const { ctx, width, height, camera, state } = rc;
  ctx.save();
  // Beyond the sheet is open sea, not void — the board reads as a chart of a
  // coastline rather than a rectangle floating in black.
  const sea = ctx.createLinearGradient(0, 0, 0, height);
  sea.addColorStop(0, '#0b1a26');
  sea.addColorStop(1, '#08131c');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, width, height);

  const { x0, x1, y0, y1 } = visibleTileRange(camera, width, height);
  const s = camera.scale;
  const detail = s >= 11; // sprite detail only when zoomed enough
  const pulse = rc.pulse ?? 0;

  drawRelief(rc, x0, x1, y0, y1);
  drawContours(rc, x0, x1, y0, y1);
  drawGraticule(rc, x0, x1, y0, y1);
  drawSheetEdge(rc);

  // ---- Linear water features (rivers) and bridges ----
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      if (tile.river && tile.terrain === 'WATER') drawRiver(rc, tile);
    }
  }

  // ---- Sprite detail (forest stipple, buildings, runways, quays, depots) ----
  if (detail) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) drawTileDetail(rc, state.tiles[y][x], s);
    }
  } else {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = state.tiles[y][x];
        if (t.isDepot) drawTileDetail(rc, t, s);
      }
    }
  }

  // ---- Roads ----
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      if (tile.road) drawRoad(rc, tile);
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      if (tile.bridge) drawBridge(rc, tile);
    }
  }

  // ---- Supply overlay ----
  if (rc.overlays.supply) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`;
        const { sx, sy } = worldToScreen(camera, width, height, x, y);
        const supplied = rc.supplySet.has(key);
        ctx.fillStyle = supplied ? 'rgba(120,200,140,0.12)' : 'rgba(200,60,60,0.12)';
        ctx.fillRect(sx - s / 2, sy - s / 2, s + 1, s + 1);
      }
    }
  }

  // ---- Attack range envelope (drawn under the movement wash) ----
  if (rc.selected) {
    const def = FORMATION_DEFS[rc.selected.type];
    drawRangeDiamond(rc, rc.selected.x, rc.selected.y, def.attackRange, 'rgba(193,82,74,0.75)', 'rgba(193,82,74,0.06)');
  }

  // ---- Movement range overlay ----
  if (rc.overlays.movement && rc.selected && rc.reachable.size) {
    const region = new Path2D();
    rc.reachable.forEach((_cost, key) => {
      const [x, y] = key.split(',').map(Number);
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      region.rect(sx - s / 2, sy - s / 2, s + 0.6, s + 0.6);
    });
    ctx.fillStyle = 'rgba(207,154,68,0.22)';
    ctx.fill(region);
    ctx.strokeStyle = 'rgba(230,182,101,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke(region);
  }

  // ---- Objectives ----
  if (rc.overlays.objectives) {
    for (const o of state.objectives) {
      if (o.x < x0 - 1 || o.x > x1 + 1 || o.y < y0 - 1 || o.y > y1 + 1) continue;
      const { sx, sy } = worldToScreen(camera, width, height, o.x, o.y);
      const color = o.controlledBy ? PLAYER_COLORS[o.controlledBy].main : UI.amber;
      const r = Math.max(5, s * 0.34);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = o.controlledBy ? PLAYER_COLORS[o.controlledBy].glow : 'rgba(207,154,68,0.32)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (s >= 7) {
        ctx.fillStyle = '#0e1216';
        ctx.font = `${Math.max(9, s * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(objectiveGlyph(o.kind), sx, sy + 0.5);
        ctx.fillStyle = color;
        ctx.fillText(objectiveGlyph(o.kind), sx, sy);
      }
      if (s >= 13) {
        drawLabel(rc, sx, sy + r + Math.max(7, s * 0.42), o.name.toUpperCase(), Math.max(8, s * 0.26), color, 0.06);
      }
    }
  }

  // ---- Settlement names ----
  if (rc.labels && s >= 6) {
    for (const l of rc.labels) {
      if (l.x < x0 - 2 || l.x > x1 + 2 || l.y < y0 - 2 || l.y > y1 + 2) continue;
      const { sx, sy } = worldToScreen(camera, width, height, l.x, l.y);
      drawLabel(rc, sx, sy - Math.max(9, s * 0.75), l.name.toUpperCase(), Math.max(9, Math.min(20, s * 0.5)), 'rgba(244,238,222,0.92)', 0.22);
    }
  }

  // ---- Engagement flash (battle report focus) ----
  if (rc.flashTiles?.length) {
    const a = 0.35 + 0.35 * Math.sin(pulse * Math.PI * 2);
    for (const t of rc.flashTiles) {
      const { sx, sy } = worldToScreen(camera, width, height, t.x, t.y);
      ctx.strokeStyle = `rgba(230,182,101,${a})`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(sx - s * 0.75, sy - s * 0.75, s * 1.5, s * 1.5);
    }
  }

  // ---- Attackable highlight ----
  if (rc.attackable.size) {
    Object.values(state.formations).forEach((f) => {
      if (!rc.attackable.has(f.id)) return;
      const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
      ctx.strokeStyle = UI.danger;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.58, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // ---- Contacts (suspected enemy) ----
  if (rc.overlays.intel) {
    const contacts = state.players[rc.viewer].contacts;
    Object.values(contacts).forEach((c) => {
      if (state.formations[c.formationId]) return; // live-visible, drawn solid below
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) return;
      const { sx, sy } = worldToScreen(camera, width, height, c.x, c.y);
      const alpha = Math.max(0.25, c.confidence / 100);
      ctx.fillStyle = `rgba(193,82,74,${alpha * 0.45})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(193,82,74,${alpha})`;
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (s >= 9) {
        ctx.fillStyle = `rgba(255,225,215,${alpha})`;
        ctx.font = `bold ${Math.max(8, s * 0.3)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', sx, sy + 1);
      }
    });
  }

  // ---- Formations ----
  Object.values(state.formations).forEach((f) => {
    if (!isFormationVisible(rc, f)) return;
    drawFormation(rc, f);
  });

  // ---- Selection ring ----
  if (rc.selected && state.formations[rc.selected.id]) {
    const f = state.formations[rc.selected.id];
    const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
    const r = Math.max(9, s * 0.62);
    ctx.strokeStyle = 'rgba(230,182,101,0.95)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Rotating dashed outer ring — unmistakable at any zoom.
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(pulse * Math.PI * 2);
    ctx.strokeStyle = `rgba(230,182,101,${0.45 + 0.25 * Math.sin(pulse * Math.PI * 2)})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([r * 0.5, r * 0.4]);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    // Corner brackets.
    const b = r * 1.7;
    ctx.strokeStyle = 'rgba(230,182,101,0.85)';
    ctx.lineWidth = 2;
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as [number, number][]) {
      ctx.beginPath();
      ctx.moveTo(sx + dx * b, sy + dy * b - dy * b * 0.4);
      ctx.lineTo(sx + dx * b, sy + dy * b);
      ctx.lineTo(sx + dx * b - dx * b * 0.4, sy + dy * b);
      ctx.stroke();
    }
  }

  // ---- Hover highlight ----
  if (rc.hoverTile) {
    const { x, y } = rc.hoverTile;
    if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) {
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - s / 2 + 0.5, sy - s / 2 + 0.5, s - 1, s - 1);
    }
  }

  ctx.restore();
}

function drawLabel(rc: RenderContext, sx: number, sy: number, text: string, size: number, color: string, spacing: number) {
  const { ctx } = rc;
  ctx.save();
  ctx.font = `600 ${size}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  (ctx as any).letterSpacing = `${(spacing * size).toFixed(2)}px`;
  ctx.lineWidth = Math.max(2, size * 0.3);
  ctx.strokeStyle = 'rgba(8,11,14,0.75)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, sx, sy);
  ctx.fillStyle = color;
  ctx.fillText(text, sx, sy);
  (ctx as any).letterSpacing = '0px';
  ctx.restore();
}

/** Manhattan-range envelope (the engine measures range as |dx|+|dy|). */
function drawRangeDiamond(rc: RenderContext, cx: number, cy: number, range: number, stroke: string, fill: string) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const c = worldToScreen(camera, width, height, cx, cy);
  const r = (range + 0.5) * s;
  ctx.beginPath();
  ctx.moveTo(c.sx, c.sy - r);
  ctx.lineTo(c.sx + r, c.sy);
  ctx.lineTo(c.sx, c.sy + r);
  ctx.lineTo(c.sx - r, c.sy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawTileDetail(rc: RenderContext, tile: Tile, s: number) {
  const { ctx, width, height, camera } = rc;
  const n = tileNoise(tile.x, tile.y);
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  const half = s / 2;
  const colors = TERRAIN_COLORS[tile.terrain];

  if (tile.terrain === 'FOREST') {
    for (let i = 0; i < 3; i++) {
      const jx = (((n * 977 * (i + 1)) % 1) - 0.5) * 0.72;
      const jy = (((n * 613 * (i + 2)) % 1) - 0.5) * 0.72;
      const tx = sx + jx * s;
      const ty = sy + jy * s;
      const r = s * 0.15;
      ctx.beginPath();
      ctx.arc(tx, ty - r * 0.3, r, 0, Math.PI * 2);
      ctx.fillStyle = shade(colors.dark, -14 + i * 7);
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  if (tile.terrain === 'URBAN' || tile.terrain === 'INDUSTRIAL') {
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const seed = (n * (i + 1) * (j + 2) * 17) % 1;
        if (seed < 0.28) continue;
        const bw = s * 0.3;
        const bh = s * (0.24 + seed * 0.2);
        const bx = sx - half + s * 0.12 + i * s * 0.46;
        const by = sy - half + s * 0.14 + j * s * 0.42;
        ctx.fillStyle = tile.terrain === 'URBAN' ? shade('#74747a', seed * 30 - 15) : shade('#57554d', seed * 24 - 12);
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(20,22,26,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      }
    }
  }

  if (tile.terrain === 'AIRFIELD') {
    ctx.fillStyle = 'rgba(58,58,54,0.9)';
    ctx.fillRect(sx - half, sy - s * 0.09, s + 1, s * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([s * 0.09, s * 0.09]);
    ctx.beginPath();
    ctx.moveTo(sx - half, sy);
    ctx.lineTo(sx + half, sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (tile.terrain === 'PORT') {
    ctx.strokeStyle = '#33332f';
    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.beginPath();
    ctx.moveTo(sx, sy + half * 0.5);
    ctx.lineTo(sx, sy - half * 0.5);
    ctx.lineTo(sx + half * 0.4, sy - half * 0.3);
    ctx.stroke();
  }

  if (tile.isDepot) {
    ctx.fillStyle = tile.depotOwner ? PLAYER_COLORS[tile.depotOwner].main : UI.amber;
    ctx.beginPath();
    ctx.moveTo(sx, sy - half * 0.5);
    ctx.lineTo(sx + half * 0.5, sy);
    ctx.lineTo(sx, sy + half * 0.5);
    ctx.lineTo(sx - half * 0.5, sy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#12161a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawRiver(rc: RenderContext, tile: Tile) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  ctx.strokeStyle = 'rgba(41,96,138,0.95)';
  ctx.lineWidth = Math.max(1.2, s * 0.22);
  ctx.lineCap = 'round';
  let any = false;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as [number, number][]) {
    const nt = state.tiles[tile.y + dy]?.[tile.x + dx];
    if (nt && nt.terrain === 'WATER') {
      any = true;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (dx * s) / 2, sy + (dy * s) / 2);
      ctx.stroke();
    }
  }
  if (!any) {
    ctx.beginPath();
    ctx.arc(sx, sy, s * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(41,96,138,0.95)';
    ctx.fill();
  }
}

function drawBridge(rc: RenderContext, tile: Tile) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  ctx.fillStyle = '#9d8154';
  ctx.fillRect(sx - s / 2, sy - s * 0.13, s + 1, s * 0.26);
  ctx.strokeStyle = 'rgba(40,30,16,0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx - s / 2, sy - s * 0.13, s + 1, s * 0.26);
}

function drawRoad(rc: RenderContext, tile: Tile) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  // Casing then fill — a road on a real sheet is a cased line, not a grey bar.
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? 'rgba(28,24,18,0.55)' : 'rgba(226,210,178,0.9)';
    ctx.lineWidth = pass === 0 ? Math.max(2, s * 0.19) : Math.max(1, s * 0.1);
    ctx.lineCap = 'round';
    let any = false;
    for (const [dx, dy] of dirs) {
      const nt = state.tiles[tile.y + dy]?.[tile.x + dx];
      if (nt && nt.road) {
        any = true;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + (dx * s) / 2, sy + (dy * s) / 2);
        ctx.stroke();
      }
    }
    if (!any && pass === 1) {
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.08, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(226,210,178,0.9)';
      ctx.fill();
    }
  }
}

function drawFormation(rc: RenderContext, f: Formation) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
  const pc = PLAYER_COLORS[f.owner];
  const r = Math.max(6, s * 0.34);

  ctx.beginPath();
  ctx.ellipse(sx, sy + r * 0.7, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = pc.dark;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.strokeStyle = pc.main;
  ctx.stroke();

  if (s >= 8) {
    ctx.fillStyle = pc.main;
    ctx.font = `bold ${Math.max(8, r * 0.85)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formationGlyph(f.type), sx, sy);
  }

  if (f.fortified) {
    ctx.strokeStyle = '#cf9a44';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.25, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  if (s >= 6) {
    const bw = r * 1.9;
    const bx = sx - bw / 2;
    const by = sy - r - Math.max(4, s * 0.16);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, 3);
    const pct = Math.max(0, Math.min(1, f.strength / 100));
    ctx.fillStyle = pct > 0.6 ? '#93a35f' : pct > 0.3 ? '#cf9a44' : '#c1524a';
    ctx.fillRect(bx, by, bw * pct, 3);
  }

  if (s >= 16 && f.owner === rc.viewer) {
    drawLabel(rc, sx, sy + r + Math.max(7, s * 0.34), f.shortName, Math.max(8, s * 0.24), 'rgba(232,238,236,0.9)', 0.04);
  }
}

export { worldToScreen, visibleTileRange };
