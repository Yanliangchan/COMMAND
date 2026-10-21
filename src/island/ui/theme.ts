// ============================================================================
// Shared presentation rules for the board and the HUD — the bits of the visual
// language that live in TypeScript rather than CSS.
// ============================================================================

import type { FactionId } from '../types';

/** Numeral colour on a faction's bright fill: white where it reads, dark ink where it doesn't (Tiger's orange). */
export const FACTION_INK: Record<FactionId, string> = {
  SINGA: '#ffffff',
  HARIMAU: '#2e1a00',
  HELANG: '#ffffff',
  JERUNG: '#ffffff',
};

/** Fog badge: unknown or estimated strength. */
export const FOG = { rim: '#3f4852', fill: '#5f6b77' };

/**
 * Where a region's badge sits, when the region's site would crowd a neighbour's
 * badge or label. Purely cosmetic; the rules use the site.
 */
export const BADGE_NUDGE: Record<string, [number, number]> = {
  'paya-lebar': [-10, 3],
  'marine-parade': [12, 10],
  tampines: [-6, -8],
  kallang: [2, -4],
  'tanjong-pagar': [-6, 4],
  'bukit-merah': [-2, -4],
  'lim-chu-kang': [-8, 0],
  sengkang: [0, -6],
};

/** Region labels that read better beside or above the badge than below it. */
export const LABEL_SIDE: Record<string, 'above' | 'left'> = { 'paya-lebar': 'left', 'bukit-merah': 'above', 'lim-chu-kang': 'above', 'jurong-east': 'above' };

/** Landmark offsets from the badge (default: up and to the right); null = too crowded to draw. */
export const LANDMARK_AT: Record<string, [number, number] | null> = {
  woodlands: [-40, -12],
  'marina-bay': [-42, -10],
  tekong: [36, -16],
  sembawang: [36, -12],
  'jurong-island': [38, -14],
  'tanjong-pagar': null,
  'paya-lebar': null,
  kallang: null,
};

export const RED = '#ff5a4e';
export const GOLD = '#ffc83d';

/**
 * Sea lanes between neighbouring sea zones, as waypoints in open water (each
 * checked to stay ≥ 15 units off every coast). Ship moves and sail arrows
 * follow these, so a ship never cuts across the land at any zoom.
 */
export const SEA_LANES: Record<string, [number, number][]> = {
  'NORTH-WEST': [[590, 82], [505, 56], [410, 52], [310, 84], [215, 128], [150, 180], [105, 225]],
  'WEST-SOUTH': [[105, 225], [55, 265], [38, 330], [62, 402], [140, 448], [168, 515], [300, 530], [440, 540], [600, 530], [690, 470]],
  'SOUTH-EAST': [[690, 470], [800, 448], [905, 400]],
  'NORTH-EAST': [[590, 82], [690, 90], [788, 82], [840, 118], [842, 178], [885, 206], [945, 220], [970, 275], [950, 345], [905, 400]],
};

/** Hill tops for the faint contour rings drawn over the land. */
export const HILLS: { at: [number, number]; r: number; rings: number }[] = [
  { at: [392, 296], r: 15, rings: 4 },
  { at: [470, 238], r: 12, rings: 3 },
  { at: [300, 218], r: 11, rings: 3 },
  { at: [220, 330], r: 10, rings: 2 },
  { at: [610, 230], r: 9, rings: 2 },
];
