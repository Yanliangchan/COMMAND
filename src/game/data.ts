import { FormationDef, FormationType, MOBILITY, PlayerId, TerrainDef, TerrainType } from './types';

// ============================================================================
// TERRAIN DEFINITIONS
// Movement costs, defense bonuses and sight-blocking are fictional, game-
// balance values chosen for a playable prototype — see README.md section
// "Real-World Reference vs Fictional Game Mechanics".
// ============================================================================

export const TERRAIN_DEFS: Record<TerrainType, TerrainDef> = {
  OPEN: { type: 'OPEN', label: 'Open Terrain', moveCost: 1, defenseBonus: -0.1, blocksSight: false },
  GRASS: { type: 'GRASS', label: 'Grassland', moveCost: 1, defenseBonus: 0, blocksSight: false },
  FOREST: { type: 'FOREST', label: 'Forest', moveCost: 2, defenseBonus: 0.25, blocksSight: true },
  HILLS: { type: 'HILLS', label: 'High Ground', moveCost: 2, defenseBonus: 0.3, blocksSight: false },
  URBAN: { type: 'URBAN', label: 'Urban District', moveCost: 2, defenseBonus: 0.35, blocksSight: true },
  INDUSTRIAL: { type: 'INDUSTRIAL', label: 'Industrial Zone', moveCost: 2, defenseBonus: 0.2, blocksSight: true },
  WATER: { type: 'WATER', label: 'Water', moveCost: Infinity, defenseBonus: 0, blocksSight: false },
  BEACH: { type: 'BEACH', label: 'Beach / Foreshore', moveCost: 1.5, defenseBonus: -0.15, blocksSight: false },
  AIRFIELD: { type: 'AIRFIELD', label: 'Airfield', moveCost: 1, defenseBonus: 0.1, blocksSight: false },
  PORT: { type: 'PORT', label: 'Port', moveCost: 1, defenseBonus: 0.1, blocksSight: false },
};

// ============================================================================
// FORMATION DEFINITIONS
// Attack/defense/move/sight/allowance values below are FICTIONAL game-balance
// numbers. See README.md.
// ============================================================================

export const FORMATION_DEFS: Record<FormationType, FormationDef> = {
  INFANTRY: {
    type: 'INFANTRY',
    label: 'Infantry Battalion',
    branch: 'Army',
    baseAttack: 6,
    baseDefense: 7,
    moveRange: MOBILITY.INFANTRY.moveRange,
    attackRange: 1,
    sightRadius: 3,
    reconRadius: 4,
    isNaval: false,
    maxAmmo: 100,
    movesPerRound: MOBILITY.INFANTRY.movesPerRound,
  },
  COMMANDO: {
    type: 'COMMANDO',
    label: 'Commando Battalion',
    branch: 'Army',
    baseAttack: 7,
    baseDefense: 4,
    moveRange: MOBILITY.COMMANDO.moveRange,
    attackRange: 1,
    sightRadius: 4,
    reconRadius: 6,
    isNaval: false,
    maxAmmo: 100,
    movesPerRound: MOBILITY.COMMANDO.movesPerRound,
  },
  ARMOUR: {
    type: 'ARMOUR',
    label: 'Armoured Battalion',
    branch: 'Army',
    baseAttack: 10,
    baseDefense: 6,
    moveRange: MOBILITY.ARMOUR.moveRange,
    attackRange: 1,
    sightRadius: 3,
    reconRadius: 3,
    isNaval: false,
    maxAmmo: 100,
    movesPerRound: MOBILITY.ARMOUR.movesPerRound,
  },
  ARTILLERY: {
    type: 'ARTILLERY',
    label: 'Artillery Battalion',
    branch: 'Army',
    baseAttack: 9,
    baseDefense: 3,
    moveRange: MOBILITY.ARTILLERY.moveRange,
    // Phase 3: 8 -> 7 with the 80x80 -> 72x72 board, so the gun's reach stays
    // the same *fraction* of the battlefield it was tuned against.
    attackRange: 7,
    sightRadius: 2,
    reconRadius: 2,
    isNaval: false,
    maxAmmo: 100,
    movesPerRound: MOBILITY.ARTILLERY.movesPerRound,
  },
  ENGINEER: {
    type: 'ENGINEER',
    label: 'Combat Engineer Battalion',
    branch: 'Army',
    baseAttack: 3,
    baseDefense: 5,
    moveRange: MOBILITY.ENGINEER.moveRange,
    attackRange: 1,
    sightRadius: 2,
    reconRadius: 2,
    isNaval: false,
    maxAmmo: null,
    movesPerRound: MOBILITY.ENGINEER.movesPerRound,
  },
  RECON: {
    type: 'RECON',
    label: 'C4I / ISR Battalion',
    branch: 'Army',
    baseAttack: 3,
    baseDefense: 3,
    moveRange: MOBILITY.RECON.moveRange,
    attackRange: 1,
    sightRadius: 5,
    reconRadius: 8,
    isNaval: false,
    maxAmmo: 100,
    movesPerRound: MOBILITY.RECON.movesPerRound,
  },
  FRIGATE: {
    type: 'FRIGATE',
    label: 'Frigate Squadron',
    branch: 'Navy',
    baseAttack: 9,
    baseDefense: 7,
    moveRange: MOBILITY.FRIGATE.moveRange,
    attackRange: 4, // naval surface fire against coastal targets
    sightRadius: 5,
    reconRadius: 6,
    isNaval: true,
    maxAmmo: 100,
    movesPerRound: MOBILITY.FRIGATE.movesPerRound,
  },
  CORVETTE: {
    type: 'CORVETTE',
    label: 'Littoral Combat Squadron',
    branch: 'Navy',
    baseAttack: 6,
    baseDefense: 5,
    moveRange: MOBILITY.CORVETTE.moveRange,
    attackRange: 3,
    sightRadius: 4,
    reconRadius: 5,
    isNaval: true,
    maxAmmo: 100,
    movesPerRound: MOBILITY.CORVETTE.movesPerRound,
  },
};

export const MORALE_MULTIPLIER: Record<string, number> = {
  Elite: 1.25,
  Steady: 1.0,
  Stressed: 0.85,
  Shaken: 0.65,
  Broken: 0.4,
};

// ============================================================================
// ORDERS OF BATTLE
//
// BLUEFOR uses real SAF *naming conventions* (verified against publicly
// available sources — see README). The specific battalion numbers assigned to
// each in-game formation are a FICTIONAL gameplay assignment; nothing here
// asserts any real SAF order of battle, role, strength or capability.
// Equipment strings name only publicly known platforms, as flavour.
//
// REDFOR is an entirely fictional opposing force ("Northern Union Forces")
// with its own coherent, deliberately non-SAF naming scheme.
// ============================================================================

export interface FormationProfile {
  type: FormationType;
  /** Full title, e.g. "1st Battalion, Singapore Infantry Regiment". */
  name: string;
  /** Short designation, e.g. "1 SIR". */
  shortName: string;
  echelon: string;
  arm: string;
  equipment: string;
}

export const FACTION_NAMES: Record<PlayerId, string> = {
  BLUEFOR: 'Singapore Armed Forces (BLUEFOR)',
  REDFOR: 'Northern Union Forces (REDFOR)',
};

const BLUEFOR_OOB: FormationProfile[] = [
  {
    type: 'INFANTRY',
    name: '1st Battalion, Singapore Infantry Regiment',
    shortName: '1 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Terrex ICVs, SPIKE-LR ATGM detachments.',
  },
  {
    type: 'INFANTRY',
    name: '2nd Battalion, Singapore Infantry Regiment',
    shortName: '2 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Terrex ICVs, 40mm AGL and 81mm mortar sections.',
  },
  {
    type: 'INFANTRY',
    name: '5th Battalion, Singapore Infantry Regiment',
    shortName: '5 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Bronco all-terrain carriers, SPIKE-LR ATGM detachments.',
  },
  {
    type: 'COMMANDO',
    name: '1st Commando Battalion',
    shortName: '1 CDO BN',
    echelon: 'Battalion',
    arm: 'Commandos',
    equipment: 'Special-operations troops: deep reconnaissance, direct action, heliborne insertion.',
  },
  {
    type: 'ARMOUR',
    name: '40th Battalion, Singapore Armoured Regiment',
    shortName: '40 SAR',
    echelon: 'Battalion',
    arm: 'Armour',
    equipment: 'Leopard 2SG main battle tanks with Hunter AFV and Bionix IFV in support.',
  },
  {
    type: 'ARTILLERY',
    name: '21st Battalion, Singapore Artillery',
    shortName: '21 SA',
    echelon: 'Battalion',
    arm: 'Artillery',
    equipment: 'SSPH Primus self-propelled howitzers, SLWH Pegasus and FH2000 gun batteries, HIMARS troop.',
  },
  {
    type: 'ENGINEER',
    name: '35th Battalion, Singapore Combat Engineers',
    shortName: '35 SCE',
    echelon: 'Battalion',
    arm: 'Combat Engineers',
    equipment: 'Assault bridging, field fortification and obstacle-breaching plant.',
  },
  {
    type: 'RECON',
    name: '24th C4I Battalion',
    shortName: '24 C4I',
    echelon: 'Battalion',
    arm: 'C4I / Signals & ISR',
    equipment: 'Ground sensor and EW teams cued by Heron 1 and Hermes 450 UAV feeds.',
  },
  {
    type: 'FRIGATE',
    name: '185 Squadron, Republic of Singapore Navy',
    shortName: '185 SQN',
    echelon: 'Squadron',
    arm: 'Republic of Singapore Navy',
    equipment: 'Formidable-class frigate task element — area air defence and naval surface fire.',
  },
  {
    type: 'CORVETTE',
    name: '188 Squadron, Republic of Singapore Navy',
    shortName: '188 SQN',
    echelon: 'Squadron',
    arm: 'Republic of Singapore Navy',
    equipment: 'Victory-class corvette with Independence-class LMV in company — littoral strike and patrol.',
  },
];

const REDFOR_OOB: FormationProfile[] = [
  {
    type: 'INFANTRY',
    name: '3rd Motorised Rifle Battalion, Northern Union Forces',
    shortName: '3 MRB',
    echelon: 'Battalion',
    arm: 'Motorised Infantry',
    equipment: 'Wheeled infantry carriers, crew-served automatic weapons, man-portable ATGMs.',
  },
  {
    type: 'INFANTRY',
    name: '7th Motorised Rifle Battalion, Northern Union Forces',
    shortName: '7 MRB',
    echelon: 'Battalion',
    arm: 'Motorised Infantry',
    equipment: 'Wheeled infantry carriers with organic 82mm mortar and AGL platoons.',
  },
  {
    type: 'INFANTRY',
    name: '11th Motorised Rifle Battalion, Northern Union Forces',
    shortName: '11 MRB',
    echelon: 'Battalion',
    arm: 'Motorised Infantry',
    equipment: 'Light truck-mobile riflemen, recoilless guns, dug-in defensive doctrine.',
  },
  {
    type: 'COMMANDO',
    name: '1st Special Purpose Battalion, Northern Union Forces',
    shortName: '1 SPB',
    echelon: 'Battalion',
    arm: 'Special Purpose Troops',
    equipment: 'Long-range raiding parties, sabotage teams, small-boat and heliborne infiltration.',
  },
  {
    type: 'ARMOUR',
    name: '22nd Tank Battalion, Northern Union Forces',
    shortName: '22 TB',
    echelon: 'Battalion',
    arm: 'Armour',
    equipment: 'Medium main battle tanks with tracked IFV companies attached.',
  },
  {
    type: 'ARTILLERY',
    name: '14th Gun & Rocket Artillery Battalion, Northern Union Forces',
    shortName: '14 GRA',
    echelon: 'Battalion',
    arm: 'Artillery',
    equipment: 'Towed 152mm gun batteries and a truck-mounted multiple rocket launcher battery.',
  },
  {
    type: 'ENGINEER',
    name: '6th Assault Engineer Battalion, Northern Union Forces',
    shortName: '6 AEB',
    echelon: 'Battalion',
    arm: 'Assault Engineers',
    equipment: 'Pontoon bridging companies, minelaying and breaching sections.',
  },
  {
    type: 'RECON',
    name: '9th Reconnaissance & Electronic Warfare Battalion, Northern Union Forces',
    shortName: '9 REB',
    echelon: 'Battalion',
    arm: 'Reconnaissance & EW',
    equipment: 'Scout car troops, direction-finding and jamming detachments, tactical UAV flight.',
  },
  {
    type: 'FRIGATE',
    name: '1st Guided-Missile Frigate Group, Northern Union Navy',
    shortName: '1 GMF',
    echelon: 'Group',
    arm: 'Northern Union Navy',
    equipment: 'Guided-missile frigate with anti-ship missiles and a medium naval gun.',
  },
  {
    type: 'CORVETTE',
    name: '5th Missile Corvette Flotilla, Northern Union Navy',
    shortName: '5 MCF',
    echelon: 'Flotilla',
    arm: 'Northern Union Navy',
    equipment: 'Fast missile corvettes for littoral strike and coastal interdiction.',
  },
];

export const ORDERS_OF_BATTLE: Record<PlayerId, FormationProfile[]> = {
  BLUEFOR: BLUEFOR_OOB,
  REDFOR: REDFOR_OOB,
};
