import { useCallback, useMemo, useReducer } from 'react';
import * as engine from './engine';
import { GameState } from './types';

export type Action =
  | { type: 'MOVE'; formationId: string; x: number; y: number }
  | { type: 'ATTACK'; attackerId: string; targetId: string }
  | { type: 'RECON'; formationId: string }
  | { type: 'FORTIFY'; formationId: string }
  | { type: 'RESUPPLY'; formationId: string }
  | { type: 'ENGINEER_BRIDGE'; formationId: string; x: number; y: number }
  | { type: 'ENGINEER_CLEAR'; formationId: string; x: number; y: number }
  | { type: 'ARTILLERY'; formationId: string; x: number; y: number }
  | { type: 'AIR'; x: number; y: number }
  | { type: 'SPECIAL_OP'; formationId: string; x: number; y: number }
  | { type: 'AMPHIBIOUS'; transportId: string; cargoId: string; x: number; y: number }
  | { type: 'END_TURN' }
  | { type: 'BEGIN_PLAYER_TURN' }
  | { type: 'RESET'; seed?: number };

function clone(state: GameState): GameState {
  return structuredClone(state);
}

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'MOVE':
      return engine.moveFormation(clone(state), action.formationId, action.x, action.y);
    case 'ATTACK':
      return engine.attackAction(clone(state), action.attackerId, action.targetId);
    case 'RECON':
      return engine.reconAction(clone(state), action.formationId);
    case 'FORTIFY':
      return engine.fortifyAction(clone(state), action.formationId);
    case 'RESUPPLY':
      return engine.resupplyAction(clone(state), action.formationId);
    case 'ENGINEER_BRIDGE':
      return engine.engineerBridgeAction(clone(state), action.formationId, action.x, action.y);
    case 'ENGINEER_CLEAR':
      return engine.engineerClearAction(clone(state), action.formationId, action.x, action.y);
    case 'ARTILLERY':
      return engine.artilleryAction(clone(state), action.formationId, action.x, action.y);
    case 'AIR':
      return engine.airStrikeAction(clone(state), action.x, action.y);
    case 'SPECIAL_OP':
      return engine.specialOpAction(clone(state), action.formationId, action.x, action.y);
    case 'AMPHIBIOUS':
      return engine.amphibiousAction(clone(state), action.transportId, action.cargoId, action.x, action.y);
    case 'END_TURN':
      return engine.endTurn(clone(state));
    case 'BEGIN_PLAYER_TURN':
      return engine.beginPlayerTurn(clone(state));
    case 'RESET':
      return engine.initGame(action.seed ?? Date.now());
    default:
      return state;
  }
}

export function useGameStore(seed?: number) {
  const [state, dispatch] = useReducer(reducer, undefined, () => engine.initGame(seed ?? 1337));
  const actions = useMemo(
    () => ({
      move: (formationId: string, x: number, y: number) => dispatch({ type: 'MOVE', formationId, x, y }),
      attack: (attackerId: string, targetId: string) => dispatch({ type: 'ATTACK', attackerId, targetId }),
      recon: (formationId: string) => dispatch({ type: 'RECON', formationId }),
      fortify: (formationId: string) => dispatch({ type: 'FORTIFY', formationId }),
      resupply: (formationId: string) => dispatch({ type: 'RESUPPLY', formationId }),
      engineerBridge: (formationId: string, x: number, y: number) => dispatch({ type: 'ENGINEER_BRIDGE', formationId, x, y }),
      engineerClear: (formationId: string, x: number, y: number) => dispatch({ type: 'ENGINEER_CLEAR', formationId, x, y }),
      artillery: (formationId: string, x: number, y: number) => dispatch({ type: 'ARTILLERY', formationId, x, y }),
      air: (x: number, y: number) => dispatch({ type: 'AIR', x, y }),
      specialOp: (formationId: string, x: number, y: number) => dispatch({ type: 'SPECIAL_OP', formationId, x, y }),
      amphibious: (transportId: string, cargoId: string, x: number, y: number) => dispatch({ type: 'AMPHIBIOUS', transportId, cargoId, x, y }),
      endTurn: () => dispatch({ type: 'END_TURN' }),
      beginPlayerTurn: () => dispatch({ type: 'BEGIN_PLAYER_TURN' }),
      reset: (seed?: number) => dispatch({ type: 'RESET', seed }),
    }),
    []
  );
  return { state, actions };
}
