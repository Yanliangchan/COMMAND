// ============================================================================
// COMMAND — wire-redaction assertion suite.
//   npx tsx scripts/wirecheck.ts
//
// fog.ts is the only thing standing between the authoritative server state and
// a client that would otherwise be told everything. This suite drives real
// games to the point where all four detection rungs are present at once, then
// asserts, field by field from an EXPLICIT list, that each rung reveals exactly
// what it is allowed to and not one field more.
//
// The explicit field list is the point: it fails CLOSED. A field added to
// Formation and not classified here is reported as unclassified rather than
// quietly riding out on the wire. That is how the phase-6 supply removal and
// the ammunition/lastFiredRound additions were caught and checked.
// ============================================================================

import * as engine from '../src/game/engine';
import {
  filterStateForPlayer,
  GENERIC_BLOCKED_LANDING_MESSAGE,
  GENERIC_BLOCKED_TILE_MESSAGE,
  REDACTED_NUMBER,
  safeMoveRefusalMessage,
  safeOccupantRefusalMessage,
} from '../src/game/fog';
import { decideBotAction } from '../server/bot';
import { ServerMsg } from '../src/net/protocol';
import { DetectionLevel, Formation, GameState, PlayerId, otherPlayer } from '../src/game/types';

// --- The contract ----------------------------------------------------------
// Every field of Formation, classified by the LOWEST rung at which a viewer is
// allowed to see its true value.
const TRUE_AT: Record<keyof Formation, DetectionLevel> = {
  // Position and arm are what IDENTIFIED means.
  id: 'IDENTIFIED',
  owner: 'IDENTIFIED',
  type: 'IDENTIFIED',
  x: 'IDENTIFIED',
  y: 'IDENTIFIED',
  intel: 'IDENTIFIED',
  redacted: 'IDENTIFIED',
  // Everything below is intelligence and must be withheld until CONFIRMED.
  name: 'CONFIRMED',
  shortName: 'CONFIRMED',
  echelon: 'CONFIRMED',
  arm: 'CONFIRMED',
  equipment: 'CONFIRMED',
  strength: 'CONFIRMED',
  morale: 'CONFIRMED',
  moraleValue: 'CONFIRMED',
  moraleBaseline: 'CONFIRMED',
  lastEngagedRound: 'CONFIRMED',
  readiness: 'CONFIRMED',
  ammo: 'CONFIRMED',
  lastFiredRound: 'CONFIRMED',
  movesUsed: 'CONFIRMED',
  movesMax: 'CONFIRMED',
  hasActedThisTurn: 'CONFIRMED',
  fortified: 'CONFIRMED',
  lastOrder: 'CONFIRMED',
  // Phase 7 additions — same tier as the other battlefield-condition fields.
  onAlert: 'CONFIRMED',
  reactionFired: 'CONFIRMED',
  suppression: 'CONFIRMED',
  lastSuppressedRound: 'CONFIRMED',
  lastReorganizedRound: 'CONFIRMED',
  // Phase 9 additions — same tier as the rest of the battlefield-condition fields.
  fortifyTier: 'CONFIRMED',
  fortifiedThisRound: 'CONFIRMED',
  verticalInsertsUsed: 'CONFIRMED',
  // Phase 11 §5 additions — last stand is intelligence too, same tier.
  lastStandTriggered: 'CONFIRMED',
  lastStandUntilRound: 'CONFIRMED',
  roundsStationary: 'CONFIRMED',
};

const failures: string[] = [];
let checks = 0;
const seen: Record<DetectionLevel, number> = { UNKNOWN: 0, CONTACT: 0, IDENTIFIED: 0, CONFIRMED: 0 };
// Phase 8: the renderer picks its arm silhouette straight off `f.type` (see
// render/icons.ts) — CONTACT-level enemies must never be sent a `type` at
// all (asserted below via `contact.type === undefined`), or the client would
// have the arm to draw an icon from at a rung the design deliberately
// withholds it. This table confirms that rule is actually EXERCISED for
// every arm — including the two new armour formations (48 SAR / 42 SAR) —
// not just asserted for whichever arm happens to reach each rung first.
const seenByTypeAndLevel: Record<string, Record<DetectionLevel, number>> = {};
function trackTypeLevel(type: string, level: DetectionLevel) {
  seenByTypeAndLevel[type] ??= { UNKNOWN: 0, CONTACT: 0, IDENTIFIED: 0, CONFIRMED: 0 };
  seenByTypeAndLevel[type][level]++;
}

function fail(msg: string) {
  failures.push(msg);
}
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) fail(msg);
}

function auditFormationShape(truth: Formation) {
  // Fails closed: any Formation field not classified above is a leak risk.
  for (const k of Object.keys(truth)) {
    if (!(k in TRUE_AT)) fail(`UNCLASSIFIED FIELD "${k}" on Formation — add it to wirecheck's TRUE_AT contract.`);
  }
}

function auditSnapshot(state: GameState, viewer: PlayerId) {
  const wire = filterStateForPlayer(state, viewer);
  const enemy = otherPlayer(viewer);

  for (const truth of Object.values(state.formations)) {
    if (truth.owner === viewer) {
      ok(!!wire.formations[truth.id], `own formation ${truth.id} missing from own view`);
      continue;
    }
    auditFormationShape(truth);
    const level: DetectionLevel = state.players[viewer].contacts[truth.id]?.level ?? 'UNKNOWN';
    seen[level]++;
    trackTypeLevel(truth.type, level);
    const sent = wire.formations[truth.id];
    const contact = wire.players[viewer].contacts[truth.id];

    switch (level) {
      case 'UNKNOWN':
        ok(!sent, `UNKNOWN enemy ${truth.id} was put on the wire as a formation`);
        ok(!contact, `UNKNOWN enemy ${truth.id} was put on the wire as a contact`);
        break;

      case 'CONTACT':
        ok(!sent, `CONTACT enemy ${truth.id} leaked a formation object (position only is allowed)`);
        ok(!!contact, `CONTACT enemy ${truth.id} has no contact record`);
        if (contact) {
          // The client's icon renderer has nothing to draw an arm silhouette
          // from unless `type` is present — this is the redaction rule that
          // keeps a CONTACT-level blip generic ("?") rather than showing the
          // real arm's icon.
          ok(contact.type === undefined, `CONTACT ${truth.id} leaked its arm (type=${contact.type}) — icon renderer could draw the wrong-rung silhouette from this`);
          ok(
            !JSON.stringify(contact).includes(truth.shortName),
            `CONTACT ${truth.id} leaked its designation in the contact record`
          );
        }
        break;

      case 'IDENTIFIED':
        ok(!!sent, `IDENTIFIED enemy ${truth.id} missing from the wire`);
        if (!sent) break;
        ok(sent.redacted === true, `IDENTIFIED ${truth.id} not flagged redacted`);
        // This IS the arm-icon reveal rule: IDENTIFIED is the lowest rung the
        // client may render a specific arm silhouette at (see render/icons.ts
        // + render/renderMap.ts drawFormation) because it is the lowest rung
        // fog.ts sends a real `type` at all.
        ok(sent.type === truth.type, `IDENTIFIED ${truth.id} should reveal its arm`);
        ok(sent.x === truth.x && sent.y === truth.y, `IDENTIFIED ${truth.id} should reveal its position`);
        // Every CONFIRMED-only field must NOT equal the truth (or must be a sentinel).
        for (const [k, rung] of Object.entries(TRUE_AT) as [keyof Formation, DetectionLevel][]) {
          if (rung !== 'CONFIRMED') continue;
          const sentV = sent[k] as unknown;
          const trueV = truth[k] as unknown;
          if (typeof trueV === 'number') {
            const numericPlaceholder = sentV === REDACTED_NUMBER || sentV === 0;
            ok(
              numericPlaceholder,
              `IDENTIFIED ${truth.id} leaked numeric field "${k}" (sent ${String(sentV)}, true ${String(trueV)})`
            );
          } else if (typeof trueV === 'string') {
            // A placeholder string is allowed; the TRUE value never is, unless
            // the truth happens to equal the fixed placeholder by coincidence.
            const placeholders = ['Unknown', 'Unidentified', 'Composition not yet established.', 'Steady'];
            ok(
              sentV !== trueV || placeholders.includes(String(sentV)) || String(sentV).startsWith('Enemy '),
              `IDENTIFIED ${truth.id} leaked string field "${k}" (${String(sentV)})`
            );
          } else if (typeof trueV === 'boolean') {
            ok(sentV === false, `IDENTIFIED ${truth.id} leaked boolean field "${k}"`);
          }
        }
        // Specifically: the supply field is gone entirely, and ammunition is
        // still redacted now that it is a small integer rather than a percent.
        ok(!('supply' in (sent as object)), `IDENTIFIED ${truth.id} carries a removed "supply" field`);
        ok(sent.ammo === REDACTED_NUMBER, `IDENTIFIED ${truth.id} leaked its ammunition count`);
        break;

      case 'CONFIRMED':
        ok(!!sent, `CONFIRMED enemy ${truth.id} missing from the wire`);
        if (!sent) break;
        ok(sent.strength === truth.strength, `CONFIRMED ${truth.id} should carry the true strength`);
        ok(sent.name === truth.name, `CONFIRMED ${truth.id} should carry the true name`);
        ok(sent.redacted === false, `CONFIRMED ${truth.id} should not be flagged redacted`);
        break;
    }
  }

  // The enemy's own contact table describes what THEY have spotted of US.
  ok(
    Object.keys(wire.players[enemy].contacts).length === 0,
    `viewer ${viewer} was sent the enemy's contact table`
  );
  // The operations log must not narrate the enemy's private orders.
  ok(
    wire.log.every((e) => e.audience === 'ALL' || e.audience === viewer),
    `viewer ${viewer} was sent log entries addressed to the enemy`
  );
  // And no removed field may ride along on the viewer's own formations either.
  for (const own of Object.values(wire.formations)) {
    ok(!('supply' in (own as object)), `formation ${own.id} still carries a "supply" field`);
  }
}

function apply(state: GameState, a: any) {
  switch (a.type) {
    case 'MOVE': engine.moveFormation(state, a.formationId, a.x, a.y); break;
    case 'MOVE_GROUP': engine.moveGroup(state, a.formationIds, a.x, a.y); break;
    case 'ATTACK': engine.attackAction(state, a.attackerId, a.targetId); break;
    case 'RECON': engine.reconAction(state, a.formationId); break;
    case 'FORTIFY': engine.fortifyAction(state, a.formationId); break;
    case 'ARTILLERY': engine.artilleryAction(state, a.formationId, a.x, a.y); break;
    case 'AIR': engine.airStrikeAction(state, a.x, a.y); break;
    case 'SPECIAL_OP': engine.specialOpAction(state, a.formationId, a.x, a.y); break;
    case 'ENGINEER_BRIDGE': engine.engineerBridgeAction(state, a.formationId, a.x, a.y); break;
    case 'ENGINEER_CLEAR': engine.engineerClearAction(state, a.formationId, a.x, a.y); break;
    case 'REORGANIZE': engine.reorganizeAction(state, a.formationId); break;
    case 'VERTICAL_INSERT': engine.verticalInsertAction(state, a.formationId, a.x, a.y); break;
    case 'UAV_RECON': engine.uavReconAction(state, a.x, a.y); break;
    case 'WITHDRAW': engine.withdrawAction(state, a.formationId); break;
  }
}

/**
 * killFeed redaction (phase 7): the same ladder a live formation gets. Your
 * own losses are always full detail; an enemy loss is capped at what your
 * side's contact record for that formation actually established; UNKNOWN is
 * not represented on the wire at all.
 */
function auditKillFeed(state: GameState, viewer: PlayerId) {
  const wire = filterStateForPlayer(state, viewer);
  for (const k of wire.killFeed) {
    if (k.owner === viewer) {
      ok(k.name !== 'Unknown enemy formation', `own kill event ${k.formationId} was redacted`);
      continue;
    }
    const level: DetectionLevel = state.players[viewer].contacts[k.formationId]?.level ?? 'UNKNOWN';
    ok(level !== 'UNKNOWN', `killFeed leaked an event (${k.formationId}) the viewer never detected`);
    if (level === 'CONTACT') {
      ok(k.type === undefined, `CONTACT-level kill event leaked its arm (type=${k.type})`);
      ok(k.name === 'Unknown enemy formation', `CONTACT-level kill event leaked identity (${k.name})`);
    }
    if (level === 'IDENTIFIED') {
      ok(k.type !== undefined, `IDENTIFIED kill event should reveal the arm`);
      ok(!k.name.startsWith(k.shortName) || k.name.startsWith('Enemy'), `IDENTIFIED kill event leaked the true designation (${k.name})`);
    }
  }
  // Every UNKNOWN-to-viewer true kill must be absent from the wire entirely.
  for (const truth of state.killFeed) {
    if (truth.owner === viewer) continue;
    const level: DetectionLevel = state.players[viewer].contacts[truth.formationId]?.level ?? 'UNKNOWN';
    if (level !== 'UNKNOWN') continue;
    ok(!wire.killFeed.some((k) => k.id === truth.id), `killFeed leaked a kill event (${truth.id}) at UNKNOWN detection`);
  }
}

/**
 * Combat-event redaction (phase 12 §5) — the on-map combat-effect readout's
 * only data source. Own-side participant always at its true position;
 * opposing participant's position included only if this viewer's side has
 * actually detected it (see fog.ts `redactCombatEvent`).
 */
function auditCombatEvents(state: GameState, viewer: PlayerId) {
  const wire = filterStateForPlayer(state, viewer);
  for (const ev of wire.combatEvents) {
    const isMineAttacker = ev.attackerOwner === viewer;
    const isMineDefender = ev.defenderOwner === viewer;
    ok(isMineAttacker || isMineDefender, `combat event ${ev.id} sent to a viewer with no stake in it`);
    const truth = state.combatEvents.find((t) => t.id === ev.id);
    if (!truth) continue;
    if (isMineAttacker) {
      ok(ev.attackerX === truth.attackerX && ev.attackerY === truth.attackerY, `own attacker position was redacted on combat event ${ev.id}`);
      const level = state.players[viewer].contacts[truth.defenderId]?.level ?? (state.formations[truth.defenderId]?.owner === viewer ? 'CONFIRMED' : 'UNKNOWN');
      if (level === 'UNKNOWN') {
        ok(ev.defenderX === ev.attackerX && ev.defenderY === ev.attackerY, `combat event ${ev.id} leaked an undetected defender's true position`);
      }
    } else {
      ok(ev.defenderX === truth.defenderX && ev.defenderY === truth.defenderY, `own defender position was redacted on combat event ${ev.id}`);
      const level = state.players[viewer].contacts[truth.attackerId]?.level ?? (state.formations[truth.attackerId]?.owner === viewer ? 'CONFIRMED' : 'UNKNOWN');
      if (level === 'UNKNOWN') {
        ok(ev.attackerX === ev.defenderX && ev.attackerY === ev.defenderY, `combat event ${ev.id} leaked an undetected attacker's true position`);
      }
    }
  }
}

/**
 * Match-replay redaction (phase 9): best-effort, gated by the viewer's FINAL
 * contact rung for each formation id (see fog.ts `redactReplay`). Never a
 * true formation object at IDENTIFIED-or-below, never omitted for the
 * viewer's own formations.
 */
function auditReplay(state: GameState, viewer: PlayerId) {
  const wire = filterStateForPlayer(state, viewer);
  const contacts = state.players[viewer].contacts;
  ok(wire.replay.length === state.replay.length, `replay for ${viewer} dropped whole rounds (${wire.replay.length} of ${state.replay.length})`);
  wire.replay.forEach((round, i) => {
    const truth = state.replay[i];
    for (const truthEntry of truth.entries) {
      const sent = round.entries.find((e) => e.id === truthEntry.id);
      if (truthEntry.owner === viewer) {
        ok(!!sent && sent.strength === truthEntry.strength, `replay round ${round.round} dropped/redacted the viewer's own formation ${truthEntry.id}`);
        continue;
      }
      const level = contacts[truthEntry.id]?.level;
      if (level !== 'IDENTIFIED' && level !== 'CONFIRMED') {
        ok(!sent, `replay round ${round.round} leaked enemy formation ${truthEntry.id} never IDENTIFIED by ${viewer} (final rung ${level ?? 'UNKNOWN'})`);
      } else if (level === 'IDENTIFIED') {
        ok(!!sent && sent.strength === REDACTED_NUMBER, `replay round ${round.round} leaked strength for an IDENTIFIED-only enemy formation ${truthEntry.id}`);
      } else {
        ok(!!sent && sent.strength === truthEntry.strength, `replay round ${round.round} under-revealed a CONFIRMED enemy formation ${truthEntry.id}`);
      }
    }
  });
}

/**
 * Fog-blocked MOVE refusal (the reported bug): a MOVE onto a tile secretly
 * held by an enemy formation the mover's own side has never detected must be
 * refused with a message that, byte-for-byte on the actual serialized wire
 * message the server would send, names nothing about the occupant — no
 * formation name, no arm/type, no "enemy" wording, nothing that distinguishes
 * it from a refusal for any other reason. Builds the EXACT ServerMsg the
 * server sends (server/index.ts's `send(ws, { t: 'error', message })`) and
 * JSON.stringifies it — the same rigor as every other redaction proof in this
 * suite: inspect real wire bytes, not the intent.
 */
function auditMoveRefusalWire() {
  const state = engine.initGame(31415);
  const mover = Object.values(state.formations).find((f) => f.owner === 'SABRE' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  const hidden = Object.values(state.formations).find((f) => f.owner === 'VANGUARD' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  // Place them adjacent on open ground, with SABRE having made no contact on
  // `hidden` whatsoever — the exact bug scenario: the mover's own client-side
  // preview has no way to know this tile is occupied.
  mover.x = 20; mover.y = 20;
  hidden.x = 21; hidden.y = 20;
  state.tiles[mover.y][mover.x] = { ...state.tiles[mover.y][mover.x], terrain: 'GRASS', road: false, bridge: false, elevation: 1 };
  state.tiles[hidden.y][hidden.x] = { ...state.tiles[hidden.y][hidden.x], terrain: 'GRASS', road: false, bridge: false, elevation: 1 };
  state.players.SABRE.contacts = {};
  state.activePlayer = 'SABRE';
  state.players.SABRE.ap = 60;

  const res = engine.moveFormation(state, mover.id, hidden.x, hidden.y);
  ok(!res.ok && res.refusal === 'ENEMY_HELD', 'fog-blocked MOVE setup: refusal is ENEMY_HELD as expected');

  // This is exactly what server/index.ts's `case 'MOVE'` branch of applyAction
  // computes and sends back — mirrored here (not imported: server/index.ts is
  // not import-safe, it opens a real listening socket at module load).
  const message = safeMoveRefusalMessage(state, 'SABRE', res.refusal, res.reason, res.occupantId);
  const wireMsg: ServerMsg = { t: 'error', message };
  const wireBytes = JSON.stringify(wireMsg);

  ok(message === GENERIC_BLOCKED_TILE_MESSAGE, `fog-blocked MOVE refusal uses the exact generic string (got "${message}")`);
  ok(wireBytes === JSON.stringify({ t: 'error', message: 'That tile cannot be entered.' }), `serialized wire message matches byte-for-byte (got ${wireBytes})`);
  ok(!wireBytes.includes(hidden.id), 'wire bytes do not contain the hidden occupant\'s formation id');
  ok(!wireBytes.includes(hidden.shortName), 'wire bytes do not contain the hidden occupant\'s callsign');
  ok(!wireBytes.includes(hidden.name), 'wire bytes do not contain the hidden occupant\'s full name');
  ok(!wireBytes.toLowerCase().includes(hidden.type.toLowerCase()), 'wire bytes do not contain the hidden occupant\'s arm/type');
  ok(!/enemy/i.test(wireBytes), 'wire bytes do not use the word "enemy"');
  ok(!/vanguard/i.test(wireBytes), 'wire bytes do not name the opposing side');
  // And a sibling refusal for ANY other reason must be byte-identical in
  // shape (same message key, same generic-looking sentence) — nothing about
  // this specific error should stand out as "that one's about a hidden
  // enemy" versus, say, "too far" or "no AP", from the client's own vantage.
  const otherState = engine.initGame(31415);
  otherState.players.SABRE.ap = 0;
  const other = Object.values(otherState.formations).find((f) => f.owner === 'SABRE' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  const otherRes = engine.moveFormation(otherState, other.id, other.x + 1, other.y);
  ok(!otherRes.ok, 'sanity: a NO_AP refusal is also refused (unrelated control case)');

  // Regression: a KNOWN (IDENTIFIED+) occupant must still get the real,
  // detailed message — the fix must not swallow the working, already-correct
  // case of a legitimately visible obstacle.
  const known = engine.initGame(31415);
  const kMover = Object.values(known.formations).find((f) => f.owner === 'SABRE' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  const kEnemy = Object.values(known.formations).find((f) => f.owner === 'VANGUARD' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  kMover.x = 22; kMover.y = 22;
  kEnemy.x = 23; kEnemy.y = 22;
  known.activePlayer = 'SABRE';
  known.players.SABRE.ap = 60;
  known.players.SABRE.contacts[kEnemy.id] = {
    formationId: kEnemy.id, owner: 'VANGUARD', level: 'CONFIRMED', confidence: 100, x: kEnemy.x, y: kEnemy.y,
    live: true, lastSeenTurn: known.round, decayAnchorRound: known.round, lastRiseRound: known.round, ceiling: 100, decayPerRound: 20, source: 'test',
  };
  const kRes = engine.moveFormation(known, kMover.id, kEnemy.x, kEnemy.y);
  const kMessage = safeMoveRefusalMessage(known, 'SABRE', kRes.refusal, kRes.reason, kRes.occupantId);
  ok(kRes.refusal === 'ENEMY_HELD', 'known-occupant setup: refusal is ENEMY_HELD as expected');
  ok(kMessage !== GENERIC_BLOCKED_TILE_MESSAGE, `a CONFIRMED occupant's refusal is NOT downgraded to the generic string (got "${kMessage}")`);
  ok(kMessage === kRes.reason, 'a CONFIRMED occupant gets the engine\'s own detailed refusal message, unchanged');
}
auditMoveRefusalWire();

/**
 * Fog-blocked VERTICAL_INSERT refusal — the same bug shape as MOVE's
 * ENEMY_HELD, found while auditing every other action handler for it (Task
 * 1 of the follow-up pass): verticalInsertLandingLegal's "already occupied"
 * check reads `formationAt`, the TRUE board, not a fog-filtered one, so a
 * landing zone that happens to sit exactly on an enemy formation this side
 * has never detected must be refused with a message that reveals nothing
 * more than "something is different about that tile" — same as MOVE.
 */
function auditVerticalInsertRefusalWire() {
  const state = engine.initGame(20260904);
  const mover = Object.values(state.formations).find((f) => f.owner === 'SABRE' && f.type === 'COMMANDO')!;
  const hidden = Object.values(state.formations).find((f) => f.owner === 'VANGUARD' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  mover.x = 20; mover.y = 20;
  hidden.x = 22; hidden.y = 20; // within VERTICAL_INSERT_RADIUS, not adjacent (so only the occupancy check trips)
  state.tiles[mover.y][mover.x] = { ...state.tiles[mover.y][mover.x], terrain: 'GRASS', road: false, bridge: false, elevation: 1 };
  state.tiles[hidden.y][hidden.x] = { ...state.tiles[hidden.y][hidden.x], terrain: 'GRASS', road: false, bridge: false, elevation: 1 };
  state.players.SABRE.contacts = {};
  state.activePlayer = 'SABRE';
  state.players.SABRE.ap = 60;

  const legal = engine.verticalInsertLandingLegal(state, mover, hidden.x, hidden.y);
  ok(!legal.ok && legal.occupantId === hidden.id, 'fog-blocked VERTICAL_INSERT setup: refused with the true occupant id');

  const res = engine.verticalInsertAction(state, mover.id, hidden.x, hidden.y);
  ok(!res.ok && res.occupantId === hidden.id, 'verticalInsertAction propagates the ground-truth occupantId on refusal');

  // This is exactly what server/index.ts's `case 'VERTICAL_INSERT'` branch of
  // applyAction computes and sends back.
  const message = safeOccupantRefusalMessage(state, 'SABRE', res.occupantId, res.reason);
  const wireMsg: ServerMsg = { t: 'error', message };
  const wireBytes = JSON.stringify(wireMsg);

  ok(message === GENERIC_BLOCKED_LANDING_MESSAGE, `fog-blocked VERTICAL_INSERT refusal uses the generic string (got "${message}")`);
  ok(!wireBytes.includes(hidden.id), 'wire bytes do not contain the hidden occupant\'s formation id');
  ok(!wireBytes.includes(hidden.shortName), 'wire bytes do not contain the hidden occupant\'s callsign');
  ok(!wireBytes.includes(hidden.name), 'wire bytes do not contain the hidden occupant\'s full name');
  ok(!wireBytes.toLowerCase().includes(hidden.type.toLowerCase()), 'wire bytes do not contain the hidden occupant\'s arm/type');
  ok(!/vanguard/i.test(wireBytes), 'wire bytes do not name the opposing side');
  ok(mover.x === 20 && mover.y === 20, 'a refused vertical insertion does not relocate the formation');
  ok(mover.verticalInsertsUsed === 0, 'a refused vertical insertion does not spend a use');

  // Regression: a KNOWN (IDENTIFIED+) occupant still gets the real message.
  const known = engine.initGame(20260904);
  const kMover = Object.values(known.formations).find((f) => f.owner === 'SABRE' && f.type === 'COMMANDO')!;
  const kEnemy = Object.values(known.formations).find((f) => f.owner === 'VANGUARD' && f.type !== 'FRIGATE' && f.type !== 'CORVETTE')!;
  kMover.x = 30; kMover.y = 30;
  kEnemy.x = 32; kEnemy.y = 30;
  known.activePlayer = 'SABRE';
  known.players.SABRE.ap = 60;
  known.players.SABRE.contacts[kEnemy.id] = {
    formationId: kEnemy.id, owner: 'VANGUARD', level: 'CONFIRMED', confidence: 100, x: kEnemy.x, y: kEnemy.y,
    live: true, lastSeenTurn: known.round, decayAnchorRound: known.round, lastRiseRound: known.round, ceiling: 100, decayPerRound: 20, source: 'test',
  };
  const kRes = engine.verticalInsertAction(known, kMover.id, kEnemy.x, kEnemy.y);
  const kMessage = safeOccupantRefusalMessage(known, 'SABRE', kRes.occupantId, kRes.reason);
  ok(!kRes.ok && kRes.occupantId === kEnemy.id, 'known-occupant setup: refused with the true occupant id');
  ok(kMessage !== GENERIC_BLOCKED_LANDING_MESSAGE, `a CONFIRMED occupant's refusal is NOT downgraded to the generic string (got "${kMessage}")`);
  ok(kMessage === kRes.reason, 'a CONFIRMED occupant gets the engine\'s own detailed refusal message, unchanged');
}
auditVerticalInsertRefusalWire();

const GAMES = Number(process.argv[2] ?? 6);
const ROUNDS = Number(process.argv[3] ?? 10);
for (let g = 0; g < GAMES; g++) {
  const state = engine.initGame(9100 + g);
  for (let turn = 0; turn < ROUNDS * 2 && state.phase !== 'GAME_OVER'; turn++) {
    const side = state.activePlayer;
    for (let step = 0; step < 40; step++) {
      const a = decideBotAction(state, side, 'HARD');
      if (!a) break;
      apply(state, a);
      // Audit after EVERY accepted action — the wire is pushed that often.
      auditSnapshot(state, 'SABRE');
      auditSnapshot(state, 'VANGUARD');
      auditKillFeed(state, 'SABRE');
      auditKillFeed(state, 'VANGUARD');
      auditCombatEvents(state, 'SABRE');
      auditCombatEvents(state, 'VANGUARD');
    }
    engine.endTurn(state);
    engine.beginPlayerTurn(state);
    auditSnapshot(state, 'SABRE');
    auditSnapshot(state, 'VANGUARD');
    auditKillFeed(state, 'SABRE');
    auditKillFeed(state, 'VANGUARD');
  }
  auditReplay(state, 'SABRE');
  auditReplay(state, 'VANGUARD');
}

console.log(`wirecheck: ${checks} assertions over ${GAMES} games`);
console.log(`rungs exercised — UNKNOWN ${seen.UNKNOWN}, CONTACT ${seen.CONTACT}, IDENTIFIED ${seen.IDENTIFIED}, CONFIRMED ${seen.CONFIRMED}`);
const rungsMissing = (Object.keys(seen) as DetectionLevel[]).filter((k) => seen[k] === 0);
if (rungsMissing.length) {
  console.error(`FAIL: these detection rungs were never exercised: ${rungsMissing.join(', ')}`);
  process.exit(1);
}

// Phase 8 icon-redaction coverage: every arm — ARMOUR included, now fielded
// twice a side via 48 SAR / 42 SAR — must have actually been exercised at
// both CONTACT (icon must NOT appear) and IDENTIFIED (icon MUST appear) at
// least once, or the assertions above proved nothing about this arm.
const armTypesMissingCoverage: string[] = [];
for (const [type, byLevel] of Object.entries(seenByTypeAndLevel)) {
  if (byLevel.CONTACT === 0 || byLevel.IDENTIFIED === 0) armTypesMissingCoverage.push(`${type} (CONTACT=${byLevel.CONTACT}, IDENTIFIED=${byLevel.IDENTIFIED})`);
}
console.log('per-arm rung coverage — ' + Object.entries(seenByTypeAndLevel).map(([t, l]) => `${t}[C=${l.CONTACT},I=${l.IDENTIFIED},X=${l.CONFIRMED}]`).join(' '));
if (armTypesMissingCoverage.length) {
  console.error(`FAIL: these arms never had both CONTACT and IDENTIFIED exercised, so the icon-reveal rule is unproven for them: ${armTypesMissingCoverage.join(', ')}`);
  process.exit(1);
}
if (failures.length) {
  const uniq = [...new Set(failures)];
  console.error(`FAIL: ${failures.length} redaction violations (${uniq.length} distinct)`);
  uniq.slice(0, 20).forEach((f) => console.error('  ' + f));
  process.exit(1);
}
console.log('PASS: fog redaction holds at all four rungs.');
