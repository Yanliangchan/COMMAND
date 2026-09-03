import React from 'react';
import { AP_CAP, MAX_ROUNDS, GameState, PlayerId, VP_WIN_THRESHOLD, otherPlayer } from '../game/types';
import { FACTION_SHORT } from '../game/data';

export const TopBar: React.FC<{ state: GameState; you: PlayerId; objectivesHeld: number; objectivesTotal: number }> = ({
  state,
  you,
  objectivesHeld,
  objectivesTotal,
}) => {
  const mine = state.players[you];
  const myTurn = state.activePlayer === you;
  return (
    <div className="hud-top">
      <div className="hud-group">
        <span className="wordmark">COMMAND</span>
        <span className="hud-sep" />
        <span className="hud-stat">
          <i>ROUND</i>
          <b>
            {state.round}
            <small>/{MAX_ROUNDS}</small>
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
            <small>/{AP_CAP}</small>
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
        <span className="hud-stat vp">
          <i>VP · to {VP_WIN_THRESHOLD}</i>
          <b title={`${FACTION_SHORT[you]} : ${FACTION_SHORT[otherPlayer(you)]}`}>
            <span className={you === 'SABRE' ? 'vp-blue' : 'vp-red'}>{state.players[you].vp}</span>
            <small> : </small>
            <span className={you === 'SABRE' ? 'vp-red' : 'vp-blue'}>{state.players[otherPlayer(you)].vp}</span>
          </b>
        </span>
      </div>
    </div>
  );
};
