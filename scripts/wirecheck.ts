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
  // Phase 7 additions — same tier as the other battlefield-condition fields.
  onAlert: 'CONFIRMED',
  reactionFired: 'CONFIRMED',
  suppression: 'CONFIRMED',
  lastSuppressedRound: 'CONFIRMED',
  lastReorganizedRound: 'CONFIRMED',
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
    }
    engine.endTurn(state);
    engine.beginPlayerTurn(state);
    auditSnapshot(state, 'SABRE');
    auditSnapshot(state, 'VANGUARD');
    auditKillFeed(state, 'SABRE');
    auditKillFeed(state, 'VANGUARD');
  }
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
