import { DETECTION, FormationDef, FormationType, MOBILITY, PlayerId, TerrainDef, TerrainType } from './types';

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
    sightRadius: DETECTION.INFANTRY.baseRange,
    reconRadius: DETECTION.INFANTRY.reconRange,
    isNaval: false,
    maxAmmo: null,
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
    sightRadius: DETECTION.COMMANDO.baseRange,
    reconRadius: DETECTION.COMMANDO.reconRange,
    isNaval: false,
    maxAmmo: null,
    movesPerRound: MOBILITY.COMMANDO.movesPerRound,
  },
  // Phase 5: each task force fields ONE elite manoeuvre battalion. SABRE's
  // commandos and VANGUARD's Guards are deliberately of comparable weight but
  // different character — the commandos are a raiding / deep-recce force
  // (fragile, best sensors on the board, longest special-operation reach), the
  // Guards an air-assault rifle battalion that arrives by helicopter and then
  // FIGHTS as formed infantry (tougher, ordinary sensors, shorter insertion
  // reach). Neither is strictly better; the seeded bot-vs-bot soak measures it.
  GUARDS: {
    type: 'GUARDS',
    label: 'Guards Battalion',
    branch: 'Army',
    baseAttack: 7,
    baseDefense: 6,
    moveRange: MOBILITY.GUARDS.moveRange,
    attackRange: 1,
    sightRadius: DETECTION.GUARDS.baseRange,
    reconRadius: DETECTION.GUARDS.reconRange,
    isNaval: false,
    maxAmmo: null,
    movesPerRound: MOBILITY.GUARDS.movesPerRound,
  },
  ARMOUR: {
    type: 'ARMOUR',
    label: 'Armoured Battalion',
    branch: 'Army',
    baseAttack: 10,
    baseDefense: 6,
    moveRange: MOBILITY.ARMOUR.moveRange,
    attackRange: 1,
    sightRadius: DETECTION.ARMOUR.baseRange,
    reconRadius: DETECTION.ARMOUR.reconRange,
    isNaval: false,
    maxAmmo: null,
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
    sightRadius: DETECTION.ARTILLERY.baseRange,
    reconRadius: DETECTION.ARTILLERY.reconRange,
    isNaval: false,
    // Phase 6: ammunition is a small whole number of ready fire missions, not a
    // percentage, and it is the ONLY thing that stops the guns firing every
    // turn forever now that supply is gone. Four rounds, one back per quiet
    // round: fire two or three missions, then let the battery replenish.
    maxAmmo: 4,
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
    sightRadius: DETECTION.ENGINEER.baseRange,
    reconRadius: DETECTION.ENGINEER.reconRange,
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
    sightRadius: DETECTION.RECON.baseRange,
    reconRadius: DETECTION.RECON.reconRange,
    isNaval: false,
    maxAmmo: null,
    movesPerRound: MOBILITY.RECON.movesPerRound,
  },
  FRIGATE: {
    type: 'FRIGATE',
    label: 'Surface Combatant Squadron',
    branch: 'Navy',
    baseAttack: 9,
    baseDefense: 7,
    moveRange: MOBILITY.FRIGATE.moveRange,
    // Phase 6: naval gunfire is a STANDOFF capability and now feels like one.
    // 4 -> 9 tiles: the frigate out-ranges a land artillery battalion (7) and
    // can work a coastline from water the enemy cannot reach at all. It still
    // cannot take ground — standoff fire damages and never occupies.
    attackRange: 9,
    sightRadius: DETECTION.FRIGATE.baseRange,
    reconRadius: DETECTION.FRIGATE.reconRange,
    isNaval: true,
    maxAmmo: 4,
    movesPerRound: MOBILITY.FRIGATE.movesPerRound,
  },
  CORVETTE: {
    type: 'CORVETTE',
    label: 'Littoral Combat Squadron',
    branch: 'Navy',
    baseAttack: 6,
    baseDefense: 5,
    moveRange: MOBILITY.CORVETTE.moveRange,
    // 3 -> 6 tiles: real standoff reach, but clearly inside the frigate's, and
    // just short of a gun battalion's — the littoral squadron has to come in
    // closer to make its weight felt.
    attackRange: 6,
    sightRadius: DETECTION.CORVETTE.baseRange,
    reconRadius: DETECTION.CORVETTE.reconRange,
    isNaval: true,
    maxAmmo: 3,
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
// ORDERS OF BATTLE — Exercise SABRE VANGUARD
//
// The scenario is a large-scale SAF FORCE-ON-FORCE EXERCISE: two task forces
// drawn from the same armed forces fight each other over a fictional training
// area. Both sides therefore use real, publicly documented SAF/RSN formation
// names and naming conventions (see README, "Real-World Reference vs Fictional
// Game Mechanics").
//
// WHAT IS REAL: the formation titles, their short designations, their arm of
// service and the general character of each arm — all drawn from public
// sources.
//
// WHAT IS FICTIONAL: which battalion is assigned to which exercise task force,
// every stat, cost and AP value, and the equipment strings' pairing with a
// specific battalion. Nothing here asserts a real SAF order of battle,
// grouping, strength or capability.
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

/** Full task-force titles, as printed in the roster and the after-action screen. */
export const FACTION_NAMES: Record<PlayerId, string> = {
  SABRE: 'Task Force Sabre',
  VANGUARD: 'Task Force Vanguard',
};

/** Compact form for chips, the HUD and the log. */
export const FACTION_SHORT: Record<PlayerId, string> = {
  SABRE: 'TF SABRE',
  VANGUARD: 'TF VANGUARD',
};

/** The exercise both task forces are fighting. */
export const EXERCISE_NAME = 'Exercise Sabre Vanguard';

const SABRE_OOB: FormationProfile[] = [
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
    equipment: 'Special-operations troops: deep reconnaissance, direct action, heliborne and small-boat insertion.',
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
    // 48 SAR is the SAF's fourth active armour battalion (formed 2008,
    // Keat Hong / Sungei Gedong Camp) alongside 40/41/42 SAR — a tank
    // battalion fielding Leopard 2SG, consistent with the existing armour
    // formations' equipment line. Verified against public sources; see
    // README "Real-World Reference vs Fictional Game Mechanics".
    type: 'ARMOUR',
    name: '48th Battalion, Singapore Armoured Regiment',
    shortName: '48 SAR',
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
    name: '10th Command, Control, Communications, Computers and Intelligence Battalion',
    shortName: '10 C4I Bn',
    echelon: 'Battalion',
    arm: 'C4I / Signals & ISR',
    equipment: 'Ground sensor and EW teams cued by Heron 1 and Hermes 450 UAV feeds.',
  },
  {
    // 12 C4I Bn is a second, publicly documented SAF C4I battalion (distinct
    // from 10 C4I Bn already fielded above) — referenced in connection with
    // HQ 4 SAB. Verified against public sources; see README "Real-World
    // Reference vs Fictional Game Mechanics".
    type: 'RECON',
    name: '12th Command, Control, Communications, Computers and Intelligence Battalion',
    shortName: '12 C4I Bn',
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
    equipment: 'Victory-class missile corvette element — littoral strike and surface patrol.',
  },
];

const VANGUARD_OOB: FormationProfile[] = [
  {
    type: 'INFANTRY',
    name: '3rd Battalion, Singapore Infantry Regiment',
    shortName: '3 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Terrex ICVs, SPIKE-LR ATGM detachments.',
  },
  {
    type: 'INFANTRY',
    name: '8th Battalion, Singapore Infantry Regiment',
    shortName: '8 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Terrex ICVs, 40mm AGL and 81mm mortar sections.',
  },
  {
    type: 'INFANTRY',
    name: '9th Battalion, Singapore Infantry Regiment',
    shortName: '9 SIR',
    echelon: 'Battalion',
    arm: 'Infantry',
    equipment: 'SAR 21 rifles, Bronco all-terrain carriers, SPIKE-LR ATGM detachments.',
  },
  {
    type: 'GUARDS',
    name: '1st Battalion, Singapore Guards',
    shortName: '1 GDS',
    echelon: 'Battalion',
    arm: 'Guards',
    equipment: 'Air-assault infantry: heli-rappelling and fast-roping rifle companies with Light Strike Vehicles.',
  },
  {
    type: 'ARMOUR',
    name: '41st Battalion, Singapore Armoured Regiment',
    shortName: '41 SAR',
    echelon: 'Battalion',
    arm: 'Armour',
    equipment: 'Leopard 2SG main battle tanks with Hunter AFV and Bionix IFV in support.',
  },
  {
    // 42 SAR is the SAF's third active armour battalion (formed 1971,
    // Sungei Gedong Camp), an armoured infantry battalion alongside
    // 40/41/48 SAR. Verified against public sources; see README
    // "Real-World Reference vs Fictional Game Mechanics".
    type: 'ARMOUR',
    name: '42nd Battalion, Singapore Armoured Regiment',
    shortName: '42 SAR',
    echelon: 'Battalion',
    arm: 'Armour',
    equipment: 'Leopard 2SG main battle tanks with Hunter AFV and Bionix IFV in support.',
  },
  {
    type: 'ARTILLERY',
    name: '20th Battalion, Singapore Artillery',
    shortName: '20 SA',
    echelon: 'Battalion',
    arm: 'Artillery',
    equipment: 'SSPH Primus self-propelled howitzers, SLWH Pegasus gun batteries, HIMARS troop.',
  },
  {
    type: 'ENGINEER',
    name: '30th Battalion, Singapore Combat Engineers',
    shortName: '30 SCE',
    echelon: 'Battalion',
    arm: 'Combat Engineers',
    equipment: 'Assault bridging, field fortification and obstacle-breaching plant.',
  },
  {
    type: 'RECON',
    name: '11th Command, Control, Communications, Computers and Intelligence Battalion',
    shortName: '11 C4I Bn',
    echelon: 'Battalion',
    arm: 'C4I / Signals & ISR',
    equipment: 'Ground sensor and EW teams cued by Heron 1 and Hermes 450 UAV feeds.',
  },
  {
    // 16 C4I Bn is a second, publicly documented SAF C4I battalion (distinct
    // from 11 C4I Bn already fielded above) — named in MINDEF's Exercise
    // Wallaby 2024 fact sheet as a supporting unit. Verified against public
    // sources; see README "Real-World Reference vs Fictional Game Mechanics".
    type: 'RECON',
    name: '16th Command, Control, Communications, Computers and Intelligence Battalion',
    shortName: '16 C4I Bn',
    echelon: 'Battalion',
    arm: 'C4I / Signals & ISR',
    equipment: 'Ground sensor and EW teams cued by Heron 1 and Hermes 450 UAV feeds.',
  },
  {
    // 191 SQN is the RSN's publicly documented Endurance-class squadron (3rd
    // Flotilla). Its real role is amphibious/landing-platform-dock, not air
    // defence — the game slots it as VANGUARD's heavy surface group because it
    // is the comparable-weight major-surface-combatant squadron. That slotting
    // is an exercise arrangement, not a claim about the squadron's real task.
    type: 'FRIGATE',
    name: '191 Squadron, Republic of Singapore Navy',
    shortName: '191 SQN',
    echelon: 'Squadron',
    arm: 'Republic of Singapore Navy',
    equipment: 'Endurance-class landing platform dock group — heavy surface presence, aviation deck, naval gunfire support.',
  },
  {
    // 189 SQN is the RSN's publicly documented Fearless-class patrol-vessel
    // squadron, armed for anti-submarine work — the littoral counterpart to
    // 188 SQN for the purposes of this exercise.
    type: 'CORVETTE',
    name: '189 Squadron, Republic of Singapore Navy',
    shortName: '189 SQN',
    echelon: 'Squadron',
    arm: 'Republic of Singapore Navy',
    equipment: 'Fearless-class patrol vessel element — littoral patrol, anti-submarine and surface engagement.',
  },
];

export const ORDERS_OF_BATTLE: Record<PlayerId, FormationProfile[]> = {
  SABRE: SABRE_OOB,
  VANGUARD: VANGUARD_OOB,
};
