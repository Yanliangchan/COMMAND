// ============================================================================
// COMMAND — Unit arm silhouettes.
//
// Hand-drawn vector icons for each FormationType, drawn with plain canvas
// primitives into a small unit square (-1..1) centred on the origin. Nothing
// here loads an image asset — every shape is built from paths at draw time,
// matching how the rest of the sheet (contours, hillshade, coastlines) is
// already vector work. Faction colour is passed in by the caller and used as
// the fill/stroke — the icon says "what", the colour says "whose".
//
// Icons are cached to small offscreen canvases keyed by (type, size, color)
// the same way the terrain relief raster is cached, so a busy 22-formation
// battle does not re-walk these paths every frame — see `getIconBitmap`.
// ============================================================================

import { FormationType } from '../game/types';

type IconFn = (ctx: CanvasRenderingContext2D, bold: boolean) => void;

/** Draws are authored in a -1..1 square; caller pre-scales/translates. */
const ICONS: Record<FormationType, IconFn> = {
  // Soldier figure: head + shouldered torso, legs apart. At tiny sizes the
  // head+torso blob alone still reads as "a person", which is the point.
  INFANTRY: (ctx, bold) => {
    ctx.beginPath();
    ctx.arc(0, -0.62, 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-0.4, -0.28);
    ctx.lineTo(0.4, -0.28);
    ctx.lineTo(0.3, 0.42);
    ctx.lineTo(0.12, 0.42);
    ctx.lineTo(0.12, 0.95);
    ctx.lineTo(-0.12, 0.95);
    ctx.lineTo(-0.12, 0.42);
    ctx.lineTo(-0.3, 0.42);
    ctx.closePath();
    ctx.fill();
    if (!bold) {
      // shouldered rifle stroke, dropped at the smallest sizes
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.moveTo(-0.62, 0.05);
      ctx.lineTo(0.62, -0.55);
      ctx.stroke();
    }
  },
  // Winged chevron — reads as "airborne / elite infantry", distinct from the
  // line-infantry figure and from the Guards shield below.
  COMMANDO: (ctx, bold) => {
    ctx.beginPath();
    ctx.moveTo(0, -0.12);
    ctx.lineTo(-0.95, -0.62);
    ctx.lineTo(-0.95, -0.16);
    ctx.lineTo(-0.28, 0.14);
    ctx.lineTo(0, 0.62);
    ctx.lineTo(0.28, 0.14);
    ctx.lineTo(0.95, -0.16);
    ctx.lineTo(0.95, -0.62);
    ctx.closePath();
    ctx.fill();
    if (!bold) {
      ctx.beginPath();
      ctx.arc(0, -0.02, 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  // Shield outline — elite formed infantry, distinct silhouette from wings.
  GUARDS: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -0.95);
    ctx.lineTo(0.72, -0.62);
    ctx.lineTo(0.72, 0.18);
    ctx.quadraticCurveTo(0.72, 0.7, 0, 0.98);
    ctx.quadraticCurveTo(-0.72, 0.7, -0.72, 0.18);
    ctx.lineTo(-0.72, -0.62);
    ctx.closePath();
    ctx.fill();
  },
  // Tank: hull + turret + barrel — the canonical "armour" read.
  ARMOUR: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(-0.9, 0.2);
    ctx.lineTo(-0.72, -0.08);
    ctx.lineTo(0.72, -0.08);
    ctx.lineTo(0.9, 0.2);
    ctx.lineTo(0.9, 0.6);
    ctx.lineTo(-0.9, 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-0.05, -0.28, 0.42, 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.3, -0.34);
    ctx.lineTo(0.92, -0.42);
    ctx.lineTo(0.92, -0.24);
    ctx.lineTo(0.34, -0.2);
    ctx.closePath();
    ctx.fill();
    // road-wheel line
    ctx.fillRect(-0.86, 0.62, 1.72, 0.14);
  },
  // Howitzer: angled barrel over a low wheeled carriage.
  ARTILLERY: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(-0.7, 0.55);
    ctx.lineTo(0.55, 0.55);
    ctx.lineTo(0.4, 0.12);
    ctx.lineTo(-0.55, 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-0.42, 0.62, 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0.28, 0.62, 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(-0.15, 0.05);
    ctx.rotate(-0.62);
    ctx.fillRect(-0.09, -0.95, 0.18, 1.05);
    ctx.restore();
  },
  // Crossed tools — pick + wrench, the standard engineer glyph.
  ENGINEER: (ctx) => {
    ctx.lineWidth = 0.26;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-0.72, -0.72);
    ctx.lineTo(0.72, 0.72);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.72, 0.72);
    ctx.lineTo(0.72, -0.72);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-0.72, -0.72, 0.2, 0, Math.PI * 2);
    ctx.arc(0.72, 0.72, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.5, -0.94);
    ctx.lineTo(0.94, -0.5);
    ctx.lineTo(0.72, -0.28);
    ctx.lineTo(0.28, -0.72);
    ctx.closePath();
    ctx.fill();
  },
  // Antenna / dish — recon-ISR sensor read.
  RECON: (ctx, bold) => {
    ctx.lineWidth = 0.18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0.95);
    ctx.lineTo(0, -0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -0.15, 0.16, 0, Math.PI * 2);
    ctx.fill();
    if (!bold) {
      // two signal arcs, smallest sizes drop these and keep mast+dot legible
      ctx.beginPath();
      ctx.arc(0, -0.1, 0.5, Math.PI * 1.18, Math.PI * 1.82);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -0.1, 0.82, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, -0.1, 0.66, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
  },
  // Frigate: longer hull, raked bow, a deck superstructure block and a mast —
  // the heavier of the two hulls.
  FRIGATE: (ctx, bold) => {
    ctx.beginPath();
    ctx.moveTo(-0.95, 0.5);
    ctx.lineTo(0.65, 0.5);
    ctx.lineTo(0.95, 0.14);
    ctx.lineTo(0.55, -0.02);
    ctx.lineTo(-0.95, -0.02);
    ctx.closePath();
    ctx.fill();
    if (!bold) {
      ctx.fillRect(-0.3, -0.42, 0.55, 0.42);
      ctx.beginPath();
      ctx.moveTo(0.02, -0.42);
      ctx.lineTo(0.02, -0.92);
      ctx.lineTo(0.12, -0.42);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(-0.2, -0.36, 0.4, 0.36);
    }
  },
  // Corvette: shorter, lower hull, no mast, a single small deckhouse — reads
  // deliberately lighter than the frigate at the same on-screen size.
  CORVETTE: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(-0.72, 0.5);
    ctx.lineTo(0.5, 0.5);
    ctx.lineTo(0.8, 0.2);
    ctx.lineTo(0.4, 0.04);
    ctx.lineTo(-0.72, 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(-0.14, -0.22, 0.34, 0.26);
  },
};

/** Every arm reduces to a bolder, simplified silhouette below this on-screen size (px). */
const BOLD_THRESHOLD_PX = 15;

/**
 * DAMAGE-STATE OVERLAY (phase 10 §6). Below this fraction of max strength a
 * formation's icon carries a small "hurt" cue on top of its ordinary
 * silhouette. Deliberately restrained — a scorch smudge plus one short crack
 * line, not a redraw of the whole shape — so it still reads at the smallest
 * counter sizes instead of turning into mud. Drawn in the SAME -1..1 unit
 * square as the arm icon, after it, so it always sits correctly regardless
 * of which silhouette it is layered on.
 */
export const DAMAGE_STRENGTH_THRESHOLD = 40;

function drawDamageOverlay(ctx: CanvasRenderingContext2D, sizePx: number) {
  // Scorch mark — a soft dark smudge low on the silhouette. Reads at any size.
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#120c09';
  ctx.beginPath();
  ctx.arc(0.32, 0.4, 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Crack — a single jagged line, dropped below a legible size the same way
  // the base icons drop their finer strokes (see BOLD_THRESHOLD_PX above).
  if (sizePx >= 13) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = '#0d0908';
    ctx.lineWidth = 0.11;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-0.48, -0.62);
    ctx.lineTo(-0.12, -0.08);
    ctx.lineTo(-0.34, 0.1);
    ctx.lineTo(0.05, 0.78);
    ctx.stroke();
    ctx.restore();
  }

  // Smoke wisp — two small fading dots drifting up-right, only at sizes
  // where they will not just be visual noise.
  if (sizePx >= 17) {
    ctx.save();
    ctx.fillStyle = 'rgba(140,140,138,0.5)';
    ctx.beginPath();
    ctx.arc(0.5, -0.55, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(140,140,138,0.32)';
    ctx.beginPath();
    ctx.arc(0.68, -0.82, 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Cached offscreen bitmaps: `${type}|${sizePx}|${color}|${damaged}` -> canvas. */
const cache = new Map<string, HTMLCanvasElement>();
/** Bake extra resolution into every cached bitmap so it survives DPR<=2 upscale crisply. */
const OVERSAMPLE = 3;

function drawArmIcon(ctx: CanvasRenderingContext2D, type: FormationType, sizePx: number, color: string, damaged: boolean) {
  const bold = sizePx < BOLD_THRESHOLD_PX;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ICONS[type](ctx, bold);
  ctx.restore();
  if (damaged) drawDamageOverlay(ctx, sizePx);
}

/**
 * Returns a cached, pre-rendered bitmap of `type`'s silhouette sized to fit a
 * `sizePx`-diameter counter, filled with `color`. Building fresh Path2D work
 * every frame for a full 22-formation battle is unnecessary work the terrain
 * raster already avoids by caching — this follows the same pattern.
 *
 * `damaged` (phase 10 §6) bakes the low-strength overlay into its own cached
 * variant — callers decide whether to ask for it, and MUST only do so when
 * the viewer has actually earned the real strength value (their own
 * formation, or an enemy at CONFIRMED); see renderMap.ts `drawFormation`.
 */
export function getIconBitmap(type: FormationType, sizePx: number, color: string, damaged = false): HTMLCanvasElement {
  const roundedSize = Math.max(4, Math.round(sizePx));
  const key = `${type}|${roundedSize}|${color}|${damaged ? 1 : 0}`;
  let bmp = cache.get(key);
  if (bmp) return bmp;

  const px = roundedSize * OVERSAMPLE;
  bmp = document.createElement('canvas');
  bmp.width = px;
  bmp.height = px;
  const ictx = bmp.getContext('2d')!;
  ictx.translate(px / 2, px / 2);
  const scale = (px / 2) * 0.92; // small margin so strokes never clip the bitmap edge
  ictx.scale(scale, scale);
  drawArmIcon(ictx, type, roundedSize, color, damaged);
  cache.set(key, bmp);
  return bmp;
}

/**
 * Draws the icon straight onto a live 2D context at (cx, cy) with the given
 * on-screen diameter — used by the legend, which renders a handful of icons
 * once per open rather than every animation frame, so caching buys nothing.
 */
export function paintArmIcon(ctx: CanvasRenderingContext2D, type: FormationType, cx: number, cy: number, sizePx: number, color: string) {
  ctx.save();
  ctx.translate(cx, cy);
  const scale = (sizePx / 2) * 0.92;
  ctx.scale(scale, scale);
  drawArmIcon(ctx, type, sizePx, color, false);
  ctx.restore();
}
