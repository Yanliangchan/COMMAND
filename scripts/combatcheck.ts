// ============================================================================
// COMMAND — combat-model assertions (phase 6).
//   npx tsx scripts/combatcheck.ts
//
// Deterministic checks on the things the combat model PROMISES the player, so
// a future tuning pass cannot quietly break them:
//   * the matchup table actually inverts with the ground (armour in the open
//     vs armour in a town, infantry the other way round)
//   * terrain and fortification are real multipliers
//   * both sides take losses in an even fight, and attacking always costs
//   * identification changes the WIDTH of the prediction and nothing else —
//     the resolved numbers are identical at every rung
//   * ammunition is spent by firing and regenerates by not firing
// ============================================================================

import * as engine from '../src/game/engine';
import { attackPower, defencePower, lossesFromShare, predictEngagement } from '../src/game/combat';
import { FORMATION_DEFS } from '../src/game/data';
import { Formation, FormationType, GameState, PlayerId, Tile } from '../src/game/types';

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

const base = engine.initGame(4242);

function mk(type: FormationType, x: number, y: number, owner: PlayerId): Formation {
  return {
    id: `t_${type}_${x}_${y}_${owner}`, owner, type, name: type, shortName: type, echelon: '', arm: '', equipment: '',
    x, y, strength: 100, morale: 'Steady', moraleValue: 72, moraleBaseline: 72, lastEngagedRound: 0,
    readiness: 100, ammo: FORMATION_DEFS[type].maxAmmo ?? 0, lastFiredRound: 0, movesUsed: 0, movesMax: 2,
    hasActedThisTurn: false, fortified: false, lastOrder: '',
  };
}
const tile = (terrain: Tile['terrain']): Tile => ({ x: 5, y: 5, terrain, elevation: 1, height: 0.3 });

function share(a: FormationType, d: FormationType, terrain: Tile['terrain'], fortified = false) {
  const A = mk(a, 4, 5, 'SABRE');
  const D = mk(d, 5, 5, 'VANGUARD');
  D.fortified = fortified;
  const s: GameState = { ...base, formations: { [A.id]: A, [D.id]: D } };
  const close = FORMATION_DEFS[a].attackRange === 1;
  const ap = attackPower(s, A, D, tile(terrain), close).power;
  const dp = defencePower(s, D, tile(terrain)).power;
  return ap / (ap + dp);
}

// --- matchups invert with the ground ---------------------------------------
const armourOpen = share('ARMOUR', 'INFANTRY', 'GRASS');
const armourUrban = share('ARMOUR', 'INFANTRY', 'URBAN');
check(armourOpen > 0.6, `armour beats infantry in the open (${(armourOpen * 100).toFixed(0)}%)`);
check(armourUrban < 0.45, `armour is repulsed by infantry in a town (${(armourUrban * 100).toFixed(0)}%)`);
const infVsArmourOpen = share('INFANTRY', 'ARMOUR', 'GRASS');
const infVsArmourUrban = share('INFANTRY', 'ARMOUR', 'URBAN');
check(infVsArmourUrban > infVsArmourOpen + 0.05, `infantry dig armour out of a town far better than in the open (${(infVsArmourOpen*100).toFixed(0)}% → ${(infVsArmourUrban*100).toFixed(0)}%)`);
const gunsOpen = share('ARTILLERY', 'INFANTRY', 'GRASS');
const gunsUrban = share('ARTILLERY', 'INFANTRY', 'URBAN');
check(gunsOpen > 0.6 && gunsUrban < 0.45, `guns devastate the exposed and fail against cover (${(gunsOpen*100).toFixed(0)}% vs ${(gunsUrban*100).toFixed(0)}%)`);
check(share('RECON', 'INFANTRY', 'GRASS') < 0.25, 'a sensor battalion attacking infantry is a disaster');

// --- terrain and fortification are real ------------------------------------
check(share('ARMOUR','INFANTRY','GRASS') > share('ARMOUR','INFANTRY','HILLS'), 'high ground helps the defender');
check(share('ARMOUR','INFANTRY','GRASS') > share('ARMOUR','INFANTRY','GRASS', true), 'digging in helps the defender');

// --- both sides bleed, and attacking always costs --------------------------
const even = lossesFromShare(0.5, true);
check(Math.abs(even.attacker - even.defender) < 0.001, `an even fight costs both sides the same (${(-even.attacker).toFixed(1)}%)`);
check(-even.attacker > 10 && -even.attacker < 20, `an even fight costs about a seventh of a battalion (${(-even.attacker).toFixed(1)}%)`);
const lopsided = lossesFromShare(0.8, true);
check(-lopsided.attacker > 4, `even a 4:1 attack still costs the attacker something (${(-lopsided.attacker).toFixed(1)}%)`);
check(-lossesFromShare(0.8, false).attacker < -lossesFromShare(0.8, true).attacker, 'standoff fire is safer than closing');

// --- identification changes the WIDTH of the prediction, not the result -----
{
  const A = mk('ARMOUR', 4, 5, 'SABRE');
  const D = mk('INFANTRY', 5, 5, 'VANGUARD');
  const s: GameState = { ...base, formations: { [A.id]: A, [D.id]: D } };
  s.tiles[5][5] = { ...s.tiles[5][5], terrain: 'GRASS' } as Tile;
  const confirmed = predictEngagement(s, A, D, true, 'CONFIRMED');
  const identified = predictEngagement(s, A, D, true, 'IDENTIFIED');
  const w = (p: typeof confirmed) => p.defenderLoss.high - p.defenderLoss.low;
  check(w(identified) > w(confirmed) * 1.8, `an unconfirmed target predicts far wider (${w(confirmed).toFixed(1)} pts confirmed vs ${w(identified).toFixed(1)} pts identified)`);
  check(Math.abs(confirmed.share - identified.share) < 1e-9, 'the mid-point prediction is the same at both rungs — recon buys certainty, not firepower');
  check(confirmed.assumptions.length === 0 && !confirmed.uncertain, 'a confirmed prediction states no assumptions');

  // The real resolution must be identical whatever the attacker had detected:
  // there is no identification damage penalty any more.
  const seen = new Set<number>();
  for (const rung of ['CONFIRMED', 'IDENTIFIED', 'CONTACT'] as const) {
    const s2: GameState = { ...base, formations: { [A.id]: { ...A }, [D.id]: { ...D } } };
    s2.players = { ...base.players, SABRE: { ...base.players.SABRE, contacts: { [D.id]: { formationId: D.id, owner: 'VANGUARD', level: rung, confidence: 90, x: 5, y: 5, live: true, lastSeenTurn: 1, decayAnchorRound: 1, lastRiseRound: 1, ceiling: 100, decayPerRound: 10, source: 'test' } } } };
    const ap = attackPower(s2, s2.formations[A.id], s2.formations[D.id], s2.tiles[5][5], true).power;
    seen.add(Math.round(ap * 1e6));
  }
  check(seen.size === 1, 'attack power is identical at every detection rung (the identification penalty is gone)');
}

// --- ammunition: spent by firing, regained by holding fire ------------------
{
  const s = engine.initGame(777);
  const gun = Object.values(s.formations).find((f) => f.type === 'ARTILLERY' && f.owner === s.activePlayer)!;
  const max = engine.maxAmmo(gun);
  check(max === 4, `an artillery battalion carries ${max} ready rounds`);
  const inf = Object.values(s.formations).find((f) => f.type === 'INFANTRY')!;
  check(!engine.usesAmmo(inf), 'infantry do not use ammunition at all');
  // Park an enemy next to the guns and fire.
  const foe = Object.values(s.formations).find((f) => f.owner !== gun.owner)!;
  foe.x = gun.x + 2; foe.y = gun.y;
  engine.artilleryAction(s, gun.id, foe.x, foe.y);
  check(gun.ammo === max - 1, `firing a mission spends one round (${max} → ${gun.ammo})`);
  const held = gun.ammo;
  engine.endTurn(s); // gun fired this round — no regen
  check(gun.ammo === held, 'no ammunition comes back in the round it fired');
  engine.beginPlayerTurn(s);
  engine.endTurn(s); // opponent
  engine.beginPlayerTurn(s);
  engine.endTurn(s); // a quiet round for the gun
  check(gun.ammo === held + 1, `holding fire for a round returns one round (${held} → ${gun.ammo})`);
  gun.ammo = 0;
  check(!engine.hasAmmo(gun), 'a dry battery cannot fire');
}

console.log(failures ? `\nFAIL: ${failures} combat-model assertion(s)` : '\nPASS: combat model holds.');
process.exit(failures ? 1 : 0);
