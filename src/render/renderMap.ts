import { FORMATION_DEFS } from '../game/data';
import { distance, formationAt } from '../game/engine';
import { Formation, GameState, GRID_SIZE, Objective, PlayerId, Tile } from '../game/types';
import { PLAYER_COLORS, TERRAIN_COLORS, UI } from './colors';

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

function objectiveGlyph(kind: Objective['kind']) {
  switch (kind) {
    case 'Bridge':
      return '⌢';
    case 'Port':
      return '⚓';
    case 'Airfield':
      return '✈';
    case 'Urban District':
      return '🏙';
    case 'Hill':
      return '▲';
    case 'Supply Depot':
      return '⛽';
    default:
      return '★';
  }
}

function formationGlyph(type: Formation['type']) {
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
    case 'LOGISTICS':
      return 'LG';
    case 'NAVAL_TRANSPORT':
      return 'NT';
    case 'FRIGATE':
      return 'FG';
    default:
      return '??';
  }
}

export function render(rc: RenderContext) {
  const { ctx, width, height, camera, state } = rc;
  ctx.save();
  ctx.fillStyle = '#12161a';
  ctx.fillRect(0, 0, width, height);

  const { x0, x1, y0, y1 } = visibleTileRange(camera, width, height);
  const s = camera.scale;
  const detail = s >= 9; // show texture/icon detail only when zoomed enough

  // ---- Terrain pass ----
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      drawTile(rc, tile, detail);
    }
  }

  // ---- Road overlay pass (drawn after terrain so roads sit on top, connecting neighbors) ----
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tile = state.tiles[y][x];
      if (tile.road) drawRoad(rc, tile);
    }
  }

  // ---- Supply overlay ----
  if (rc.overlays.supply) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x},${y}`;
        const { sx, sy } = worldToScreen(camera, width, height, x, y);
        const supplied = rc.supplySet.has(key);
        ctx.fillStyle = supplied ? 'rgba(120,200,140,0.14)' : 'rgba(200,60,60,0.14)';
        ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      }
    }
  }

  // ---- Movement range overlay ----
  if (rc.overlays.movement && rc.selected) {
    rc.reachable.forEach((cost, key) => {
      const [x, y] = key.split(',').map(Number);
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      ctx.fillStyle = 'rgba(207,154,68,0.28)';
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      ctx.strokeStyle = 'rgba(207,154,68,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - s / 2 + 0.5, sy - s / 2 + 0.5, s - 1, s - 1);
    });
  }

  // ---- Objectives ----
  if (rc.overlays.objectives) {
    for (const o of state.objectives) {
      if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) continue;
      const { sx, sy } = worldToScreen(camera, width, height, o.x, o.y);
      const color = o.controlledBy ? PLAYER_COLORS[o.controlledBy].main : UI.amber;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(5, s * 0.32), 0, Math.PI * 2);
      ctx.fillStyle = o.controlledBy ? PLAYER_COLORS[o.controlledBy].glow : 'rgba(207,154,68,0.35)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (s >= 7) {
        ctx.fillStyle = color;
        ctx.font = `${Math.max(9, s * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(objectiveGlyph(o.kind), sx, sy);
      }
    }
  }

  // ---- Attackable highlight ----
  if (rc.attackable.size) {
    Object.values(state.formations).forEach((f) => {
      if (!rc.attackable.has(f.id)) return;
      const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
      ctx.strokeStyle = UI.danger;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  // ---- Contacts (suspected enemy) ----
  if (rc.overlays.intel) {
    const contacts = state.players[rc.viewer].contacts;
    Object.values(contacts).forEach((c) => {
      // Skip if a formation is currently rendered live at this position with full confidence.
      if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) return;
      const { sx, sy } = worldToScreen(camera, width, height, c.x, c.y);
      const alpha = Math.max(0.25, c.confidence / 100);
      ctx.fillStyle = `rgba(193,82,74,${alpha * 0.5})`;
      ctx.beginPath();
      ctx.arc(sx, sy, s * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(193,82,74,${alpha})`;
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      if (s >= 10) {
        ctx.fillStyle = `rgba(255,220,210,${alpha})`;
        ctx.font = `${Math.max(8, s * 0.28)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('?', sx, sy + 1);
      }
    });
  }

  // ---- Formations ----
  Object.values(state.formations).forEach((f) => {
    if (f.embarkedOn) return;
    if (!isFormationVisible(rc, f)) return;
    if (f.owner !== rc.viewer && rc.overlays.intel) {
      // Enemy but currently visible live — still draw solid (confidence should be 100 since seen this turn)
    }
    drawFormation(rc, f);
  });

  // ---- Selection ring ----
  if (rc.selected && state.formations[rc.selected.id]) {
    const f = state.formations[rc.selected.id];
    const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
    ctx.strokeStyle = UI.green;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, s * 0.62, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---- Hover highlight ----
  if (rc.hoverTile) {
    const { x, y } = rc.hoverTile;
    if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE) {
      const { sx, sy } = worldToScreen(camera, width, height, x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - s / 2 + 0.5, sy - s / 2 + 0.5, s - 1, s - 1);
    }
  }

  ctx.restore();
}

function drawTile(rc: RenderContext, tile: Tile, detail: boolean) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  const colors = TERRAIN_COLORS[tile.terrain];
  const half = s / 2;

  // Base fill with subtle per-tile noise variance for a hand-painted look.
  const variance = (tile.noiseSeed - 0.5) * 26;
  ctx.fillStyle = shade(colors.base, variance);
  ctx.fillRect(sx - half, sy - half, s + 1, s + 1);

  // Elevation shading for hills: darker toward "downhill" edge + a soft highlight, like contour shading.
  if (tile.terrain === 'HILLS') {
    const grad = ctx.createLinearGradient(sx - half, sy - half, sx + half, sy + half);
    grad.addColorStop(0, shade(colors.light, 10 + tile.elevation * 6));
    grad.addColorStop(1, shade(colors.dark, -6 - tile.elevation * 6));
    ctx.fillStyle = grad;
    ctx.fillRect(sx - half, sy - half, s + 1, s + 1);
    if (detail) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      for (let i = 0; i < tile.elevation; i++) {
        ctx.beginPath();
        ctx.moveTo(sx - half + 2, sy + half - 3 - i * 4);
        ctx.lineTo(sx + half - 2, sy + half - 3 - i * 4);
        ctx.stroke();
      }
    }
  }

  // Water: animated-ish subtle horizontal bands via noise, plus river/bridge treatment.
  if (tile.terrain === 'WATER') {
    ctx.fillStyle = shade(colors.dark, tile.noiseSeed * 14 - 7);
    ctx.fillRect(sx - half, sy - half, s + 1, s + 1);
    if (detail) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(sx - half, sy - half * 0.3 + tile.noiseSeed * s * 0.4);
      ctx.lineTo(sx + half, sy - half * 0.1 + tile.noiseSeed * s * 0.4);
      ctx.stroke();
    }
    if (tile.bridge) {
      ctx.fillStyle = '#8a6b45';
      ctx.fillRect(sx - half, sy - half * 0.45, s + 1, s * 0.9);
      ctx.strokeStyle = '#5c4527';
      ctx.lineWidth = Math.max(1, s * 0.04);
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(sx + (i * s) / 5, sy - half * 0.45);
        ctx.lineTo(sx + (i * s) / 5, sy + half * 0.45);
        ctx.stroke();
      }
    }
  }

  // Tile-edge dithering: blend a faint speckle border toward differing neighbor terrain.
  if (detail) {
    ctx.globalAlpha = 0.05 + tile.noiseSeed * 0.05;
    ctx.fillStyle = '#000000';
    const speck = s * 0.12;
    ctx.fillRect(sx - half + tile.noiseSeed * s, sy - half + ((tile.noiseSeed * 7) % 1) * s, speck, speck);
    ctx.globalAlpha = 1;
  }

  // Forest: tree cluster icons.
  if (tile.terrain === 'FOREST' && detail) {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const jitter = ((tile.noiseSeed * (i + 1) * 13) % 1) - 0.5;
      const jitter2 = ((tile.noiseSeed * (i + 3) * 7) % 1) - 0.5;
      const tx = sx + jitter * s * 0.6;
      const ty = sy + jitter2 * s * 0.6;
      const r = s * 0.16;
      ctx.beginPath();
      ctx.arc(tx, ty - r * 0.3, r, 0, Math.PI * 2);
      ctx.fillStyle = shade(colors.dark, -10 + i * 6);
      ctx.fill();
      ctx.fillStyle = '#2a1c10';
      ctx.fillRect(tx - r * 0.12, ty, r * 0.24, r * 0.5);
    }
  }

  // Urban / industrial: building-block sprites.
  if ((tile.terrain === 'URBAN' || tile.terrain === 'INDUSTRIAL') && detail) {
    const cols = 2;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < cols; j++) {
        const seed = (tile.noiseSeed * (i + 1) * (j + 2) * 17) % 1;
        if (seed < 0.25) continue;
        const bw = s * 0.32;
        const bh = s * (0.28 + seed * 0.22);
        const bx = sx - half + s * 0.12 + i * s * 0.48;
        const by = sy + half - bh - s * 0.08 - j * 0 * s;
        ctx.fillStyle = tile.terrain === 'URBAN' ? shade('#6f6f74', seed * 30 - 15) : shade('#54524a', seed * 24 - 12);
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = 'rgba(255,220,140,0.5)';
        if (s > 12) ctx.fillRect(bx + bw * 0.3, by + bh * 0.25, bw * 0.15, bh * 0.15);
      }
    }
  }

  // Airfield: runway stripe.
  if (tile.terrain === 'AIRFIELD' && detail) {
    ctx.fillStyle = '#4d4d47';
    ctx.fillRect(sx - half, sy - s * 0.08, s + 1, s * 0.16);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.setLineDash([s * 0.08, s * 0.08]);
    ctx.beginPath();
    ctx.moveTo(sx - half, sy);
    ctx.lineTo(sx + half, sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Port: small crane/quay marker.
  if (tile.terrain === 'PORT' && detail) {
    ctx.strokeStyle = '#3a3a36';
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath();
    ctx.moveTo(sx, sy + half * 0.5);
    ctx.lineTo(sx, sy - half * 0.5);
    ctx.lineTo(sx + half * 0.4, sy - half * 0.3);
    ctx.stroke();
  }

  // Depot marker.
  if (tile.isDepot) {
    ctx.fillStyle = tile.depotOwner ? PLAYER_COLORS[tile.depotOwner].main : UI.amber;
    ctx.beginPath();
    ctx.moveTo(sx, sy - half * 0.5);
    ctx.lineTo(sx + half * 0.5, sy);
    ctx.lineTo(sx, sy + half * 0.5);
    ctx.lineTo(sx - half * 0.5, sy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawRoad(rc: RenderContext, tile: Tile) {
  const { ctx, width, height, camera, state } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, tile.x, tile.y);
  ctx.strokeStyle = '#3a3a38';
  ctx.lineWidth = Math.max(1.5, s * 0.14);
  ctx.lineCap = 'round';
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let any = false;
  for (const [dx, dy] of dirs) {
    const nx = tile.x + dx;
    const ny = tile.y + dy;
    const nt = state.tiles[ny]?.[nx];
    if (nt && nt.road) {
      any = true;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (dx * s) / 2, sy + (dy * s) / 2);
      ctx.stroke();
    }
  }
  if (!any) {
    ctx.beginPath();
    ctx.arc(sx, sy, s * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = '#3a3a38';
    ctx.fill();
  }
}

function drawFormation(rc: RenderContext, f: Formation) {
  const { ctx, width, height, camera } = rc;
  const s = camera.scale;
  const { sx, sy } = worldToScreen(camera, width, height, f.x, f.y);
  const pc = PLAYER_COLORS[f.owner];
  const r = Math.max(6, s * 0.34);

  // Shadow
  ctx.beginPath();
  ctx.ellipse(sx, sy + r * 0.7, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();

  // Body
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

  // Fortified marker
  if (f.fortified) {
    ctx.strokeStyle = '#cf9a44';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx - r, sy + r * 0.15);
    ctx.lineTo(sx + r, sy + r * 0.15);
    ctx.stroke();
  }

  // Strength bar
  if (s >= 6) {
    const bw = r * 1.9;
    const bx = sx - bw / 2;
    const by = sy - r - Math.max(4, s * 0.16);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(bx, by, bw, 3);
    const pct = Math.max(0, Math.min(1, f.strength / 100));
    ctx.fillStyle = pct > 0.6 ? '#93a35f' : pct > 0.3 ? '#cf9a44' : '#c1524a';
    ctx.fillRect(bx, by, bw * pct, 3);
  }
}

export { worldToScreen, visibleTileRange };
