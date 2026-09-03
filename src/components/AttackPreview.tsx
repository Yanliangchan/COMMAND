import React from 'react';
import { INTEL_NOTE, Prediction } from '../game/combat';
import { BattleFactor, DETECTION_LEVEL_LABEL, gridRef } from '../game/types';

/**
 * PRE-ATTACK ODDS PREVIEW (phase 6).
 *
 * Shown while Attack is armed and a valid target is hovered, in the same slot
 * the movement preview uses. It is the promise the battle report then keeps:
 * the same chain, the same factor list, the same expected losses — only the
 * roll is missing.
 *
 * The width of the loss band is the whole point of recon now. Against a
 * CONFIRMED formation the band is just the +/-12% combat roll and the reading
 * is tight. Against one you have only IDENTIFIED, its strength, morale and
 * whether it is dug in are guesses, so the band opens right out and the panel
 * says so in as many words.
 */

const OUTCOME_TONE: Record<string, string> = {
  'Position Captured': 'good',
  'Defender Repelled': 'good',
  'Mutual Attrition': 'even',
  'Attack Repulsed': 'bad',
};

function Range({ v }: { v: { mid: number; low: number; high: number } }) {
  const lo = Math.round(v.low);
  const hi = Math.round(v.high);
  if (hi - lo <= 1) return <>{Math.round(v.mid)}%</>;
  return (
    <>
      {lo}–{hi}%
    </>
  );
}

/** The factors worth printing: everything that actually moved the number. */
function ranked(factors: BattleFactor[], side: 'attacker' | 'defender') {
  return factors
    .filter((f) => f.side === side && !/base (attack|defence)/i.test(f.label) && f.magnitude >= 4)
    .sort((a, b) => b.magnitude - a.magnitude);
}

export const AttackPreview: React.FC<{
  prediction: Prediction;
  attackerName: string;
  defenderName: string;
  defenderX: number;
  defenderY: number;
}> = ({ prediction: p, attackerName, defenderName, defenderX, defenderY }) => {
  const forFactors = ranked(p.factors, 'attacker');
  const againstFactors = ranked(p.factors, 'defender');
  const tone = OUTCOME_TONE[p.likelyOutcome] ?? 'even';

  return (
    <div className="attack-preview" data-testid="attack-preview">
      <div className="ap-head">
        <span className="ap-title">PREDICTED ENGAGEMENT</span>
        <span className={`ap-intel ${p.uncertain ? 'wide' : 'tight'}`} data-testid="attack-preview-confidence">
          {DETECTION_LEVEL_LABEL[p.intel]} · {p.uncertain ? 'wide estimate' : 'reliable'}
        </span>
      </div>

      <div className="ap-line">
        <b>{attackerName}</b> → <b>{defenderName}</b> at grid {gridRef(defenderX, defenderY)}
      </div>

      <div className={`ap-outcome ${tone}`} data-testid="attack-preview-outcome">
        {p.likelyOutcome}
        {p.worstOutcome !== p.bestOutcome && (
          <span className="ap-outcome-band">
            {' '}
            (could be {p.worstOutcome === p.likelyOutcome ? p.bestOutcome : p.worstOutcome})
          </span>
        )}
      </div>

      <div className="ap-losses">
        <div className="ap-loss">
          <span className="ap-loss-k">Your losses</span>
          <span className="ap-loss-v" data-testid="attack-preview-attacker-loss">
            <Range v={p.attackerLoss} />
          </span>
        </div>
        <div className="ap-loss">
          <span className="ap-loss-k">Their losses</span>
          <span className="ap-loss-v" data-testid="attack-preview-defender-loss">
            <Range v={p.defenderLoss} />
          </span>
        </div>
        <div className="ap-loss">
          <span className="ap-loss-k">Power</span>
          <span className="ap-loss-v">
            {p.attackerPower.toFixed(1)} v {p.defenderPower.toFixed(1)}
          </span>
        </div>
      </div>

      <div className="ap-bar" title="Your share of the total combat power">
        <div className="ap-bar-fill" style={{ width: `${Math.round(p.share * 100)}%` }} />
        <span className="ap-bar-label">{Math.round(p.share * 100)}% of the combat power is yours</span>
      </div>

      <div className="ap-cols">
        <div>
          <div className="ap-col-head good">FOR YOU</div>
          {forFactors.length === 0 && <div className="ap-factor muted">nothing beyond your base attack</div>}
          {forFactors.slice(0, 4).map((f, i) => (
            <div key={i} className={`ap-factor ${f.positive ? 'good' : 'bad'}`}>
              {f.positive ? '+' : '−'} {f.label} <em>{Math.round(f.magnitude)}%</em>
            </div>
          ))}
        </div>
        <div>
          <div className="ap-col-head bad">AGAINST YOU</div>
          {againstFactors.length === 0 && <div className="ap-factor muted">nothing beyond their base defence</div>}
          {againstFactors.slice(0, 4).map((f, i) => (
            <div key={i} className={`ap-factor ${f.positive ? 'bad' : 'good'}`}>
              {f.positive ? '+' : '−'} {f.label} <em>{Math.round(f.magnitude)}%</em>
            </div>
          ))}
        </div>
      </div>

      <div className={`ap-note ${p.uncertain ? 'warn' : ''}`} data-testid="attack-preview-note">
        {INTEL_NOTE[p.intel]}
      </div>
      {p.assumptions.length > 0 && (
        <div className="ap-assumptions" data-testid="attack-preview-assumptions">
          {p.assumptions.join(' · ')}
        </div>
      )}
      {!p.closeAssault && (
        <div className="ap-note">Standoff fire: heavy damage, almost no risk to you — but it cannot take the ground.</div>
      )}
    </div>
  );
};
