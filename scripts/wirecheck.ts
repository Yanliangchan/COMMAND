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
import { filterStateForPlayer, REDACTED_NUMBER } from '../src/game/fog';
import { decideBotAction } from '../server/bot';
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
};

const failures: string[] = [];
let checks = 0;
const seen: Record<DetectionLevel, number> = { UNKNOWN: 0, CONTACT: 0, IDENTIFIED: 0, CONFIRMED: 0 };

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
          ok(contact.type === undefined, `CONTACT ${truth.id} leaked its arm (type=${contact.type})`);
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
  }
}

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
    }
    engine.endTurn(state);
    engine.beginPlayerTurn(state);
    auditSnapshot(state, 'SABRE');
    auditSnapshot(state, 'VANGUARD');
  }
}

console.log(`wirecheck: ${checks} assertions over ${GAMES} games`);
console.log(`rungs exercised — UNKNOWN ${seen.UNKNOWN}, CONTACT ${seen.CONTACT}, IDENTIFIED ${seen.IDENTIFIED}, CONFIRMED ${seen.CONFIRMED}`);
const rungsMissing = (Object.keys(seen) as DetectionLevel[]).filter((k) => seen[k] === 0);
if (rungsMissing.length) {
  console.error(`FAIL: these detection rungs were never exercised: ${rungsMissing.join(', ')}`);
  process.exit(1);
}
if (failures.length) {
  const uniq = [...new Set(failures)];
  console.error(`FAIL: ${failures.length} redaction violations (${uniq.length} distinct)`);
  uniq.slice(0, 20).forEach((f) => console.error('  ' + f));
  process.exit(1);
}
console.log('PASS: fog redaction holds at all four rungs.');
