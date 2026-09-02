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
  BLUEFOR: { main: '#4fc3f7', dark: '#0d3a52', glow: 'rgba(79,195,247,0.55)' },
  REDFOR: { main: '#ff6b5b', dark: '#4a1a12', glow: 'rgba(255,107,91,0.55)' },
};

export const UI = {
  panelBg: '#1b2019',
  panelBg2: '#20261e',
  panelBorder: '#3a4534',
  amber: '#e0b13a',
  green: '#8fd694',
  textDim: '#9aa591',
  textMain: '#e7ecdf',
  danger: '#e2604f',
};
