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
import { FORMATION_DEFS, ORDERS_OF_BATTLE } from '../src/game/data';
import { movementProfile, planMove } from '../src/game/movement';
import { AP_CAP, AP_COSTS, AP_PER_TURN, Formation, FormationType, GameState, GRID_SIZE, PlayerId, Tile, moraleBandFor } from '../src/game/types';

let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

const base = engine.initGame(4242);

let mkSeq = 0;
function mk(type: FormationType, x: number, y: number, owner: PlayerId): Formation {
  mkSeq++;
  return {
    id: `t_${type}_${x}_${y}_${owner}_${mkSeq}`, owner, type, name: type, shortName: type, echelon: '', arm: '', equipment: '',
    x, y, strength: 100, morale: 'Steady', moraleValue: 72, moraleBaseline: 72, lastEngagedRound: 0,
    readiness: 100, ammo: FORMATION_DEFS[type].maxAmmo ?? 0, lastFiredRound: 0, movesUsed: 0, movesMax: 2,
    hasActedThisTurn: false, fortified: false, lastOrder: '',
    onAlert: false, reactionFired: false, suppression: 0, lastSuppressedRound: 0, lastReorganizedRound: 0,
  };
}
const tile = (terrain: Tile['terrain']): Tile => ({ x: 5, y: 5, terrain, elevation: 1, height: 0.3 });

/** A full 72x72 grid of flat, open ground — full control for movement/ZOC/overwatch/naval-LOS tests. */
function makeOpenTiles(): Tile[][] {
  const tiles: Tile[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < GRID_SIZE; x++) row.push({ x, y, terrain: 'GRASS', elevation: 1, height: 0.3 });
    tiles.push(row);
  }
  return tiles;
}

/** A minimal, fully-controlled GameState for phase-7 mechanic tests: flat open
 *  map, unlimited AP, only the given formations on the board. */
function scenario(formations: Formation[], activePlayer: PlayerId = 'SABRE'): GameState {
  const tiles = makeOpenTiles();
  const byId: GameState['formations'] = {};
  for (const f of formations) byId[f.id] = f;
  return {
    ...base,
    tiles,
    formations: byId,
    activePlayer,
    players: {
      SABRE: { ...base.players.SABRE, ap: 60, contacts: {} },
      VANGUARD: { ...base.players.VANGUARD, ap: 60, contacts: {} },
    },
    killFeed: [],
    log: [],
  };
}

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
  const foeSuppressionBefore = foe.suppression;
  engine.artilleryAction(s, gun.id, foe.x, foe.y);
  check(gun.ammo === max - 1, `firing a mission spends one round (${max} → ${gun.ammo})`);
  check(foe.suppression === foeSuppressionBefore + 30, `a fire mission suppresses its target by 30 (${foeSuppressionBefore} → ${foe.suppression})`);
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

// =============================================================================
// PHASE 7 — overwatch, Zones of Control, suppression, Reorganize, naval LOS
// =============================================================================

// --- Overwatch / reaction fire ----------------------------------------------
{
  // A stood-down formation goes on alert, fires exactly once, and the alert
  // clears at the start of its own next turn.
  const s = engine.initGame(555);
  const finishing = s.activePlayer;
  const idle = Object.values(s.formations).find((f) => f.owner === finishing && f.type !== 'ARTILLERY')!;
  const arty = Object.values(s.formations).find((f) => f.owner === finishing && f.type === 'ARTILLERY');
  engine.endTurn(s);
  check(s.formations[idle.id].onAlert === true, 'a formation that did not act this round goes on alert at end of turn');
  if (arty) check(s.formations[arty.id].onAlert === false, 'artillery never goes on alert (not a direct-fire weapon)');
  engine.beginPlayerTurn(s);
  engine.endTurn(s); // the opponent's turn passes
  engine.beginPlayerTurn(s); // back to `finishing` — alert should have served its purpose
  check(s.formations[idle.id].onAlert === false, "alert clears at the start of the formation's own next turn");
}
{
  // An on-alert formation fires a reduced-power reaction shot at an enemy
  // that moves into its detection range and line of sight.
  const alert = mk('INFANTRY', 20, 20, 'VANGUARD');
  alert.onAlert = true;
  const mover = mk('INFANTRY', 15, 19, 'SABRE');
  const s = scenario([alert, mover], 'SABRE');
  const before = mover.strength;
  engine.moveFormation(s, mover.id, 19, 20); // ends adjacent to the alert formation
  const moverAfter = s.formations[mover.id];
  check(!!moverAfter && moverAfter.strength < before, 'moving into an on-alert formation’s range + LOS draws a reaction shot');
  check(s.formations[alert.id].reactionFired === true, 'the alert formation marks its one reaction shot as spent');
  check(s.log.some((l) => l.text.includes('reaction fire')), 'a reaction-fire event is logged');
}
{
  // One alert formation fires at most once per opponent turn, even against a
  // second mover that also qualifies.
  const alert = mk('INFANTRY', 30, 30, 'VANGUARD');
  alert.onAlert = true;
  const m1 = mk('INFANTRY', 30, 33, 'SABRE');
  const m2 = mk('INFANTRY', 33, 30, 'SABRE');
  const s = scenario([alert, m1, m2], 'SABRE');
  engine.moveFormation(s, m1.id, 30, 31); // adjacent to alert — draws the one shot
  check(s.formations[alert.id]?.reactionFired === true, 'the first qualifying mover draws the alert unit’s shot');
  engine.moveFormation(s, m2.id, 31, 30); // also adjacent to alert, same turn
  const m2After = s.formations[m2.id];
  check(!!m2After && m2After.strength === 100, 'an on-alert formation does not fire a second reaction shot the same opponent turn');
}
{
  // Artillery never fires overwatch, even if onAlert were somehow set.
  const arty = mk('ARTILLERY', 40, 40, 'VANGUARD');
  arty.onAlert = true;
  const mover = mk('INFANTRY', 40, 42, 'SABRE');
  const s = scenario([arty, mover], 'SABRE');
  engine.moveFormation(s, mover.id, 40, 41);
  const moverAfter = s.formations[mover.id];
  check(!!moverAfter && moverAfter.strength === 100, 'artillery on alert still never fires a reaction shot');
}

// --- Zones of Control --------------------------------------------------------
{
  const enemy = mk('INFANTRY', 20, 20, 'VANGUARD');
  const mover = mk('INFANTRY', 15, 19, 'SABRE');
  const s = scenario([enemy, mover], 'SABRE');
  const toZocTile = planMove(s, mover, 20, 19); // an enemy ZOC tile — reachable as a stop
  check(toZocTile.ok, 'a formation may move onto an enemy Zone of Control tile and stop there');
  const beyond = planMove(s, mover, 22, 19); // needs to pass through (20,19) to continue
  check(!beyond.ok && beyond.refusal === 'ZOC_BLOCKED', `moving through a ZOC tile to a destination beyond it is refused (refusal=${beyond.refusal}, reachable=${beyond.ok})`);
}
{
  const enemy = mk('INFANTRY', 40, 40, 'VANGUARD');
  const mover = mk('INFANTRY', 41, 40, 'SABRE'); // starts adjacent to the enemy — inside its ZOC
  const s = scenario([enemy, mover], 'SABRE');
  const disengage = planMove(s, mover, 42, 40); // one tile further away
  const range = movementProfile(mover).effectiveRange;
  check(disengage.ok, 'disengaging from a ZOC is still possible, just expensive');
  check(disengage.cost >= range - 1e-6, `disengaging from ZOC costs a full movement action's worth of points (cost=${disengage.cost}, action=${range})`);
  check(!!disengage.zocNote, 'the movement preview explains the ZOC disengagement surcharge');
}
{
  // Artillery projects no ZOC at all — a path through what WOULD be one of its
  // ZOC tiles (if it projected one) is not stopped there.
  const arty = mk('ARTILLERY', 50, 50, 'VANGUARD');
  const mover = mk('INFANTRY', 47, 49, 'SABRE');
  const s = scenario([arty, mover], 'SABRE');
  const through = planMove(s, mover, 53, 49); // passes through (50,49), adjacent to the gun
  check(through.ok, 'artillery projects no Zone of Control — movement passes through freely');
}

// --- Suppression --------------------------------------------------------------
{
  const A = mk('ARMOUR', 4, 5, 'SABRE');
  const D = mk('INFANTRY', 5, 5, 'VANGUARD');
  const s: GameState = { ...base, formations: { [A.id]: A, [D.id]: D } };
  const before = attackPower(s, A, D, tile('GRASS'), true).power;
  A.suppression = 100;
  const after = attackPower(s, A, D, tile('GRASS'), true).power;
  check(after < before && after > before * 0.45, `suppression cuts attack power, up to -50% at maximum (${((1 - after / before) * 100).toFixed(0)}% reduction at 100%)`);
}
{
  const f = mk('INFANTRY', 10, 10, 'SABRE');
  const unsuppressed = movementProfile(f).effectiveRange;
  f.suppression = 100;
  const suppressed = movementProfile(f).effectiveRange;
  check(suppressed < unsuppressed, `suppression reduces movement range (${unsuppressed} → ${suppressed})`);
}
{
  // Decays a round after last applied; lingers longer in the open, recovers
  // faster under cover.
  const openF = mk('INFANTRY', 10, 10, 'SABRE');
  const sOpen = scenario([openF], 'SABRE');
  sOpen.tiles[10][10] = { ...sOpen.tiles[10][10], terrain: 'OPEN' };
  openF.suppression = 80;
  openF.lastSuppressedRound = 0; // suppressed in a past round, not this one
  engine.endTurn(sOpen); // ticks condition for openF's owner
  const openLoss = 80 - sOpen.formations[openF.id].suppression;
  check(openLoss > 0, `suppression decays when not refreshed (lost ${openLoss})`);

  const coverF = mk('INFANTRY', 10, 10, 'SABRE');
  const sCover = scenario([coverF], 'SABRE');
  sCover.tiles[10][10] = { ...sCover.tiles[10][10], terrain: 'FOREST' };
  coverF.suppression = 80;
  coverF.lastSuppressedRound = 0;
  engine.endTurn(sCover);
  const coverLoss = 80 - sCover.formations[coverF.id].suppression;
  check(coverLoss > openLoss, `suppression decays faster under cover than in the open (open ${openLoss} vs forest ${coverLoss})`);
}
{
  const A = mk('FRIGATE', 10, 10, 'SABRE');
  const D = mk('INFANTRY', 16, 10, 'VANGUARD');
  const s = scenario([A, D], 'SABRE');
  const before = D.suppression;
  engine.attackAction(s, A.id, D.id);
  const after = s.formations[D.id]?.suppression ?? 0;
  check(after > before, 'naval standoff fire suppresses its target too, alongside damage');
}

// --- Reorganize -----------------------------------------------------------
{
  const s = engine.initGame(321);
  const f = Object.values(s.formations).find((x) => x.owner === s.activePlayer)!;
  f.strength = 60;
  f.readiness = 50;
  f.moraleValue = 50;
  f.morale = moraleBandFor(50);
  const apBefore = s.players[s.activePlayer].ap;
  engine.reorganizeAction(s, f.id);
  const after = s.formations[f.id];
  check(after.readiness > 50, 'Reorganize restores readiness');
  check(after.strength > 60, 'Reorganize restores a little strength');
  check(after.hasActedThisTurn === true, "Reorganize spends the formation's major action");
  check(s.players[s.activePlayer].ap === apBefore - AP_COSTS.REORGANIZE, `Reorganize costs ${AP_COSTS.REORGANIZE} AP`);
  const strengthAfterFirst = after.strength;
  engine.reorganizeAction(s, f.id); // same round — major action already spent
  check(s.formations[f.id].strength === strengthAfterFirst, 'Reorganize cannot be used twice in the same round');
}
{
  const s = engine.initGame(321);
  const f = Object.values(s.formations).find((x) => x.owner === s.activePlayer)!;
  f.movesUsed = 1;
  const before = f.strength;
  engine.reorganizeAction(s, f.id);
  check(s.formations[f.id].strength === before, 'Reorganize is blocked once the formation has moved this round');
}
{
  const s = engine.initGame(321);
  const f = Object.values(s.formations).find((x) => x.owner === s.activePlayer)!;
  f.lastReorganizedRound = s.round; // just used it
  const before = f.strength;
  engine.reorganizeAction(s, f.id);
  check(s.formations[f.id].strength === before, "Reorganize respects its cooldown");
}

// --- Naval fire onto land, gated by line of sight ---------------------------
{
  const tiles = makeOpenTiles();
  tiles[10][13] = { ...tiles[10][13], terrain: 'HILLS', height: 0.95, elevation: 5 };
  const ship = mk('FRIGATE', 10, 10, 'SABRE');
  const target = mk('INFANTRY', 16, 10, 'VANGUARD');
  const s: GameState = { ...scenario([ship, target], 'SABRE'), tiles };
  const before = target.strength;
  engine.attackAction(s, ship.id, target.id);
  check(s.formations[target.id]!.strength === before, 'naval standoff fire is blocked by intervening high ground even within range');
}
{
  const ship = mk('FRIGATE', 10, 10, 'SABRE');
  const target = mk('INFANTRY', 16, 10, 'VANGUARD'); // inland, well beyond the old "coastal" band, but within the frigate's 9-tile range
  const s = scenario([ship, target], 'SABRE');
  const before = target.strength;
  engine.attackAction(s, ship.id, target.id);
  const after = s.formations[target.id]?.strength ?? 0;
  check(after < before, 'naval standoff fire reaches an inland target within range when line of sight is clear');
}

// --- Destroyed-formation visibility -----------------------------------------
{
  const A = mk('ARMOUR', 10, 10, 'SABRE');
  const D = mk('ENGINEER', 11, 10, 'VANGUARD');
  D.strength = 4;
  const s = scenario([A, D], 'SABRE');
  // SABRE has already spotted D (they are adjacent) — a real attack always
  // implies at least this much, since the client can only select a target it
  // has already been sent as a formation object (IDENTIFIED or better).
  s.players.SABRE.contacts[D.id] = {
    formationId: D.id, owner: 'VANGUARD', level: 'CONFIRMED', confidence: 95, x: D.x, y: D.y,
    live: true, lastSeenTurn: s.round, decayAnchorRound: s.round, lastRiseRound: s.round, ceiling: 100, decayPerRound: 20, source: 'test',
  };
  engine.attackAction(s, A.id, D.id);
  check(!s.formations[D.id], 'a formation reduced to 0 strength is removed from the roster');
  check(s.killFeed.length === 1 && s.killFeed[0].formationId === D.id, 'a kill event is recorded on the kill feed');
  check(
    s.log.some((l) => l.text.includes('destroyed at grid') && l.audience === 'VANGUARD'),
    "the owning side gets a full-detail destruction log line"
  );
  check(
    s.log.some((l) => l.text.includes('destroyed at grid') && l.audience === 'SABRE'),
    'the other side gets a destruction log line too (redaction-capped)'
  );
}

// ---------------------------------------------------------------------------
// Phase 8: roster/AP-economy regression guard. 48 SAR / 42 SAR brought each
// side from 10 to 11 formations (8 -> 9 land, 2 naval unchanged) and the AP
// budget was bumped 26 -> 28 (cap 34 -> 36) to absorb the extra formation's
// action appetite. This is not a combat-formula assertion like the rest of
// the file, but it belongs here for the same reason as the ammunition and
// destruction checks above: a future roster or AP edit that silently drifts
// the two out of sync again should fail loudly rather than only be caught by
// eyeballing the balance sim.
// ---------------------------------------------------------------------------
{
  (['SABRE', 'VANGUARD'] as PlayerId[]).forEach((side) => {
    const oob = ORDERS_OF_BATTLE[side] as { type: FormationType; shortName: string }[];
    check(oob.length === 11, `${side} fields 11 formations (has ${oob.length})`);
    const armour = oob.filter((p) => p.type === 'ARMOUR');
    check(armour.length === 2, `${side} fields exactly two armoured battalions (has ${armour.length}: ${armour.map((p) => p.shortName).join(', ')})`);
  });
  check(
    ORDERS_OF_BATTLE.SABRE.some((p: { shortName: string }) => p.shortName === '48 SAR'),
    'SABRE roster includes 48 SAR'
  );
  check(
    ORDERS_OF_BATTLE.VANGUARD.some((p: { shortName: string }) => p.shortName === '42 SAR'),
    'VANGUARD roster includes 42 SAR'
  );
  check(AP_PER_TURN === 28 && AP_CAP === 36, `AP economy matches the phase-8 bump (AP_PER_TURN=${AP_PER_TURN}, AP_CAP=${AP_CAP})`);
}

console.log(failures ? `\nFAIL: ${failures} combat-model assertion(s)` : '\nPASS: combat model holds.');
process.exit(failures ? 1 : 0);
