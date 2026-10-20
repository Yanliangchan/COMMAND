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
  'bukit-merah': [4, -2],
  'lim-chu-kang': [-8, 0],
  sengkang: [0, -6],
};

/** Region labels that read better beside or above the badge than below it. */
export const LABEL_SIDE: Record<string, 'above' | 'left'> = { 'paya-lebar': 'left', 'bukit-merah': 'above', 'lim-chu-kang': 'above', 'jurong-east': 'above' };

/** Landmark offsets from the badge (default: up and to the right); null = too crowded to draw. */
export const LANDMARK_AT: Record<string, [number, number] | null> = {
  woodlands: [-36, -12],
  'marina-bay': [-42, -10],
  tekong: [36, -16],
  sembawang: [36, -12],
  'jurong-island': [38, -14],
  'tanjong-pagar': [36, -4],
  'paya-lebar': null,
  kallang: null,
};

export const RED = '#ff5a4e';
export const GOLD = '#ffc83d';
