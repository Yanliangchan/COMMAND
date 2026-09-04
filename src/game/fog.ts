// ============================================================================
// COMMAND — Server-authoritative fog-of-war filtering.
//
// Pure TypeScript, no DOM/React/canvas dependencies — safe to import from both
// the browser client and the Node WebSocket server.
//
// This module is the ONLY place that decides what crosses the wire, and after
// phase 4b it redacts by DETECTION LEVEL rather than by a yes/no visibility
// flag. Given the true, authoritative GameState the server holds, each rung of
// the ladder is allowed to reveal strictly more:
//
//   UNKNOWN     the enemy formation is absent from the payload entirely, and
//               there is no contact record either. The client is not told the
//               unit exists.
//   CONTACT     a contact record only: position, confidence, level. NO type,
//               NO strength, NO name, NO formation object. "Something is at
//               F-42" is the whole of what is sent.
//   IDENTIFIED  a REDACTED formation object: id, owner, type, position — and
//               generic identity strings plus -1 sentinels in every numeric
//               field. The true title, strength, morale, ammunition,
//               readiness, orders and equipment never leave the server.
//   CONFIRMED   the real formation object, untouched.
//
// The redaction is done by constructing a fresh object from an explicit field
// list, never by deleting fields from a spread of the real one — a future field
// added to Formation therefore fails closed (absent) rather than leaking.
// ============================================================================

import { FORMATION_DEFS } from './data';
import { MoveRefusal } from './movement';
import { CombatEvent, Contact, DetectionLevel, Formation, GameState, KillEvent, PlayerId, ReplayRound, otherPlayer } from './types';

/** Two-letter designation shown on a redacted counter, by arm. */
const GENERIC_SHORT: Record<Formation['type'], string> = {
  INFANTRY: 'INF',
  COMMANDO: 'CDO',
  GUARDS: 'GDS',
  ARMOUR: 'ARM',
  ARTILLERY: 'ARTY',
  ENGINEER: 'ENGR',
  RECON: 'ISR',
  FRIGATE: 'FFG',
  CORVETTE: 'PC',
};

/** Sentinel written into every numeric field a viewer has not earned. */
export const REDACTED_NUMBER = -1;

/**
 * Build the object an IDENTIFIED-rung viewer is allowed to receive. Everything
 * is stated positively; nothing is copied wholesale from the real formation.
 */
function redactIdentified(f: Formation): Formation {
  const def = FORMATION_DEFS[f.type];
  return {
    id: f.id,
    owner: f.owner,
    type: f.type, // the arm IS what "identified" means
    name: `Enemy ${def.label}`,
    shortName: GENERIC_SHORT[f.type],
    echelon: 'Unknown',
    arm: 'Unidentified',
    equipment: 'Composition not yet established.',
    x: f.x,
    y: f.y,
    strength: REDACTED_NUMBER,
    morale: 'Steady', // fixed placeholder — never the real band; UI shows "—"
    moraleValue: REDACTED_NUMBER,
    moraleBaseline: REDACTED_NUMBER,
    lastEngagedRound: 0,
    readiness: REDACTED_NUMBER,
    ammo: REDACTED_NUMBER,
    lastFiredRound: 0,
    movesUsed: 0,
    movesMax: 0,
    hasActedThisTurn: false,
    fortified: false, // whether they are dug in is intelligence too
    lastOrder: 'Unknown',
    // Phase 7 fields — all intelligence, withheld until CONFIRMED just like
    // strength, morale and readiness. An on-alert enemy is not revealed as
    // such at this rung: you find out the hard way, or you confirm it first.
    onAlert: false,
    reactionFired: false,
    suppression: REDACTED_NUMBER,
    lastSuppressedRound: 0,
    lastReorganizedRound: 0,
    // Phase 9 fields — same tier as everything else above: intelligence,
    // withheld until CONFIRMED.
    fortifyTier: REDACTED_NUMBER,
    fortifiedThisRound: false,
    verticalInsertsUsed: REDACTED_NUMBER,
    // Last stand (phase 11 §5) — same tier as fortifyTier: withheld until CONFIRMED.
    lastStandTriggered: false,
    lastStandUntilRound: REDACTED_NUMBER,
    // Concealment-from-stasis (phase 12 §3) is intelligence like everything
    // else here — whether an enemy has been sitting still is withheld until
    // CONFIRMED, same as fortifyTier.
    roundsStationary: REDACTED_NUMBER,
    intel: 'IDENTIFIED',
    redacted: true,
  };
}

/** A CONFIRMED enemy is sent as-is, tagged so the UI can label the rung. */
function markConfirmed(f: Formation): Formation {
  return { ...f, intel: 'CONFIRMED', redacted: false };
}

/**
 * The contact record a viewer may hold. At CONTACT rung the arm and the
 * observing unit's identity are stripped: the player is told a position and a
 * confidence, nothing else.
 */
function redactContact(c: Contact): Contact {
  if (c.level === 'CONTACT') {
    return {
      formationId: c.formationId,
      owner: c.owner,
      level: c.level,
      confidence: c.confidence,
      x: c.x,
      y: c.y,
      live: c.live,
      lastSeenTurn: c.lastSeenTurn,
      decayAnchorRound: c.decayAnchorRound,
      lastRiseRound: c.lastRiseRound,
      ceiling: c.ceiling,
      decayPerRound: c.decayPerRound,
      spottedBy: c.spottedBy,
      source: c.source,
      // type deliberately omitted.
    };
  }
  return c;
}

export function contactLevel(state: GameState, viewer: PlayerId, formationId: string): DetectionLevel {
  return state.players[viewer].contacts[formationId]?.level ?? 'UNKNOWN';
}

/** Generic, uninformative refusal text for a MOVE blocked by a tile the mover has no legitimate knowledge of. */
export const GENERIC_BLOCKED_TILE_MESSAGE = 'That tile cannot be entered.';

/**
 * Decide what is SAFE to tell a player whose MOVE was refused because the
 * destination is ENEMY_HELD (occupied by a formation belonging to the other
 * side — see MovePlan.occupantId in movement.ts and MoveActionResult in
 * engine.ts). A refused move necessarily tells the mover *something* is
 * different about that tile — an accepted, unavoidable one-bit signal in any
 * fog-of-war game — but it must never say more than that unless the mover's
 * own side has actually detected the occupant at IDENTIFIED-or-better,
 * exactly the same rung every other piece of intelligence on the wire is
 * gated at. Lives in fog.ts (rather than server/index.ts, which is not
 * import-safe for a test harness — it listens on a real socket at module
 * load) specifically so wirecheck.ts can exercise the exact function the
 * server calls, not a re-implementation of it.
 *
 * Every other refusal code (terrain, ZOC, too far, no AP, no movement
 * actions, OCCUPIED by a friendly formation, …) reveals nothing about enemy
 * positions and is safe to relay verbatim — this function is a no-op for all
 * of them.
 */
export function safeMoveRefusalMessage(
  state: GameState,
  mover: PlayerId,
  refusal: MoveRefusal | null,
  reason: string,
  occupantId: string | null
): string {
  if (refusal !== 'ENEMY_HELD') return reason;
  const level = occupantId ? contactLevel(state, mover, occupantId) : 'UNKNOWN';
  if (level === 'IDENTIFIED' || level === 'CONFIRMED') return reason;
  return GENERIC_BLOCKED_TILE_MESSAGE;
}

/**
 * Redact one kill-feed entry (phase 7) for `viewer`, mirroring the live
 * formation rules exactly: your own losses are always yours in full; an
 * enemy loss is capped at whatever your side's CONTACT record for that
 * formation had actually established — a destroyed formation's contact ages
 * out normally rather than being deleted, so this reads the same ladder a
 * live formation would. UNKNOWN is not represented on the wire at all.
 */
function redactKillEvent(state: GameState, viewer: PlayerId, k: KillEvent): KillEvent | null {
  if (k.owner === viewer) return k;
  const level = contactLevel(state, viewer, k.formationId);
  if (level === 'CONFIRMED') return k;
  if (level === 'IDENTIFIED') {
    return { ...k, type: k.type, name: `Enemy ${FORMATION_DEFS[k.type ?? 'INFANTRY'].label}`, shortName: GENERIC_SHORT[k.type ?? 'INFANTRY'] };
  }
  if (level === 'CONTACT') {
    return { ...k, type: undefined, name: 'Unknown enemy formation', shortName: '???' };
  }
  return null;
}

/**
 * Redact one resolved-engagement record (phase 12 §5) for `viewer` — the
 * on-map combat-effect readout's ONLY data source, so this is the whole of
 * its fog-of-war audit. In a 2-player game every engagement necessarily
 * involves both sides (there is no third party), so `viewer` is always
 * either the attacker's or the defender's owner — but that alone does not
 * license including the OTHER participant's position: the viewer's own
 * formation is always at its true position (they are obviously present at
 * their own tile), while the opposing participant's position is included
 * only if this viewer's side has actually detected it — otherwise it is
 * collapsed onto the viewer's own tile, so the client can still render an
 * "engaged here" impact effect without ever being handed an undetected
 * shooter's or target's true position.
 */
function redactCombatEvent(state: GameState, viewer: PlayerId, ev: CombatEvent): CombatEvent {
  const isMineAttacker = ev.attackerOwner === viewer;
  const otherId = isMineAttacker ? ev.defenderId : ev.attackerId;
  const otherOwnFormation = state.formations[otherId]?.owner === viewer;
  const otherDetected = otherOwnFormation || contactLevel(state, viewer, otherId) !== 'UNKNOWN';
  if (otherDetected) return ev;
  return isMineAttacker
    ? { ...ev, defenderX: ev.attackerX, defenderY: ev.attackerY }
    : { ...ev, attackerX: ev.defenderX, attackerY: ev.defenderY };
}

/**
 * Redact the match-replay snapshots (phase 9) for `viewer`. Best-effort, by
 * design (see README "Match replay"): rather than reconstructing what the
 * viewer's detection actually was AT EACH PAST ROUND (which the engine does
 * not record), an enemy formation is shown in ANY round of the replay only
 * if the viewer's CURRENT, final contact for it reached IDENTIFIED or
 * better — the same "have you ever legitimately earned this" gate fog.ts
 * uses everywhere else, just evaluated once at the end of the game rather
 * than per round. A formation the viewer never got that far on (or whose
 * contact aged out entirely) is omitted from every round of the replay,
 * never shown with numbers it did not earn.
 */
function redactReplay(state: GameState, viewer: PlayerId): ReplayRound[] {
  const contacts = state.players[viewer].contacts;
  return state.replay.map((r) => ({
    round: r.round,
    entries: r.entries
      .filter((e) => e.owner === viewer || (contacts[e.id]?.level === 'IDENTIFIED' || contacts[e.id]?.level === 'CONFIRMED'))
      .map((e) => {
        if (e.owner === viewer) return e;
        const level = contacts[e.id]?.level;
        if (level === 'CONFIRMED') return e;
        // IDENTIFIED — arm and position only, strength withheld like a live redacted formation.
        return { ...e, shortName: GENERIC_SHORT[e.type], strength: REDACTED_NUMBER };
      }),
  }));
}

/**
 * Redact `state` down to what `viewer` is permitted to know:
 *  - all of the viewer's own formations, untouched
 *  - CONFIRMED enemy formations in full
 *  - IDENTIFIED enemy formations as a redacted stand-in
 *  - CONTACT enemies as a position-only contact record and nothing else
 *  - UNKNOWN enemies not represented at all
 *  - the enemy player's own contact table zeroed out (it describes what the
 *    enemy has spotted of the viewer — none of the viewer's business)
 */
export function filterStateForPlayer(state: GameState, viewer: PlayerId): GameState {
  const enemy = otherPlayer(viewer);
  const formations: GameState['formations'] = {};

  Object.values(state.formations).forEach((f) => {
    if (f.owner === viewer) {
      formations[f.id] = f;
      return;
    }
    switch (contactLevel(state, viewer, f.id)) {
      case 'CONFIRMED':
        formations[f.id] = markConfirmed(f);
        break;
      case 'IDENTIFIED':
        formations[f.id] = redactIdentified(f);
        break;
      default:
        // CONTACT and UNKNOWN put no formation object on the wire at all.
        break;
    }
  });

  const contacts: Record<string, Contact> = {};
  Object.values(state.players[viewer].contacts).forEach((c) => {
    contacts[c.formationId] = redactContact(c);
  });

  const killFeed = state.killFeed
    .map((k) => redactKillEvent(state, viewer, k))
    .filter((k): k is KillEvent => k !== null);

  const combatEvents = state.combatEvents.map((ev) => redactCombatEvent(state, viewer, ev));

  return {
    ...state,
    // The operations log narrates orders. Only entries addressed to this
    // viewer (or genuinely public ones) go out — otherwise the log would
    // describe every enemy move in plain English regardless of detection.
    log: state.log.filter((e) => e.audience === 'ALL' || e.audience === viewer),
    formations,
    killFeed,
    combatEvents,
    replay: redactReplay(state, viewer),
    players: {
      ...state.players,
      [viewer]: { ...state.players[viewer], contacts },
      [enemy]: { ...state.players[enemy], contacts: {} },
    },
  };
}

/**
 * SPECTATOR VIEW (phase 11 §3). A spectator is not a combatant on either
 * side, so there is nothing to redact FROM — both sides are shown in full,
 * every formation CONFIRMED, the whole log, and both players' contact
 * tables (spectators can watch each side's detection picture, since neither
 * one is theirs to keep secret from a non-participant). Still goes through
 * this module rather than handing the raw state out ad-hoc, so the "what
 * crosses the wire" decision always lives in one place: this is a
 * deliberate, explicit, fully-open case, not a bypass.
 */
export function filterStateForSpectator(state: GameState): GameState {
  const formations: GameState['formations'] = {};
  Object.values(state.formations).forEach((f) => {
    formations[f.id] = markConfirmed(f);
  });
  return {
    ...state,
    log: state.log,
    formations,
    killFeed: state.killFeed,
    replay: state.replay,
    players: state.players,
  };
}
