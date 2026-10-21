// ============================================================================
// Playback cards (one per resolved step) and the round report.
// ============================================================================

import { BOARD, INSTALLATIONS, SEA_ZONES } from '../map';
import { FACTIONS, FactionId, ReportStep, Side } from '../types';
import { Emblem, Icon } from './Glyphs';
import { plural } from './plan';
import { FACTION_INK } from './theme';
import './cards.css';

function sideTotal(sd: Side) {
  const bonus = sd.bonuses.reduce((n, b) => n + b.n, 0);
  return `${plural(sd.troops, 'troop')}${bonus ? ` + ${bonus}` : ''}`;
}

function SideRow({ sd, win, role }: { sd: Side; win: boolean; role: string }) {
  const f = FACTIONS[sd.owner];
  return (
    <div className={`io-bside${win ? ' io-bside-win' : ''}`} style={{ ['--c' as string]: f.color }}>
      <span className="io-emblem-dot">
        <Emblem faction={sd.owner} size={16} color={FACTION_INK[sd.owner]} />
      </span>
      <span className="io-bside-who">
        <b>
          {f.short} <small>{role}</small>
          {win && <em>WINS</em>}
        </b>
        <small>{sd.units.join(' · ')}</small>
        {sd.bonuses.length > 0 && <small className="io-bside-bonus">{sd.bonuses.map((b) => `${b.label} +${b.n}`).join(' · ')}</small>}
      </span>
      <span className="io-bside-str">
        <b>{sd.strength}</b>
        <small>{sideTotal(sd)}</small>
      </span>
    </div>
  );
}

export function StepCard({ step, me }: { step: ReportStep; me: FactionId }) {
  let body: React.ReactNode = null;
  if (step.kind === 'BATTLE') {
    body = (
      <>
        <div className="io-card-title">
          {INSTALLATIONS[step.region] && <Icon name="star" size={15} className="io-star" />} Battle for {BOARD.byId[step.region].name}
        </div>
        {step.defender && <SideRow sd={step.defender} win={!step.captured} role="defending" />}
        {step.attackers.map((a) => (
          <SideRow key={a.owner} sd={a} win={step.captured && a.owner === step.winner} role="attacking" />
        ))}
        <div className={`io-card-verdict${step.captured ? ' io-captured' : ''}`}>
          {step.captured ? `Captured by ${FACTIONS[step.winner].name}` : step.bounced ? `The attackers tie and cancel out — ${FACTIONS[step.winner].name} holds` : `Held by ${FACTIONS[step.winner].name}`} ·{' '}
          {plural(step.survivors, 'troop')} left
          {step.fallback && ` · ${plural(step.fallback.count, 'troop')} fall back to ${BOARD.byId[step.fallback.to].name}`}
        </div>
      </>
    );
  } else if (step.kind === 'NAVAL') {
    body = (
      <>
        <div className="io-card-title">
          <Icon name="anchor" size={15} /> Naval battle · {SEA_ZONES[step.zone].name}
        </div>
        {step.sides.map((sd) => (
          <div key={sd.owner} className={`io-bside${sd.owner === step.winner ? ' io-bside-win' : ''}`} style={{ ['--c' as string]: FACTIONS[sd.owner].color }}>
            <span className="io-emblem-dot">
              <Emblem faction={sd.owner} size={16} color={FACTION_INK[sd.owner]} />
            </span>
            <span className="io-bside-who">
              <b>{FACTIONS[sd.owner].short}</b>
              <small>{FACTIONS[sd.owner].squadron}</small>
            </span>
            <span className="io-bside-str">
              <b>{sd.ships}</b>
              <small>{step.sunk[sd.owner] ? `${step.sunk[sd.owner]} sunk` : plural(sd.ships, 'ship').replace(/^\d+ /, '')}</small>
            </span>
          </div>
        ))}
        <div className="io-card-verdict">{step.winner ? `${FACTIONS[step.winner].name} controls the ${SEA_ZONES[step.zone].name}` : 'Both fleets mauled — the sea is contested'}</div>
      </>
    );
  } else if (step.kind === 'CLASH') {
    body = (
      <>
        <div className="io-card-title">
          Columns clash on the road · {BOARD.byId[step.at[0]].name} ↔ {BOARD.byId[step.at[1]].name}
        </div>
        <SideRow sd={step.a} win={step.winner === step.a.owner} role="marching" />
        <SideRow sd={step.b} win={step.winner === step.b.owner} role="marching" />
        <div className="io-card-verdict">{step.winner ? `${FACTIONS[step.winner].name} pushes through` : 'Both columns shattered'}</div>
      </>
    );
  } else if (step.kind === 'SCORE') {
    const gains = Object.entries(step.gains) as [FactionId, number][];
    body = (
      <>
        <div className="io-card-title">
          <Icon name="star" size={15} className="io-star" /> Installations score
        </div>
        <div className="io-score-row">
          {gains.length ? (
            gains.map(([f, n]) => (
              <span key={f} className="io-score" style={{ background: FACTIONS[f].color, color: FACTION_INK[f] }}>
                {FACTIONS[f].short} +{n}
              </span>
            ))
          ) : (
            <span className="io-muted">Nobody holds an installation.</span>
          )}
        </div>
      </>
    );
  } else if (step.kind === 'FAILED') body = <div className="io-card-title io-card-plain">{step.text}</div>;
  else if (step.kind === 'ELIMINATED') body = <div className="io-card-title io-card-plain">{FACTIONS[step.who].name} has been wiped off the island.</div>;
  else if (step.kind === 'RECOMMISSION') body = <div className="io-card-title io-card-plain">{FACTIONS[step.owner].name} recommissions a ship in the {SEA_ZONES[step.zone].name}.</div>;
  if (!body) return null;
  const involved =
    (step.kind === 'BATTLE' && (step.defender?.owner === me || step.attackers.some((a) => a.owner === me))) ||
    (step.kind === 'NAVAL' && step.sides.some((x) => x.owner === me)) ||
    (step.kind === 'CLASH' && (step.a.owner === me || step.b.owner === me)) ||
    (step.kind === 'FAILED' && step.owner === me);
  return (
    <div className={`io-card io-step-card${involved ? ' io-step-mine' : ''}`} data-testid="step-card" role="status" aria-live="polite">
      {body}
    </div>
  );
}

export interface ReportLine {
  tone: 'win' | 'loss' | 'hold' | 'fail' | 'vp' | 'info';
  text: string;
}

const TONE_ICON: Record<ReportLine['tone'], string> = { win: '▲', loss: '▼', hold: '■', fail: '✕', vp: '★', info: '•' };

export function ReportCard({ round, lines, onClose }: { round: number; lines: ReportLine[]; onClose: () => void }) {
  return (
    <div className="io-card io-recap" role="status" aria-live="polite" data-testid="report">
      <div className="io-recap-head">
        <b>Round {round} report</b>
        <button className="io-icon-btn" onClick={onClose} aria-label="Dismiss report">
          <Icon name="close" />
        </button>
      </div>
      <ul>
        {lines.map((l, i) => (
          <li key={i} className={`io-tone-${l.tone}`}>
            <i aria-hidden="true">{TONE_ICON[l.tone]}</i>
            {l.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
