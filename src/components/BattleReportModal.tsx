import React, { useState } from 'react';
import { BattleFactor, BattleReport, gridRef } from '../game/types';

const OUTCOME_COLOR: Record<BattleReport['outcome'], string> = {
  'Position Captured': 'var(--olive-bright)',
  'Defender Repelled': 'var(--olive-bright)',
  'Attack Repulsed': 'var(--danger)',
  'Mutual Attrition': 'var(--amber)',
};

/** The factors that actually moved the needle, biggest first. */
function decisive(factors: BattleFactor[], side: 'attacker' | 'defender'): BattleFactor[] {
  return factors
    .filter((f) => f.side === side && f.magnitude >= 10 && !/base (attack|defense)/i.test(f.label))
    .sort((a, b) => b.magnitude - a.magnitude);
}

/** One plain sentence explaining the result, built from the decisive factors. */
function explain(report: BattleReport): string {
  const attackerWon = report.outcome === 'Position Captured' || report.outcome === 'Defender Repelled';
  const ratio = report.attackerPower / (report.attackerPower + report.defenderPower);
  const margin = Math.abs(ratio - 0.5) < 0.06 ? 'narrowly' : Math.abs(ratio - 0.5) > 0.2 ? 'decisively' : 'clearly';
  const helped = decisive(report.factors, attackerWon ? 'attacker' : 'defender')
    .filter((f) => f.positive)
    .slice(0, 2)
    .map((f) => f.label.toLowerCase());
  const hurt = decisive(report.factors, attackerWon ? 'defender' : 'attacker')
    .filter((f) => !f.positive)
    .slice(0, 1)
    .map((f) => f.label.toLowerCase());
  const winner = attackerWon ? report.attackerName : report.defenderName;
  const loser = attackerWon ? report.defenderName : report.attackerName;
  let s = `${winner} came out ahead ${margin}`;
  if (helped.length) s += ` on ${helped.join(' and ')}`;
  if (hurt.length) s += `, while ${loser} was held back by ${hurt[0]}`;
  return `${s}.`;
}

/**
 * Battle result card. Deliberately NOT a full-screen modal: it sits in a corner
 * so the two tiles it describes (flashed on the map) stay in view.
 */
export const BattleReportModal: React.FC<{ report: BattleReport; onClose: () => void; onFocus: () => void }> = ({
  report,
  onClose,
  onFocus,
}) => {
  const [showAll, setShowAll] = useState(false);
  const attackerWon = report.outcome === 'Position Captured' || report.outcome === 'Defender Repelled';
  const top = [...decisive(report.factors, 'attacker').slice(0, 3), ...decisive(report.factors, 'defender').slice(0, 3)].sort(
    (a, b) => b.magnitude - a.magnitude
  );
  const shown = showAll ? report.factors : top.slice(0, 4);

  return (
    <div className="battle-card" data-testid="battle-report">
      <div className="battle-card-head" style={{ borderColor: OUTCOME_COLOR[report.outcome] }}>
        <span className="battle-outcome" style={{ color: OUTCOME_COLOR[report.outcome] }}>
          {report.outcome}
        </span>
        <button className="icon-btn" onClick={onClose} title="Dismiss">
          ✕
        </button>
      </div>

      <div className="battle-line">
        <b>{report.attackerName}</b> (grid {gridRef(report.attackerX, report.attackerY)}) attacked{' '}
        <b>{report.defenderName}</b> (grid {gridRef(report.defenderX, report.defenderY)})
      </div>

      <div className="battle-bars">
        <div className={`bar-side ${attackerWon ? 'won' : ''}`}>
          <span className="bar-name">Attacker</span>
          <span className="bar-num">{report.attackerPower.toFixed(1)}</span>
          <span className="bar-loss">{report.attackerLoss} losses · {report.attackerStrengthDelta.toFixed(0)}%</span>
        </div>
        <div className={`bar-side ${attackerWon ? '' : 'won'}`}>
          <span className="bar-name">Defender</span>
          <span className="bar-num">{report.defenderPower.toFixed(1)}</span>
          <span className="bar-loss">{report.defenderLoss} losses · {report.defenderStrengthDelta.toFixed(0)}%</span>
        </div>
      </div>

      <p className="battle-why">{explain(report)}</p>
      {report.captured && <div className="battle-captured">Position captured and occupied.</div>}

      <ul className="battle-factors">
        {shown.map((f, i) => (
          <li key={i} className={f.positive ? 'factor-pos' : 'factor-neg'}>
            <span className="factor-side">{f.side === 'defender' ? 'DEF' : 'ATK'}</span>
            {f.positive ? '+' : '−'} {f.label}
            {f.magnitude ? <span className="factor-mag">{Math.round(f.magnitude)}%</span> : null}
          </li>
        ))}
      </ul>

      <div className="battle-card-foot">
        <button className="btn-ghost small" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Key factors only' : `All ${report.factors.length} factors`}
        </button>
        <button className="btn-ghost small" onClick={onFocus}>
          Show me
        </button>
        <button className="btn-primary small" onClick={onClose}>
          Continue
        </button>
      </div>
    </div>
  );
};
