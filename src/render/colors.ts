import { TerrainType } from '../game/types';

export const TERRAIN_COLORS: Record<TerrainType, { base: string; light: string; dark: string }> = {
  OPEN: { base: '#c9b98a', light: '#d6c89b', dark: '#b3a274' },
  GRASS: { base: '#8fae5c', light: '#9fbd6d', dark: '#7c984c' },
  FOREST: { base: '#3f6b3f', light: '#4a7a4a', dark: '#2f512f' },
  HILLS: { base: '#a08055', light: '#b39366', dark: '#846a45' },
  URBAN: { base: '#8b8b8f', light: '#9c9ca0', dark: '#75757a' },
  INDUSTRIAL: { base: '#78766e', light: '#8a8880', dark: '#615f58' },
  WATER: { base: '#3572a0', light: '#4483b3', dark: '#265a83' },
  AIRFIELD: { base: '#9a9a86', light: '#aaaa96', dark: '#828270' },
  PORT: { base: '#8a8570', light: '#9a9580', dark: '#736e5c' },
};

export const PLAYER_COLORS: Record<'BLUEFOR' | 'REDFOR', { main: string; dark: string; glow: string }> = {
  BLUEFOR: { main: '#6fa8c9', dark: '#0f2e3d', glow: 'rgba(111,168,201,0.55)' },
  REDFOR: { main: '#c17a5f', dark: '#3d211a', glow: 'rgba(193,122,95,0.55)' },
};

// Ops-room UI chrome tokens — mirrors the CSS custom properties in
// styles.css (kept as plain hex here since the canvas cannot read CSS vars).
export const UI = {
  panelBg: '#1b2126',
  panelBg2: '#212830',
  panelBorder: '#37424c',
  amber: '#cf9a44',
  green: '#93a35f',
  textDim: '#8b9a92',
  textMain: '#dbe0da',
  danger: '#c1524a',
};
