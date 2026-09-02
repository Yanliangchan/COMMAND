import React from 'react';
import { BattleReport } from '../game/types';

export const BattleReportModal: React.FC<{ report: BattleReport; onClose: () => void }> = ({ report, onClose }) => {
  const outcomeColor =
    report.outcome === 'Position Captured' || report.outcome === 'Defender Repelled'
      ? 'var(--olive-bright)'
      : report.outcome === 'Attack Repulsed'
      ? 'var(--danger)'
      : 'var(--amber)';
  return (
    <div className="modal-backdrop">
      <div className="modal battle-report">
        <div className="modal-title" style={{ color: outcomeColor }}>
          {report.outcome.toUpperCase()}
        </div>
        <div className="battle-sub">
          {report.attackerName} <span className="vs">attacked</span> {report.defenderName}
        </div>
        <div className="battle-power-row">
          <div>
            <div className="power-label">Attacker Power</div>
            <div className="power-val">{report.attackerPower.toFixed(1)}</div>
            <div className="loss-tag">Losses: {report.attackerLoss}</div>
          </div>
          <div className="power-vs">vs</div>
          <div>
            <div className="power-label">Defender Power</div>
            <div className="power-val">{report.defenderPower.toFixed(1)}</div>
            <div className="loss-tag">Losses: {report.defenderLoss}</div>
          </div>
        </div>
        <div className="factors-title">Battle Factors</div>
        <ul className="factors-list">
          {report.factors.map((fac, i) => (
            <li key={i} className={fac.positive ? 'factor-pos' : 'factor-neg'}>
              {fac.positive ? '+' : '−'} {fac.label} {fac.magnitude ? `(${Math.round(fac.magnitude)}%)` : ''}
            </li>
          ))}
        </ul>
        <div className="battle-summary">
          {report.attackerName} strength {report.attackerStrengthDelta.toFixed(0)}% &nbsp;|&nbsp; {report.defenderName} strength {report.defenderStrengthDelta.toFixed(0)}%
          {report.captured && <div className="captured-note">Position captured and occupied by the attacker.</div>}
        </div>
        <button className="close-btn" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  );
};
