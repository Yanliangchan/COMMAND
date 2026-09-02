// ============================================================================
// COMMAND — Server-authoritative fog-of-war filtering.
// Pure TypeScript, no DOM/React/canvas dependencies — safe to import from
// both the browser client and the Node WebSocket server.
//
// Given the true, authoritative GameState held by the server, produce the
// redacted view that a given player is allowed to see: their own formations
// in full, plus any enemy formation that is *currently* (this refresh) under
// live visual contact. Enemy formations that are only known via a decaying
// "suspected contact" are NOT included as formation objects — the client
// already renders those via the dashed "?" contact markers using the
// per-player `contacts` map (last-known position/type only, no live stats).
// This guarantees true enemy positions/stats for hidden units never cross
// the wire.
// ============================================================================

import { GameState, PlayerId, otherPlayer } from './types';

/** True only for a contact refreshed on this exact round via direct sighting. */
function isLiveContact(state: GameState, viewer: PlayerId, formationId: string): boolean {
  const c = state.players[viewer].contacts[formationId];
  return !!c && c.confidence >= 100 && c.lastSeenTurn === state.round;
}

/**
 * Redact `state` down to what `viewer` is permitted to know:
 *  - all of the viewer's own formations, untouched
 *  - enemy formations currently under live visual contact
 *  - the viewer's own contact table (suspected-contact markers)
 *  - the enemy player's contact table zeroed out (it describes what the
 *    enemy has spotted of the viewer — none of the viewer's business)
 */
export function filterStateForPlayer(state: GameState, viewer: PlayerId): GameState {
  const enemy = otherPlayer(viewer);
  const formations: GameState['formations'] = {};

  Object.values(state.formations).forEach((f) => {
    if (f.owner === viewer) {
      formations[f.id] = f;
    } else if (isLiveContact(state, viewer, f.id)) {
      formations[f.id] = f;
    }
    // else: hidden entirely — only a stale "contacts" ghost marker remains.
  });

  return {
    ...state,
    formations,
    players: {
      ...state.players,
      [enemy]: { ...state.players[enemy], contacts: {} },
    },
  };
}
