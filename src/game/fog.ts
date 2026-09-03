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
import { Contact, DetectionLevel, Formation, GameState, KillEvent, PlayerId, otherPlayer } from './types';

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

  return {
    ...state,
    // The operations log narrates orders. Only entries addressed to this
    // viewer (or genuinely public ones) go out — otherwise the log would
    // describe every enemy move in plain English regardless of detection.
    log: state.log.filter((e) => e.audience === 'ALL' || e.audience === viewer),
    formations,
    killFeed,
    players: {
      ...state.players,
      [viewer]: { ...state.players[viewer], contacts },
      [enemy]: { ...state.players[enemy], contacts: {} },
    },
  };
}
