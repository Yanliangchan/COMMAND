import { FormationDef, FormationType, TerrainDef, TerrainType } from './types';

// ============================================================================
// TERRAIN DEFINITIONS
// Movement costs, defense bonuses and sight-blocking are fictional, game-
// balance values chosen for a playable prototype — see README.md section
// "Real-World Reference vs Fictional Game Mechanics".
// ============================================================================

export const TERRAIN_DEFS: Record<TerrainType, TerrainDef> = {
  OPEN: { type: 'OPEN', label: 'Open Terrain', moveCost: 1, defenseBonus: -0.1, blocksSight: false, elevation: 0 },
  GRASS: { type: 'GRASS', label: 'Grassland', moveCost: 1, defenseBonus: 0, blocksSight: false, elevation: 0 },
  FOREST: { type: 'FOREST', label: 'Forest', moveCost: 2, defenseBonus: 0.25, blocksSight: true, elevation: 0 },
  HILLS: { type: 'HILLS', label: 'Hills', moveCost: 2, defenseBonus: 0.3, blocksSight: false, elevation: 2 },
  URBAN: { type: 'URBAN', label: 'Urban District', moveCost: 2, defenseBonus: 0.35, blocksSight: true, elevation: 0 },
  INDUSTRIAL: { type: 'INDUSTRIAL', label: 'Industrial Zone', moveCost: 2, defenseBonus: 0.2, blocksSight: true, elevation: 0 },
  WATER: { type: 'WATER', label: 'Water', moveCost: Infinity, defenseBonus: 0, blocksSight: false, elevation: -1 },
  AIRFIELD: { type: 'AIRFIELD', label: 'Airfield', moveCost: 1, defenseBonus: 0.1, blocksSight: false, elevation: 0 },
  PORT: { type: 'PORT', label: 'Port', moveCost: 1, defenseBonus: 0.1, blocksSight: false, elevation: 0 },
};

// ============================================================================
// FORMATION DEFINITIONS
// Attack/defense/move/sight values below are FICTIONAL game-balance numbers.
// The "flavor" strings reference publicly known SAF platform names for
// atmosphere only, per the design brief — they are not real SAF
// organisational or capability data. See README.md.
// ============================================================================

export const FORMATION_DEFS: Record<FormationType, FormationDef> = {
  INFANTRY: {
    type: 'INFANTRY',
    label: 'Infantry Formation',
    branch: 'Army',
    flavor: 'SAR 21 rifles, Terrex ICVs, SPIKE-LR ATGM teams, M110 designated marksman rifles.',
    baseAttack: 6,
    baseDefense: 7,
    moveRange: 3,
    sightRadius: 2,
    reconRadius: 3,
    canEmbark: true,
    isNaval: false,
    maxAmmo: 100,
  },
  COMMANDO: {
    type: 'COMMANDO',
    label: 'Commando Detachment',
    branch: 'Army',
    flavor: 'Elite special-operations troops: deep recon, direct-action raids, high mobility.',
    baseAttack: 7,
    baseDefense: 4,
    moveRange: 4,
    sightRadius: 3,
    reconRadius: 5,
    canEmbark: true,
    isNaval: false,
    maxAmmo: 100,
  },
  ARMOUR: {
    type: 'ARMOUR',
    label: 'Armour Formation',
    branch: 'Army',
    flavor: 'Leopard 2SG main battle tanks with Hunter AFV and Bionix support.',
    baseAttack: 10,
    baseDefense: 6,
    moveRange: 4,
    sightRadius: 2,
    reconRadius: 2,
    canEmbark: true,
    isNaval: false,
    maxAmmo: 100,
  },
  ARTILLERY: {
    type: 'ARTILLERY',
    label: 'Artillery Battery',
    branch: 'Army',
    flavor: 'SSPH Primus self-propelled howitzers / SLWH Pegasus towed lightweight howitzers.',
    baseAttack: 9,
    baseDefense: 3,
    moveRange: 2,
    sightRadius: 2,
    reconRadius: 2,
    canEmbark: true,
    isNaval: false,
    maxAmmo: 100,
  },
  ENGINEER: {
    type: 'ENGINEER',
    label: 'Combat Engineers',
    branch: 'Army',
    flavor: 'Bridging, fortification and obstacle-clearance specialists.',
    baseAttack: 3,
    baseDefense: 5,
    moveRange: 3,
    sightRadius: 2,
    reconRadius: 2,
    canEmbark: true,
    isNaval: false,
    maxAmmo: null,
  },
  RECON: {
    type: 'RECON',
    label: 'Recon Detachment',
    branch: 'Army',
    flavor: 'Light vehicle-mounted scouts, wide sight radius, weak in direct combat.',
    baseAttack: 3,
    baseDefense: 3,
    moveRange: 5,
    sightRadius: 4,
    reconRadius: 6,
    canEmbark: true,
    isNaval: false,
    maxAmmo: 100,
  },
  LOGISTICS: {
    type: 'LOGISTICS',
    label: 'Logistics Element',
    branch: 'Army',
    flavor: 'Transport & supply column projecting a supply range to frontline formations.',
    baseAttack: 1,
    baseDefense: 3,
    moveRange: 3,
    sightRadius: 1,
    reconRadius: 1,
    canEmbark: true,
    isNaval: false,
    maxAmmo: null,
  },
  NAVAL_TRANSPORT: {
    type: 'NAVAL_TRANSPORT',
    label: 'Naval Transport',
    branch: 'Navy',
    flavor: 'Endurance-class landing ship — ferries a formation between port/coastal tiles.',
    baseAttack: 1,
    baseDefense: 4,
    moveRange: 6,
    sightRadius: 2,
    reconRadius: 2,
    canEmbark: false,
    isNaval: true,
    maxAmmo: null,
  },
  FRIGATE: {
    type: 'FRIGATE',
    label: 'Frigate',
    branch: 'Navy',
    flavor: 'Formidable-class frigate — can bombard coastal tiles in support of land forces.',
    baseAttack: 8,
    baseDefense: 6,
    moveRange: 6,
    sightRadius: 3,
    reconRadius: 3,
    canEmbark: false,
    isNaval: true,
    maxAmmo: 100,
  },
};

export const MORALE_MULTIPLIER: Record<string, number> = {
  Elite: 1.25,
  Steady: 1.0,
  Stressed: 0.85,
  Shaken: 0.65,
  Broken: 0.4,
};
