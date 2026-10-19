import React from 'react';
import { AP_COSTS, GameState, PlayerId, otherPlayer } from '../game/types';
import { FACTION_SHORT } from '../game/data';

export const TopBar: React.FC<{
  state: GameState;
  you: PlayerId;
  objectivesHeld: number;
  objectivesTotal: number;
  uavArmed?: boolean;
  onUav?: () => void;
  onLeave?: () => void;
}> = ({ state, you, objectivesHeld, objectivesTotal, uavArmed, onUav, onLeave }) => {
  const mine = state.players[you];
  const myTurn = state.activePlayer === you;
  return (
    <div className="hud-top">
      <div className="hud-group">
        <span className="wordmark">COMMAND</span>
        <span className="hud-sep" />
        <span className="hud-stat" title={`Round ${state.round} of a ${state.rules.roundLimit}-round CEILING — the match ends sooner if either side reaches ${state.rules.vpToWin} VP first.`}>
          <i>ROUND · MAX {state.rules.roundLimit}</i>
          <b>
            {state.round}
            <small>/{state.rules.roundLimit}</small>
          </b>
        </span>
        <span className={`turn-chip ${myTurn ? 'turn-active' : ''}`}>
          {myTurn ? 'YOUR TURN' : `${FACTION_SHORT[state.activePlayer]} MOVING`}
        </span>
        <span className={`player-chip ${you.toLowerCase()}`} data-testid="you-chip">
          {FACTION_SHORT[you]}
        </span>
      </div>
      <div className="hud-group">
        <span className="hud-stat">
          <i>AP</i>
          <b className="ap-value">
            {mine.ap}
            <small>/{state.rules.apCap}</small>
          </b>
        </span>
        <span className="hud-stat">
          <i>SORTIES</i>
          <b>{mine.airSorties}</b>
        </span>
        <span className="hud-stat">
          <i>OBJECTIVES</i>
          <b>
            {objectivesHeld}
            <small>/{objectivesTotal}</small>
          </b>
        </span>
        <span className="hud-stat vp" data-testid="vp-meter">
          <i>VP — MATCH ENDS AT {state.rules.vpToWin}</i>
          <b title={`${FACTION_SHORT[you]} : ${FACTION_SHORT[otherPlayer(you)]}`}>
            <span className={you === 'SABRE' ? 'vp-blue' : 'vp-red'}>{state.players[you].vp}</span>
            <small> : </small>
            <span className={you === 'SABRE' ? 'vp-red' : 'vp-blue'}>{state.players[otherPlayer(you)].vp}</span>
          </b>
          <span className="vp-bars" aria-hidden="true">
            <span className="vp-bar-track">
              <span
                className={`vp-bar-fill ${you === 'SABRE' ? 'vp-blue-bg' : 'vp-red-bg'}`}
                style={{ width: `${Math.min(100, (state.players[you].vp / state.rules.vpToWin) * 100)}%` }}
              />
            </span>
            <span className="vp-bar-track">
              <span
                className={`vp-bar-fill ${you === 'SABRE' ? 'vp-red-bg' : 'vp-blue-bg'}`}
                style={{ width: `${Math.min(100, (state.players[otherPlayer(you)].vp / state.rules.vpToWin) * 100)}%` }}
              />
            </span>
          </span>
        </span>
        {onUav && (
          <button
            className={`uav-btn ${uavArmed ? 'armed' : ''}`}
            data-testid="uav-btn"
            title={`UAV recon sweep — reveals a radius anywhere on the map for a round. ${AP_COSTS.UAV_RECON} AP per sortie. Press U.`}
            onClick={onUav}
            disabled={state.players[you].uavCharges <= 0 || state.activePlayer !== you}
          >
            <i>UAV</i>
            <b data-testid="uav-charges">{state.players[you].uavCharges}</b>
          </button>
        )}
        {onLeave && (
          <button
            className="btn-ghost small"
            data-testid="leave-match-btn"
            title="Leave this match and return to the lobby. The other side is notified and the room is closed — this cannot be undone."
            onClick={() => {
              if (window.confirm('Leave this match? The other side will be notified and the room will close. This cannot be undone.')) {
                onLeave();
              }
            }}
          >
            Leave
          </button>
        )}
      </div>
    </div>
  );
};
