// ============================================================================
// Playback cards (one per resolved step) and the round report.
//
// A step card has a faction-tinted header strip (kicker + place) and a body.
// Fights build up before the verdict lands: strength bars grow and the numbers
// count up, then — at --io-rev, the moment usePlayback reveals the result on
// the map — the winner gets its stamp, the rest dim, and on a capture the
// header repaints in the winner's colour. All of that is CSS (cards.css), timed
// by --io-speed; under reduced motion the card simply shows the result.
// On short screens (max-height 560px) the same markup collapses to one line
// per side (cards.css), so a 3- or 4-way battle still fits in ~45% of the height.
// ============================================================================

import { BOARD, INSTALLATIONS, INSTALLATION_INFO, SEA_ZONES } from '../map';
import { FACTIONS, FactionId, ReportStep, Side } from '../types';
import { Emblem, Icon } from './Glyphs';
import { plural } from './plan';
import { FACTION_INK } from './theme';
import './cards.css';

/** Short forms for the bonus chips; the full label is the chip's title. */
const BONUS_SHORT: Record<string, string> = {
  'Air support': 'Air',
  'Naval gunfire': 'Naval',
  'Dug in': 'Dug in',
  Stronghold: 'Fort',
  Ambush: 'Ambush',
};

function bonusTotal(sd: Side) {
  return sd.bonuses.reduce((n, b) => n + b.n, 0);
}

/** A number that counts up to its value as the card builds (cards.css); the real text stays in the DOM. */
function Count({ n, hidden }: { n: number; hidden?: boolean }) {
  if (hidden) return <b className="io-count-static">?</b>;
  return (
    <b className="io-count" style={{ ['--to' as string]: n }}>
      <span>{n}</span>
    </b>
  );
}

function SideRow({ sd, win, lose, role, max, redacted }: { sd: Side; win: boolean; lose: boolean; role: string; max: number; redacted?: boolean }) {
  const f = FACTIONS[sd.owner];
  const bonus = bonusTotal(sd);
  const bonuses = sd.bonuses.filter((b) => b.n);
  return (
    <div
      className={`io-bside${win ? ' io-bside-win' : ''}${lose ? ' io-bside-lose' : ''}`}
      style={{ ['--c' as string]: f.color, ['--w' as string]: redacted ? 0 : Math.max(0.04, sd.strength / max) }}
    >
      <span className="io-emblem-dot">
        <Emblem faction={sd.owner} size={16} color={FACTION_INK[sd.owner]} />
      </span>
      <span className="io-bside-who">
        <b>
          {f.short} <small>{role}</small>
        </b>
        {sd.units.length > 0 && <small className="io-bside-units">{sd.units.join(' · ')}</small>}
        {bonuses.length > 0 && (
          <span className="io-bside-chips">
            {bonuses.map((b) => (
              <span key={b.label} className="io-chip" title={`${b.label} +${b.n}`}>
                {BONUS_SHORT[b.label] ?? b.label} +{b.n}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="io-bside-str">
        <Count n={sd.strength} hidden={redacted} />
        <small>{redacted ? 'unknown' : `${plural(sd.troops, 'troop')}${bonus ? ` + ${bonus}` : ''}`}</small>
      </span>
      <span className="io-bside-bar" aria-hidden="true">
        <i />
      </span>
      {win && (
        <em className="io-win-stamp" aria-label="wins">
          WINS
        </em>
      )}
    </div>
  );
}

function Head({ icon, kicker, title, color, to }: { icon: Parameters<typeof Icon>[0]['name']; kicker: string; title: string; color: string; to?: string }) {
  return (
    <div className="io-sc-head" style={{ ['--h' as string]: color, ['--h2' as string]: to ?? color }}>
      {to && <span className="io-sc-repaint" aria-hidden="true" />}
      <span className="io-sc-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="io-sc-text">
        <small>{kicker}</small>
        <b>{title}</b>
      </span>
    </div>
  );
}

const NEUTRAL = '#2f4a66';

/** A fresh key per step, so each card's content mounts anew and its build-up animation replays. */
const stepKeys = new WeakMap<ReportStep, number>();
let nextKey = 0;
function keyOf(step: ReportStep) {
  let k = stepKeys.get(step);
  if (k === undefined) stepKeys.set(step, (k = ++nextKey));
  return k;
}

export function StepCard({ step, me }: { step: ReportStep; me: FactionId }) {
  let head: React.ReactNode = null;
  let body: React.ReactNode = null;
  let tone = '';
  if (step.kind === 'BATTLE') {
    const sides = [...(step.defender ? [step.defender] : []), ...step.attackers];
    const max = Math.max(1, ...sides.map((s) => s.strength));
    const ki = INSTALLATIONS[step.region];
    const place = BOARD.byId[step.region].name;
    const winner = FACTIONS[step.winner];
    const fb = step.fallback;
    head = (
      <Head
        icon={ki ? 'star' : 'strike'}
        kicker={ki ? `Battle · ${INSTALLATION_INFO[ki].label}` : step.attackers.length > 1 ? `${sides.length}-way battle` : 'Battle'}
        title={place}
        color={step.defender ? FACTIONS[step.defender.owner].color : NEUTRAL}
        to={step.captured ? winner.color : undefined}
      />
    );
    body = (
      <>
        <div className="io-sc-sides">
          {step.defender && <SideRow sd={step.defender} win={!step.captured} lose={step.captured} role="defending" max={max} redacted={step.redacted} />}
          {step.attackers.map((a) => {
            const win = step.captured && a.owner === step.winner;
            return <SideRow key={a.owner} sd={a} win={win} lose={!win} role="attacking" max={max} redacted={step.redacted} />;
          })}
        </div>
        <div className={`io-card-verdict${step.captured ? ' io-captured' : ''}`} style={{ ['--c' as string]: winner.color }}>
          <span className="io-verdict-tag">{step.captured ? 'Captured' : step.bounced ? 'Stalemate' : 'Held'}</span>
          <span className="io-verdict-text">
            {step.captured
              ? `${winner.name} takes ${place}`
              : step.bounced
                ? `The attackers tie and cancel out — ${winner.short} holds`
                : `${winner.name} holds`}
            {!step.redacted && <> · {plural(step.survivors, 'troop')} left</>}
            {fb && !step.redacted && fb.count > 0 && (
              <>
                {' '}
                · {plural(fb.count, 'troop')} {fb.count === 1 ? 'falls' : 'fall'} back to {BOARD.byId[fb.to].name}
              </>
            )}
          </span>
        </div>
      </>
    );
  } else if (step.kind === 'NAVAL') {
    const max = Math.max(1, ...step.sides.map((s) => s.ships));
    const win = step.winner ? FACTIONS[step.winner] : null;
    head = <Head icon="anchor" kicker="Naval battle" title={SEA_ZONES[step.zone].name} color={NEUTRAL} to={win?.color} />;
    body = (
      <>
        <div className="io-sc-sides">
          {step.sides.map((sd) => {
            const f = FACTIONS[sd.owner];
            const sunk = step.sunk[sd.owner] ?? 0;
            const won = sd.owner === step.winner;
            return (
              <div key={sd.owner} className={`io-bside${won ? ' io-bside-win' : ' io-bside-lose'}`} style={{ ['--c' as string]: f.color, ['--w' as string]: sd.ships / max }}>
                <span className="io-emblem-dot">
                  <Emblem faction={sd.owner} size={16} color={FACTION_INK[sd.owner]} />
                </span>
                <span className="io-bside-who">
                  <b>
                    {f.short} <small>{f.squadron}</small>
                  </b>
                  <span className="io-fleet" aria-label={`${plural(sd.ships, 'ship')}${sunk ? `, ${sunk} sunk` : ''}`}>
                    {Array.from({ length: Math.min(sd.ships, 6) }, (_, i) => (
                      <i key={i} className={i >= sd.ships - sunk ? 'io-fleet-sunk' : undefined} />
                    ))}
                  </span>
                </span>
                <span className="io-bside-str">
                  <Count n={sd.ships} />
                  <small>{sunk ? `${sunk} sunk` : sd.ships === 1 ? 'ship' : 'ships'}</small>
                </span>
                <span className="io-bside-bar" aria-hidden="true">
                  <i />
                </span>
                {won && (
                  <em className="io-win-stamp" aria-label="wins">
                    WINS
                  </em>
                )}
              </div>
            );
          })}
        </div>
        <div className={`io-card-verdict${win ? ' io-captured' : ''}`} style={{ ['--c' as string]: win?.color ?? NEUTRAL }}>
          <span className="io-verdict-tag">{win ? 'Sea control' : 'Contested'}</span>
          <span className="io-verdict-text">{win ? `${win.name} controls the ${SEA_ZONES[step.zone].name}` : 'Both fleets mauled — the sea is contested'}</span>
        </div>
      </>
    );
  } else if (step.kind === 'CLASH') {
    const max = Math.max(1, step.a.strength, step.b.strength);
    const win = step.winner ? FACTIONS[step.winner] : null;
    head = <Head icon="cross" kicker="Columns clash on the road" title={`${BOARD.byId[step.at[0]].name} ↔ ${BOARD.byId[step.at[1]].name}`} color={NEUTRAL} to={win?.color} />;
    body = (
      <>
        <div className="io-sc-sides">
          <SideRow sd={step.a} win={step.winner === step.a.owner} lose={step.winner !== step.a.owner} role="marching" max={max} redacted={step.redacted} />
          <SideRow sd={step.b} win={step.winner === step.b.owner} lose={step.winner !== step.b.owner} role="marching" max={max} redacted={step.redacted} />
        </div>
        <div className={`io-card-verdict${win ? ' io-captured' : ''}`} style={{ ['--c' as string]: win?.color ?? NEUTRAL }}>
          <span className="io-verdict-tag">{win ? 'Through' : 'Shattered'}</span>
          <span className="io-verdict-text">{win ? `${win.name} pushes through` : 'Both columns shattered'}</span>
        </div>
      </>
    );
  } else if (step.kind === 'SCORE') {
    const gains = Object.entries(step.gains) as [FactionId, number][];
    tone = ' io-sc-score';
    head = <Head icon="star" kicker="Key Installations" title="Installations score" color="#c98a00" />;
    body = (
      <div className="io-score-row">
        {gains.length ? (
          gains.map(([f, n], i) => (
            <span key={f} className="io-score" style={{ ['--c' as string]: FACTIONS[f].color, ['--i' as string]: i, color: FACTION_INK[f] }}>
              <Emblem faction={f} size={16} color={FACTION_INK[f]} />
              {FACTIONS[f].short}
              <span className="io-score-vp">
                +<Count n={n} /> VP
              </span>
            </span>
          ))
        ) : (
          <span className="io-muted">Nobody holds an installation.</span>
        )}
      </div>
    );
  } else if (step.kind === 'ELIMINATED') {
    const f = FACTIONS[step.who];
    tone = ' io-sc-wiped';
    head = <Head icon="cross" kicker="Task force eliminated" title={f.name} color={f.deep} />;
    body = (
      <div className="io-wiped">
        <span className="io-wiped-emblem" style={{ ['--c' as string]: f.color }}>
          <Emblem faction={step.who} size={30} color={FACTION_INK[step.who]} />
        </span>
        <span className="io-wiped-text">
          <b>Wiped off the island</b>
          <small>{step.who === me ? 'Your task force is gone.' : `${f.short} is out of the exercise.`}</small>
        </span>
        <span className="io-wiped-stamp" aria-hidden="true">
          OUT
        </span>
      </div>
    );
  } else if (step.kind === 'RECOMMISSION') {
    const f = FACTIONS[step.owner];
    head = <Head icon="ship" kicker="Naval base" title="Ship recommissioned" color={f.color} />;
    body = <div className="io-card-plain">{`${f.name} puts a ship back to sea in the ${SEA_ZONES[step.zone].name}.`}</div>;
  } else if (step.kind === 'FAILED') {
    head = <Head icon="cross" kicker="Order failed" title={FACTIONS[step.owner].name} color="#b5650a" />;
    body = <div className="io-card-plain">{step.text}</div>;
  }
  if (!body) return null;
  const involved =
    (step.kind === 'BATTLE' && (step.defender?.owner === me || step.attackers.some((a) => a.owner === me))) ||
    (step.kind === 'NAVAL' && step.sides.some((x) => x.owner === me)) ||
    (step.kind === 'CLASH' && (step.a.owner === me || step.b.owner === me)) ||
    (step.kind === 'FAILED' && step.owner === me);
  return (
    // The live region stays mounted from step to step (so it's announced); the keyed inner part remounts.
    <div className={`io-card io-step-card${tone}${involved ? ' io-step-mine' : ''}`} data-testid="step-card" role="status" aria-live="polite">
      <div key={keyOf(step)} className="io-sc-inner">
        {head}
        <div className="io-sc-body">{body}</div>
        {involved && <span className="io-sc-mine">You</span>}
      </div>
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
