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
import { Contact, DetectionLevel, Formation, GameState, GRID_SIZE, Objective, PlayerId, Tile, gridRef } from '../game/types';
import { PLAYER_COLORS, TERRAIN_COLORS, UI } from './colors';
import { getIconBitmap } from './icons';

/** Contour interval, as a fraction of the full 0..1 height range. */
const CONTOUR_BANDS = 20;
/** Every Nth contour is an "index" contour — thicker and darker, as on a real sheet. */
const INDEX_EVERY = 5;
/** Subpixel budget for the relief raster; drives the adaptive supersample factor. */
const RELIEF_PIXEL_BUDGET = 62000;

export interface Camera {
  x: number; // world-space (tile units) of viewport center
  y: number;
  scale: number; // pixels per tile
}

export interface Overlays {
  movement: boolean;
  intel: boolean;
  objectives: boolean;
}

/**
 * A transient "new contact here" marker. The map pings the tile for a few
 * seconds so a spotting event during the opponent's turn is impossible to miss
 * without stopping the player mid-order.
 */
export interface ContactPing {
  x: number;
  y: number;
  /** performance.now() timestamp the ping was raised at. */
  at: number;
  level: DetectionLevel;
}

/** How long a contact ping stays on the sheet. */
export const PING_LIFETIME_MS = 7000;

/**
 * A transient "formation destroyed here" marker (phase 7). Derived client-side
 * from GameState.killFeed (already fog-redacted per viewer) the same way
 * ContactPing is derived from newly-arrived contacts.
 */
export interface KillMarker {
  id: string;
  x: number;
  y: number;
  at: number;
  owner: PlayerId;
  /** Present only when the viewer's detection had reached IDENTIFIED or better. */
  type?: Formation['type'];
}

/** How long a kill marker stays on the sheet. */
export const KILL_MARKER_LIFETIME_MS = 5500;

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
  hoverTile: { x: number; y: number } | null;
  /** Settlement names to letter onto the sheet at sufficient zoom. */
  labels?: MapLabel[];
  /** Transient new-contact pings. */
  pings?: ContactPing[];
  /** Transient "destroyed here" wreck markers. */
  kills?: KillMarker[];
  /** Enemy Zone of Control tiles, shown while a move order is armed. */
  zocTiles?: Set<string>;
  /** Tiles to flash (e.g. the two ends of the engagement a battle report describes). */
  flashTiles?: { x: number; y: number }[];
  /** Formation ids currently grouped for a Move Formation order. */
  groupIds?: string[];
  /** The exact path the hovered destination would be reached by. */
  pathPreview?: { x: number; y: number }[];
  /** Draw the path in the refusal colour (the destination is not legal). */
  pathInvalid?: boolean;
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
    case 'GUARDS':
      return 'GD';
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
  /**
   * 1 for *broad* water (sea, estuaries, lakes) — the only water the smoothed
   * raster and the coastline iso-line know about. Narrow river channels are
   * deliberately EXCLUDED (see `channel`): a one-tile watercourse pushed
   * through an isotropic blur bled a soft blue fringe a full tile wide across
   * both banks, which was the single biggest source of mush on the sheet.
   */
  water: Float32Array;
  /** 1 for narrow river-channel tiles, which are drawn purely as cased lines. */
  channel: Float32Array;
  /** Per-tile base colour channels of the terrain palette. */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** Dominant local maxima, for spot heights. Derived once per map. */
  peaks: { x: number; y: number; h: number }[];
}

let fieldCacheKey: Tile[][] | null = null;
let fieldCache: TerrainFields | null = null;

function terrainFields(tiles: Tile[][]): TerrainFields {
  if (fieldCacheKey === tiles && fieldCache) return fieldCache;
  const N = GRID_SIZE;
  const raw = new Float32Array(N * N);
  const water = new Float32Array(N * N);
  const channel = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  const g = new Float32Array(N * N);
  const b = new Float32Array(N * N);
  const isWater = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < N && y < N && tiles[y][x].terrain === 'WATER';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tiles[y][x];
      const i = y * N + x;
      raw[i] = t.height;
      water[i] = t.terrain === 'WATER' ? 1 : 0;
      const hex = TERRAIN_COLORS[t.terrain].base;
      const n = parseInt(hex.slice(1), 16);
      // A touch of deterministic per-tile variance keeps large flats from
      // reading as flat vector fill once the raster is smoothed. Kept low —
      // the old amount read as film grain over every field on the sheet.
      const jitter = (tileNoise(x, y) - 0.5) * 4;
      r[i] = ((n >> 16) & 255) + jitter;
      g[i] = ((n >> 8) & 255) + jitter;
      b[i] = (n & 255) + jitter;
    }
  }
  // Narrow watercourses are lifted OUT of the smoothed water mask and painted
  // with their own banks' colour; `drawRiver` then draws them as crisp cased
  // lines. A channel is a river tile with few water neighbours — an estuary or
  // a broad lower reach keeps enough neighbours to stay "real" water and so
  // still gets a coastline and a depth ramp.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = tiles[y][x];
      if (t.terrain !== 'WATER' || !t.river) continue;
      let wet = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (isWater(x + dx, y + dy)) wet++;
        }
      }
      if (wet > 4) continue;
      const i = y * N + x;
      channel[i] = 1;
      water[i] = 0;
      // Bank colour: mean of the surrounding dry land, so the channel sits in
      // its valley instead of punching a blue hole in it.
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          if (tiles[ny][nx].terrain === 'WATER') continue;
          const hex = TERRAIN_COLORS[tiles[ny][nx].terrain].base;
          const n = parseInt(hex.slice(1), 16);
          cr += (n >> 16) & 255;
          cg += (n >> 8) & 255;
          cb += n & 255;
          cnt++;
        }
      }
      if (cnt) {
        r[i] = cr / cnt;
        g[i] = cg / cnt;
        b[i] = cb / cnt;
      }
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
  // Dominant local maxima, for spot heights. Cheap, and derived once per map.
  const peaks: { x: number; y: number; h: number }[] = [];
  for (let y = 2; y < N - 2; y++) {
    for (let x = 2; x < N - 2; x++) {
      const i = y * N + x;
      if (water[i] > 0.5 || h[i] < 0.5) continue;
      let top = true;
      for (let dy = -2; dy <= 2 && top; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if ((!dx && !dy) || h[(y + dy) * N + (x + dx)] <= h[i]) continue;
          top = false;
          break;
        }
      }
      if (top) peaks.push({ x, y, h: h[i] });
    }
  }
  peaks.sort((a, c) => c.h - a.h);
  // Thin to a well-spread set so spot heights never crowd each other.
  const spread: typeof peaks = [];
  for (const p of peaks) {
    if (spread.length >= 26) break;
    if (spread.some((q) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 9)) continue;
    spread.push(p);
  }

  fieldCache = { h, gx, gy, water, channel, r, g, b, peaks: spread };
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
  const ss = Math.max(2, Math.min(8, Math.floor(Math.sqrt(RELIEF_PIXEL_BUDGET / Math.max(1, tw * th)))));
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
        if (wet > 0.2) {
          // Shoreline blend — a soft wet fringe instead of a stair-stepped edge.
          // Only broad water reaches this code now (narrow river channels are
          // masked out upstream), so the fringe belongs to real shorelines and
          // is tightened further to keep the coast a *line*, not a gradient.
          const k = Math.max(0, Math.min(1, (wet - 0.28) / 0.34)) * 0.85;
          cr += (WATER_SHALLOW[0] - cr) * k;
          cg += (WATER_SHALLOW[1] - cg) * k;
          cb += (WATER_SHALLOW[2] - cb) * k;
        }
        // Hillshade from a north-west light over the smoothed gradient.
        const dx = bilinear(f.gx, ix, iy, fx, fy, N);
        const dy = bilinear(f.gy, ix, iy, fx, fy, N);
        let lit = (-dx - dy) * 12;
        lit = lit > 1 ? 1 : lit < -1 ? -1 : lit;
        const dry = 1 - Math.min(1, wet * 2);
        if (lit > 0) {
          // Softer than phase 2: relief should describe the landform, not
          // compete with the counters standing on it.
          const k = lit * 0.26 * dry;
          cr += (255 - cr) * k;
          cg += (250 - cg) * k;
          cb += (228 - cb) * k;
        } else {
          const k = -lit * 0.32 * dry;
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

/**
 * Height 0..1 -> a plausible metre figure for contour labels and spot heights.
 * Matches the scale the generator uses when it names hills ("Hill 312").
 */
function metres(hNorm: number) {
  return Math.round(hNorm * 400 + 60);
}

/** Midpoint + direction of the first marching-squares segment in one cell. */
function msMidpoint(a: number, b: number, c: number, d: number, L: number, sx: number, sy: number, s: number) {
  const code = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
  if (code === 0 || code === 15 || code === 5 || code === 10) return null;
  const lerp = (v0: number, v1: number) => (L - v0) / (v1 - v0 || 1e-6);
  const top = { x: sx + s * lerp(a, b), y: sy };
  const right = { x: sx + s, y: sy + s * lerp(b, c) };
  const bottom = { x: sx + s * lerp(d, c), y: sy + s };
  const left = { x: sx, y: sy + s * lerp(a, d) };
  let p = left;
  let q = top;
  switch (code) {
    case 1: case 14: p = left; q = top; break;
    case 2: case 13: p = top; q = right; break;
    case 3: case 12: p = left; q = right; break;
    case 4: case 11: p = right; q = bottom; break;
    case 6: case 9: p = top; q = bottom; break;
    case 7: case 8: p = left; q = bottom; break;
    default: return null;
  }
  let ang = Math.atan2(q.y - p.y, q.x - p.x);
  // Keep labels upright.
  if (ang > Math.PI / 2) ang -= Math.PI;
  if (ang < -Math.PI / 2) ang += Math.PI;
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, ang };
}

function drawContours(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const f = terrainFields(state.tiles);
  const minor = new Path2D();
  const index = new Path2D();
  const coast = new Path2D();
  // Minor contours only appear once there is room for them to read as lines
  // rather than as texture, and they fade in rather than snapping on.
  const showMinor = s >= 9;
  const minorAlpha = Math.min(0.3, 0.12 + (s - 9) * 0.025);
  // Index contours carry a height figure at close zoom, placed on a coarse
  // lattice so they are spread over the sheet instead of clustered.
  const labelContours = s >= 14;
  const labels: { x: number; y: number; ang: number; text: string }[] = [];

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
        const L = k / CONTOUR_BANDS;
        msCell(isIndex ? index : minor, a, b, c, d, L, sx, sy, s);
        if (isIndex && labelContours && labels.length < 14 && x % 11 === 4 && y % 11 === 4) {
          const m = msMidpoint(a, b, c, d, L, sx, sy, s);
          if (m) labels.push({ ...m, text: `${metres(L)}` });
        }
      }
    }
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (showMinor) {
    ctx.strokeStyle = `rgba(58,40,20,${minorAlpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.6, s * 0.02);
    ctx.stroke(minor);
  }
  ctx.strokeStyle = 'rgba(56,36,12,0.52)';
  ctx.lineWidth = Math.max(1, s * 0.045);
  ctx.stroke(index);
  // Coastline: a dark casing plus a pale inner line reads as a drawn shore at
  // every zoom, where a single mid-tone stroke used to disappear over sand.
  ctx.strokeStyle = 'rgba(10,26,40,0.85)';
  ctx.lineWidth = Math.max(1.4, s * 0.075);
  ctx.stroke(coast);
  ctx.strokeStyle = 'rgba(196,222,238,0.35)';
  ctx.lineWidth = Math.max(0.6, s * 0.028);
  ctx.stroke(coast);

  if (labels.length) drawContourLabels(rc, labels, s);
  if (s >= 13) drawSpotHeights(rc, f, x0, x1, y0, y1, s);
}

/** Height figures lettered along the index contours, as on a real sheet. */
function drawContourLabels(rc: RenderContext, labels: { x: number; y: number; ang: number; text: string }[], s: number) {
  const { ctx } = rc;
  const size = Math.max(8, Math.min(12, s * 0.34));
  ctx.save();
  ctx.font = `600 ${size}px Rajdhani, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.ang);
    // A pale halo stands in for the cartographer's break in the line: the
    // contour reads as passing behind the figure without punching a hole in
    // the sheet.
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(240,234,214,0.72)';
    ctx.strokeText(l.text, 0, 0);
    ctx.fillStyle = 'rgba(46,30,10,0.85)';
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** Spot heights on the dominant summits — the quickest read of "high ground". */
function drawSpotHeights(rc: RenderContext, f: TerrainFields, x0: number, x1: number, y0: number, y1: number, s: number) {
  const { ctx, width, height, camera } = rc;
  const size = Math.max(8, Math.min(12, s * 0.32));
  ctx.save();
  ctx.font = `600 ${size}px Rajdhani, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const p of f.peaks) {
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    const { sx, sy } = worldToScreen(camera, width, height, p.x, p.y);
    ctx.fillStyle = 'rgba(46,30,10,0.85)';
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(1.2, s * 0.055), 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = 'rgba(244,238,222,0.5)';
    ctx.lineJoin = 'round';
    ctx.strokeText(`${metres(p.h)}`, sx + size * 0.45, sy - size * 0.1);
    ctx.fillText(`${metres(p.h)}`, sx + size * 0.45, sy - size * 0.1);
  }
  ctx.restore();
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
  drawRivers(rc, x0, x1, y0, y1);

  // ---- Built-up areas (street grid + building footprints) ----
  if (s >= 9) drawBuiltUp(rc, x0, x1, y0, y1);

  // ---- Sprite detail (forest stipple, runways, quays, depots) ----
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

  // ---- Attack range envelope (drawn under the movement wash) ----
  if (rc.selected) {
    const def = FORMATION_DEFS[rc.selected.type];
    drawRangeDiamond(rc, rc.selected.x, rc.selected.y, def.attackRange, 'rgba(193,82,74,0.75)', 'rgba(193,82,74,0.06)');
  }

  // ---- Movement range overlay ----
  if (rc.overlays.movement && rc.selected && rc.reachable.size) {
    const region = new Path2D();
    // Only the OUTER boundary of the reachable set is stroked. Stroking every
    // tile rect (phase 2) drew a bright amber grid across the whole wash, which
    // was the noisiest thing on the sheet and hid everything under it.
    const border = new Path2D();
    rc.reachable.forEach((_cost, key) => {
      const [x, y] = key.split(',').map(Number);
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      region.rect(sx - s / 2 - 0.3, sy - s / 2 - 0.3, s + 0.6, s + 0.6);
      const l = sx - s / 2;
      const r = sx + s / 2;
      const t = sy - s / 2;
      const bm = sy + s / 2;
      if (!rc.reachable.has(`${x - 1},${y}`)) {
        border.moveTo(l, t);
        border.lineTo(l, bm);
      }
      if (!rc.reachable.has(`${x + 1},${y}`)) {
        border.moveTo(r, t);
        border.lineTo(r, bm);
      }
      if (!rc.reachable.has(`${x},${y - 1}`)) {
        border.moveTo(l, t);
        border.lineTo(r, t);
      }
      if (!rc.reachable.has(`${x},${y + 1}`)) {
        border.moveTo(l, bm);
        border.lineTo(r, bm);
      }
    });
    ctx.fillStyle = 'rgba(207,154,68,0.16)';
    ctx.fill(region);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(18,14,8,0.55)';
    ctx.lineWidth = Math.max(2.4, s * 0.1);
    ctx.stroke(border);
    ctx.strokeStyle = 'rgba(236,190,110,0.95)';
    ctx.lineWidth = Math.max(1.2, s * 0.05);
    ctx.stroke(border);
  }

  // ---- Zones of Control (phase 7) — shown automatically while a move order
  // is armed, so the player sees exactly what will stop or tax their move. ----
  if (rc.zocTiles?.size) {
    const region = new Path2D();
    rc.zocTiles.forEach((key) => {
      const [zx, zy] = key.split(',').map(Number);
      if (zx < x0 - 1 || zx > x1 + 1 || zy < y0 - 1 || zy > y1 + 1) return;
      const { sx, sy } = worldToScreen(camera, width, height, zx, zy);
      region.rect(sx - s / 2 - 0.3, sy - s / 2 - 0.3, s + 0.6, s + 0.6);
      // Diagonal hatch reads as "contested ground" without competing with the
      // amber reachable wash underneath it.
      const hatch = new Path2D();
      const step = Math.max(4, s * 0.22);
      for (let o = -s; o < s * 2; o += step) {
        hatch.moveTo(sx - s / 2 + o, sy + s / 2);
        hatch.lineTo(sx - s / 2 + o + s, sy - s / 2);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx - s / 2, sy - s / 2, s, s);
      ctx.clip();
      ctx.strokeStyle = 'rgba(193,82,74,0.55)';
      ctx.lineWidth = Math.max(1, s * 0.045);
      ctx.stroke(hatch);
      ctx.restore();
    });
    ctx.strokeStyle = 'rgba(193,82,74,0.8)';
    ctx.lineWidth = Math.max(1.2, s * 0.05);
    ctx.setLineDash([3, 2]);
    ctx.stroke(region);
    ctx.setLineDash([]);
  }

  // ---- Objectives ----
  if (rc.overlays.objectives) {
    for (const o of state.objectives) {
      if (o.x < x0 - 1 || o.x > x1 + 1 || o.y < y0 - 1 || o.y > y1 + 1) continue;
      const { sx, sy } = worldToScreen(camera, width, height, o.x, o.y);
      const color = o.controlledBy ? PLAYER_COLORS[o.controlledBy].main : UI.amber;
      const r = Math.max(5, s * 0.34);
      // Dark casing first: an objective must never get lost in forest, urban
      // fabric or a hillshade shadow.
      ctx.beginPath();
      ctx.arc(sx, sy, r + Math.max(1.6, r * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10,13,17,0.72)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = o.controlledBy ? PLAYER_COLORS[o.controlledBy].glow : 'rgba(207,154,68,0.42)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.22);
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
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(12,10,10,0.7)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.58, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#e06a5e';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  // ---- Contacts (position-only blips; IDENTIFIED+ draw as counters below) ----
  if (rc.overlays.intel) {
    const contacts = state.players[rc.viewer].contacts;
    Object.values(contacts).forEach((c) => {
      if (state.formations[c.formationId]) return; // identified/confirmed — drawn as a counter
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) return;
      drawContactMarker(rc, c);
    });
  }

  drawPings(rc);
  drawKillMarkers(rc);

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
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(10,13,17,0.7)';
    ctx.lineWidth = 5.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,196,112,0.98)';
    ctx.lineWidth = 2.5;
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

  // ---- Move Formation group brackets ----
  if (rc.groupIds?.length) {
    for (const id of rc.groupIds) {
      const f = state.formations[id];
      if (!f) continue;
      const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
      const r = Math.max(8, s * 0.55);
      ctx.strokeStyle = 'rgba(10,13,17,0.7)';
      ctx.lineWidth = 5;
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
      ctx.strokeStyle = 'rgba(111,168,201,0.95)';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - r, sy - r, r * 2, r * 2);
    }
  }

  // ---- Path preview to the hovered destination ----
  if (rc.pathPreview?.length && rc.selected) {
    const pts = [{ x: rc.selected.x, y: rc.selected.y }, ...rc.pathPreview];
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const { sx, sy } = worldToScreen(camera, width, height, p.x, p.y);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.strokeStyle = 'rgba(10,13,17,0.8)';
    ctx.lineWidth = Math.max(5, s * 0.3);
    ctx.stroke();
    ctx.strokeStyle = rc.pathInvalid ? 'rgba(224,106,94,0.95)' : 'rgba(240,196,112,0.95)';
    ctx.lineWidth = Math.max(2.2, s * 0.15);
    ctx.stroke();
    // Destination pip.
    const last = pts[pts.length - 1];
    const { sx, sy } = worldToScreen(camera, width, height, last.x, last.y);
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(3.5, s * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = rc.pathInvalid ? 'rgba(224,106,94,0.95)' : 'rgba(240,196,112,0.95)';
    ctx.fill();
    ctx.restore();
  }

  // ---- Hover highlight ----
  if (rc.hoverTile) {
    const { x, y } = rc.hoverTile;
    if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) {
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - s / 2 + 0.5, sy - s / 2 + 0.5, s - 1, s - 1);
      if (s >= 11) {
        drawLabel(rc, sx, sy - s * 0.72, gridRef(x, y), Math.max(9, s * 0.28), 'rgba(236,232,220,0.9)', 0.08);
      }
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
    // Two low-contrast crowns per tile. Phase 2 drew three hard, dark blobs,
    // which turned every stand into a field of noise that swallowed counters.
    for (let i = 0; i < 2; i++) {
      const jx = (((n * 977 * (i + 1)) % 1) - 0.5) * 0.62;
      const jy = (((n * 613 * (i + 2)) % 1) - 0.5) * 0.62;
      const tx = sx + jx * s;
      const ty = sy + jy * s;
      const r = s * 0.16;
      ctx.beginPath();
      ctx.arc(tx, ty - r * 0.3, r, 0, Math.PI * 2);
      ctx.fillStyle = shade(colors.dark, -4 + i * 8);
      ctx.globalAlpha = 0.42;
      ctx.fill();
      ctx.globalAlpha = 1;
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

/**
 * Rivers, drawn as proper cased lines over the terrain raster.
 *
 * Narrow channels no longer exist in the smoothed water mask at all (see
 * `terrainFields`), so this pass is the *only* thing that puts a river on the
 * sheet — which is exactly why it can be crisp: a dark casing, a blue core and
 * a hairline highlight, batched into three strokes for the whole window.
 */
function drawRivers(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const path = new Path2D();
  const dots: { x: number; y: number }[] = [];
  const N4D: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      if (!tile.river || tile.terrain !== 'WATER') continue;
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      const ends: { x: number; y: number }[] = [];
      for (const [dx, dy] of N4D) {
        const nt = state.tiles[y + dy]?.[x + dx];
        if (nt && nt.terrain === 'WATER') ends.push({ x: sx + (dx * s) / 2, y: sy + (dy * s) / 2 });
      }
      if (ends.length === 0) {
        dots.push({ x: sx, y: sy });
      } else if (ends.length === 2) {
        // A through-flowing tile: bend the channel round its centre so the
        // watercourse meanders instead of climbing a staircase of right angles.
        path.moveTo(ends[0].x, ends[0].y);
        path.quadraticCurveTo(sx, sy, ends[1].x, ends[1].y);
      } else {
        // Source, mouth or confluence: straight spokes from the centre.
        for (const e of ends) {
          path.moveTo(sx, sy);
          path.lineTo(e.x, e.y);
        }
      }
    }
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const core = Math.max(1, s * 0.1);
  ctx.strokeStyle = 'rgba(16,42,64,0.55)';
  ctx.lineWidth = core + Math.max(1, s * 0.055);
  ctx.stroke(path);
  ctx.strokeStyle = '#3f7fac';
  ctx.lineWidth = core;
  ctx.stroke(path);
  for (const d of dots) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(1, s * 0.09), 0, Math.PI * 2);
    ctx.fillStyle = '#3f7fac';
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Built-up areas.
 *
 * Phase 2 stamped a 2x2 grid of identical blocks into every urban tile, which
 * read as a texture swatch rather than a town. Here each urban tile is one
 * CITY BLOCK: the streets are the tile boundaries (so they run continuously
 * across the whole settlement and line up with the road network), every fourth
 * world line is a wider avenue, and the interior of each block is split into a
 * handful of varied building footprints by a deterministic binary subdivision.
 * A share of blocks are left open as yards/parks so the town is not uniform.
 */
function isBuiltUp(t: Tile) {
  return t.terrain === 'URBAN' || t.terrain === 'INDUSTRIAL';
}

function drawBuiltUp(rc: RenderContext, x0: number, x1: number, y0: number, y1: number) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const half = s / 2;
  const tiles = state.tiles;

  // --- 1. Block ground: a flat paved base so buildings sit on something. ---
  const ground = new Path2D();
  let anyBuilt = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isBuiltUp(tiles[y][x])) continue;
      anyBuilt = true;
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      ground.rect(sx - half, sy - half, s + 1, s + 1);
    }
  }
  if (!anyBuilt) return;
  ctx.save();
  ctx.fillStyle = 'rgba(58,58,60,0.30)';
  ctx.fill(ground);

  // --- 2. Streets along block boundaries, avenues every fourth line. -------
  const street = new Path2D();
  const avenue = new Path2D();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isBuiltUp(tiles[y][x])) continue;
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      // A vertical street on this block's west edge, if the neighbour is built.
      if (tiles[y][x - 1] && isBuiltUp(tiles[y][x - 1])) {
        (x % 4 === 1 ? avenue : street).moveTo(sx - half, sy - half);
        (x % 4 === 1 ? avenue : street).lineTo(sx - half, sy + half);
      }
      if (tiles[y - 1]?.[x] && isBuiltUp(tiles[y - 1][x])) {
        (y % 4 === 2 ? avenue : street).moveTo(sx - half, sy - half);
        (y % 4 === 2 ? avenue : street).lineTo(sx + half, sy - half);
      }
    }
  }
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(206,198,178,0.42)';
  ctx.lineWidth = Math.max(1, s * 0.09);
  ctx.stroke(street);
  ctx.strokeStyle = 'rgba(222,214,192,0.6)';
  ctx.lineWidth = Math.max(1.4, s * 0.15);
  ctx.stroke(avenue);

  // --- 3. Building footprints inside each block. --------------------------
  if (s < 11) {
    ctx.restore();
    return;
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = tiles[y][x];
      if (!isBuiltUp(t)) continue;
      const n = tileNoise(x, y);
      // Open ground: yards, parks, car parks. Keeps a town from tiling.
      if (n < 0.14) continue;
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      const inset = Math.max(1, s * 0.11);
      const industrial = t.terrain === 'INDUSTRIAL';
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      subdivide(
        sx - half + inset,
        sy - half + inset,
        s - inset * 2,
        s - inset * 2,
        industrial ? 1 : 2,
        n,
        Math.max(2.5, s * (industrial ? 0.3 : 0.19)),
        rects
      );
      for (let i = 0; i < rects.length; i++) {
        const b = rects[i];
        const v = (n * 997 * (i + 3)) % 1;
        if (v < (industrial ? 0.1 : 0.2)) continue; // a gap in the terrace
        const g = Math.max(0.5, s * 0.02);
        const bw = b.w - g;
        const bh = b.h - g;
        if (bw < 1 || bh < 1) continue;
        ctx.fillStyle = industrial ? shade('#6d6a60', v * 24 - 12) : shade(v > 0.68 ? '#8d8478' : '#83838a', v * 34 - 17);
        ctx.fillRect(b.x, b.y, bw, bh);
        // One dark south-east edge gives the block relief without a shadow pass.
        ctx.fillStyle = 'rgba(22,24,28,0.45)';
        ctx.fillRect(b.x, b.y + bh - Math.max(0.6, s * 0.02), bw, Math.max(0.6, s * 0.02));
        ctx.fillRect(b.x + bw - Math.max(0.6, s * 0.02), b.y, Math.max(0.6, s * 0.02), bh);
      }
    }
  }
  ctx.restore();
}

/** Deterministic binary subdivision of a block into building footprints. */
function subdivide(
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number,
  seed: number,
  minSize: number,
  out: { x: number; y: number; w: number; h: number }[]
) {
  if (depth <= 0 || (w < minSize * 2 && h < minSize * 2) || out.length > 12) {
    out.push({ x, y, w, h });
    return;
  }
  const v = Math.sin(seed * 91.7 + out.length * 13.1 + depth * 3.7) * 43758.5453;
  const r = v - Math.floor(v);
  const t = 0.35 + r * 0.3;
  if (w >= h) {
    const cut = w * t;
    subdivide(x, y, cut, h, depth - 1, seed * 1.37 + 0.11, minSize, out);
    subdivide(x + cut, y, w - cut, h, depth - 1, seed * 0.71 + 0.29, minSize, out);
  } else {
    const cut = h * t;
    subdivide(x, y, w, cut, depth - 1, seed * 1.61 + 0.07, minSize, out);
    subdivide(x, y + cut, w, h - cut, depth - 1, seed * 0.83 + 0.43, minSize, out);
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

// ---------------------------------------------------------------------------
// Detection states
//
// Every rung is distinguished by SYMBOL as well as colour, so the four states
// stay separable without relying on colour perception:
//
//   CONTACT     dashed circle, hollow, "?"          (amber-red)
//   IDENTIFIED  dashed counter, arm glyph, "?" badge (orange)
//   CONFIRMED   solid counter, arm glyph, "✓" badge  (full enemy red)
//
// UNKNOWN draws nothing at all — the client is never sent it.
// ---------------------------------------------------------------------------

export const DETECTION_COLORS: Record<'CONTACT' | 'IDENTIFIED' | 'CONFIRMED', string> = {
  CONTACT: '#b2703c',
  IDENTIFIED: '#cf7a4a',
  CONFIRMED: '#c17a5f',
};

export const DETECTION_BADGE: Record<'CONTACT' | 'IDENTIFIED' | 'CONFIRMED', string> = {
  CONTACT: '?',
  IDENTIFIED: '?',
  CONFIRMED: '✓',
};

/** Position-only blip: something is there, and that is all the player is told. */
function drawContactMarker(rc: RenderContext, c: Contact) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, c.x, c.y);
  const alpha = Math.max(0.3, Math.min(1, c.confidence / 70));
  const col = DETECTION_COLORS.CONTACT;
  const r = Math.max(5, s * 0.34);

  ctx.beginPath();
  ctx.arc(sx, sy, r + Math.max(1.4, r * 0.2), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(9,12,16,${0.5 * alpha})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(70,40,26,${alpha * 0.55})`;
  ctx.fill();
  ctx.setLineDash([3.5, 3]);
  ctx.lineWidth = Math.max(1.4, r * 0.2);
  ctx.strokeStyle = col;
  ctx.globalAlpha = alpha;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  if (s >= 9) {
    ctx.fillStyle = `rgba(255,228,208,${alpha})`;
    ctx.font = `bold ${Math.max(8, r * 0.95)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', sx, sy + 1);
  }
  if (s >= 15) {
    drawLabel(
      rc,
      sx,
      sy + r + Math.max(7, s * 0.32),
      `${gridRef(c.x, c.y)} · ${Math.round(c.confidence)}%`,
      Math.max(8, s * 0.22),
      `rgba(226,164,124,${alpha})`,
      0.04
    );
  }
  // A contact you no longer have eyes on gets a "stale" tick so the player can
  // see at a glance which markers are memory rather than observation.
  if (!c.live && s >= 12) {
    ctx.strokeStyle = `rgba(226,164,124,${alpha * 0.9})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sx - r * 1.5, sy - r * 1.5);
    ctx.lineTo(sx - r * 0.9, sy - r * 0.9);
    ctx.stroke();
  }
}

/** Expanding ring on a tile where something was just spotted. */
function drawPings(rc: RenderContext) {
  if (!rc.pings?.length) return;
  const { ctx, width, height, camera } = rc;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  for (const p of rc.pings) {
    const age = now - p.at;
    if (age < 0 || age > PING_LIFETIME_MS) continue;
    const { sx, sy } = worldToScreen(camera, width, height, p.x, p.y);
    const fade = 1 - age / PING_LIFETIME_MS;
    // Three rings chasing each other outward — reads as a sensor return.
    for (let k = 0; k < 3; k++) {
      const t = ((age / 1400 + k / 3) % 1);
      const rr = camera.scale * (0.5 + t * 1.9);
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(240,196,112,${(1 - t) * 0.75 * fade})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

/**
 * A brief, unmistakable wreck marker where a formation was just destroyed
 * (phase 7) — held for KILL_MARKER_LIFETIME_MS before fading, on both sides,
 * fog-redaction already applied upstream (a marker with no `type` is a
 * generic "something died here" the viewer only had CONTACT-level detection
 * on; one with `type` names the arm).
 */
function drawKillMarkers(rc: RenderContext) {
  if (!rc.kills?.length) return;
  const { ctx, width, height, camera } = rc;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const s = camera.scale;
  for (const k of rc.kills) {
    const age = now - k.at;
    if (age < 0 || age > KILL_MARKER_LIFETIME_MS) continue;
    const fade = 1 - age / KILL_MARKER_LIFETIME_MS;
    const { sx, sy } = worldToScreen(camera, width, height, k.x, k.y);
    const r = Math.max(7, s * 0.4);
    const pc = PLAYER_COLORS[k.owner];
    ctx.save();
    ctx.globalAlpha = Math.min(1, fade * 1.4);
    // Dark casing, then a scorched ring in the owner's colour, then a cross.
    ctx.beginPath();
    ctx.arc(sx, sy, r + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,12,16,0.72)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.strokeStyle = pc.main;
    ctx.lineWidth = Math.max(1.4, r * 0.18);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(230,182,101,0.95)';
    ctx.lineWidth = Math.max(1.6, r * 0.24);
    ctx.beginPath();
    ctx.moveTo(sx - r * 0.5, sy - r * 0.5);
    ctx.lineTo(sx + r * 0.5, sy + r * 0.5);
    ctx.moveTo(sx + r * 0.5, sy - r * 0.5);
    ctx.lineTo(sx - r * 0.5, sy + r * 0.5);
    ctx.stroke();
    if (s >= 9) {
      const label = k.type ? formationGlyph(k.type) : '???';
      drawLabel(rc, sx, sy + r + Math.max(7, s * 0.32), `${label} destroyed`, Math.max(8, s * 0.24), 'rgba(230,182,101,0.95)', 0.04);
    }
    ctx.restore();
  }
}

function drawFormation(rc: RenderContext, f: Formation) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
  const pc = PLAYER_COLORS[f.owner];
  const r = Math.max(6, s * 0.34);
  // Enemy counters carry their detection rung. Own formations have none.
  const intel = f.owner === rc.viewer ? null : f.intel ?? 'CONFIRMED';
  const identifiedOnly = intel === 'IDENTIFIED';
  const contact = rc.state.players[rc.viewer].contacts[f.id];

  // A dark halo under every counter. This is what guarantees a formation reads
  // over forest, urban fabric, a hillshade shadow or the movement wash — the
  // counter is always the highest-contrast thing in its own patch of sheet.
  ctx.beginPath();
  ctx.arc(sx, sy, r + Math.max(1.8, r * 0.26), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(9,12,16,0.68)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = pc.dark;
  ctx.fill();
  ctx.lineWidth = Math.max(1.8, r * 0.22);
  ctx.strokeStyle = identifiedOnly ? DETECTION_COLORS.IDENTIFIED : pc.main;
  // An identified-but-unconfirmed formation is ringed in DASHES: you know what
  // arm it is, you do not know which formation or what state it is in.
  if (identifiedOnly) ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arm silhouette — colour still says whose side (pc.light), the shape says
  // what it is. Cached per (type, size, colour); see icons.ts. IDENTIFIED
  // enemies reach this function with a real f.type — that IS what
  // "identified" means (fog.ts sends the arm at that rung) — while CONTACT
  // enemies never get a Formation object at all and are drawn by
  // drawContactMarker below with a generic '?', never an arm icon.
  {
    const iconSize = r * 1.5;
    const bmp = getIconBitmap(f.type, iconSize, pc.light);
    ctx.drawImage(bmp, sx - iconSize / 2, sy - iconSize / 2, iconSize, iconSize);
  }

  if (f.fortified) {
    ctx.strokeStyle = '#cf9a44';
    ctx.lineWidth = Math.max(1.5, r * 0.16);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.25, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }

  // On alert (phase 7): a pulsing red-amber ring — visible for your own
  // formations always, and for an enemy only once CONFIRMED (the same rung
  // fortified/suppression are withheld at).
  if (f.onAlert) {
    const pulse = 0.55 + 0.35 * Math.sin(((typeof performance !== 'undefined' ? performance.now() : Date.now()) / 420) % (Math.PI * 2));
    ctx.strokeStyle = `rgba(230,120,90,${pulse.toFixed(2)})`;
    ctx.lineWidth = Math.max(1.2, r * 0.14);
    ctx.setLineDash([r * 0.35, r * 0.3]);
    ctx.beginPath();
    ctx.arc(sx, sy, r * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (s >= 9) {
      const bx = sx - r * 0.85;
      const by = sy - r * 0.85;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(4, r * 0.4), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(9,12,16,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,120,90,0.95)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#f0b083';
      ctx.font = `bold ${Math.max(6, r * 0.6)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', bx, by + 0.5);
    }
  }

  if (s >= 6) {
    const bw = r * 1.9;
    const bx = sx - bw / 2;
    const by = sy - r - Math.max(4, s * 0.16);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, 3);
    if (identifiedOnly) {
      // Strength is NOT known at this rung — hatch the bar rather than draw a
      // number the server never sent.
      ctx.fillStyle = 'rgba(207,122,74,0.6)';
      for (let i = 0; i < bw; i += 4) ctx.fillRect(bx + i, by, 2, 3);
    } else {
      const pct = Math.max(0, Math.min(1, f.strength / 100));
      ctx.fillStyle = pct > 0.6 ? '#93a35f' : pct > 0.3 ? '#cf9a44' : '#c1524a';
      ctx.fillRect(bx, by, bw * pct, 3);
    }
    // Suppression (phase 7): a second, distinct thin bar under the strength
    // one — never folded into it. Only drawn once there is something to show,
    // and only when the value is known (own formations, or an enemy CONFIRMED).
    if (!identifiedOnly && f.suppression > 0) {
      const sby = by + 4;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx, sby, bw, 3);
      const spct = Math.max(0, Math.min(1, f.suppression / 100));
      ctx.fillStyle = '#8a6fae';
      ctx.fillRect(bx, sby, bw * spct, 3);
    }
  }

  // Detection badge: '?' identified, '✓' confirmed — symbol as well as colour.
  if (intel && s >= 11) {
    const bx = sx + r * 0.85;
    const by = sy - r * 0.85;
    ctx.beginPath();
    ctx.arc(bx, by, Math.max(4, r * 0.4), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,12,16,0.85)';
    ctx.fill();
    ctx.strokeStyle = DETECTION_COLORS[intel === 'IDENTIFIED' ? 'IDENTIFIED' : 'CONFIRMED'];
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = intel === 'IDENTIFIED' ? '#f0b083' : '#b8dca8';
    ctx.font = `bold ${Math.max(6, r * 0.52)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DETECTION_BADGE[intel === 'IDENTIFIED' ? 'IDENTIFIED' : 'CONFIRMED'], bx, by + 0.5);
  }

  if (s >= 16 && f.owner === rc.viewer) {
    drawLabel(rc, sx, sy + r + Math.max(7, s * 0.34), f.shortName, Math.max(8, s * 0.24), 'rgba(232,238,236,0.9)', 0.04);
  } else if (s >= 16 && intel && contact) {
    drawLabel(
      rc,
      sx,
      sy + r + Math.max(7, s * 0.34),
      `${f.shortName} · ${Math.round(contact.confidence)}%`,
      Math.max(8, s * 0.22),
      identifiedOnly ? 'rgba(240,176,131,0.95)' : 'rgba(232,200,190,0.95)',
      0.04
    );
  }
}

export { worldToScreen, visibleTileRange };
