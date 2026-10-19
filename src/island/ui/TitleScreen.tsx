import { useMemo, useState } from 'react';
import { BotLevel } from '../bot';
import { FACTIONS, FACTION_IDS, FactionId } from '../types';
import { Emblem } from './Glyphs';
import { MapView, demoHoldings } from './MapView';

export interface Setup {
  faction: FactionId;
  opponents: number;
  level: BotLevel;
}

const LEVELS: { id: BotLevel; label: string; blurb: string }[] = [
  { id: 'RECRUIT', label: 'Recruit', blurb: 'Cautious bots. Learn the ropes.' },
  { id: 'REGULAR', label: 'Regular', blurb: 'A fair fight.' },
  { id: 'VETERAN', label: 'Veteran', blurb: 'Aggressive bots that take every opening.' },
];

export function TitleScreen({ initial, onStart }: { initial: Setup; onStart: (s: Setup) => void }) {
  const [setup, setSetup] = useState(initial);
  const [howTo, setHowTo] = useState(false);
  const backdrop = useMemo(() => demoHoldings(FACTION_IDS), []);
  const chosen = FACTIONS[setup.faction];

  return (
    <div className="io-title" style={{ ['--c' as string]: chosen.color }}>
      <div className="io-title-map" aria-hidden="true">
        <MapView holdings={backdrop} showLabels={false} />
      </div>
      <div className="io-title-shade" />

      <div className="io-title-inner">
        <header className="io-hero">
          <div className="io-hero-kicker">A Total Defence strategy game</div>
          <h1 className="io-logo">
            COMMAND
            <span className="io-logo-tag">ISLAND OPS</span>
          </h1>
          <p className="io-tagline">Take the island. Sector by sector.</p>
        </header>

        <section className="io-setup">
          <h2>Choose your service</h2>
          <div className="io-factions">
            {FACTION_IDS.map((id) => {
              const f = FACTIONS[id];
              return (
                <button
                  key={id}
                  className={`io-faction${setup.faction === id ? ' io-faction-on' : ''}`}
                  style={{ ['--c' as string]: f.color, ['--d' as string]: f.deep }}
                  onClick={() => setSetup({ ...setup, faction: id })}
                  data-testid={`faction-${id}`}
                >
                  <span className="io-faction-emblem">
                    <Emblem faction={id} size={30} color="#fff" />
                  </span>
                  <span className="io-faction-name">{f.name}</span>
                  <span className="io-faction-power">{f.power}</span>
                  <span className="io-faction-text">{f.powerText}</span>
                </button>
              );
            })}
          </div>

          <div className="io-setup-row">
            <div className="io-field">
              <span className="io-field-label">Opponents</span>
              <div className="io-seg">
                {[2, 3].map((n) => (
                  <button key={n} className={setup.opponents === n ? 'on' : ''} onClick={() => setSetup({ ...setup, opponents: n })}>
                    {n} bots
                  </button>
                ))}
              </div>
            </div>
            <div className="io-field">
              <span className="io-field-label">Difficulty</span>
              <div className="io-seg">
                {LEVELS.map((l) => (
                  <button key={l.id} className={setup.level === l.id ? 'on' : ''} title={l.blurb} onClick={() => setSetup({ ...setup, level: l.id })}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <button className="io-btn io-btn-primary io-btn-deploy" onClick={() => onStart(setup)} data-testid="deploy">
              Deploy
            </button>
          </div>
        </section>

        <footer className="io-title-foot">
          <button className="io-link" onClick={() => setHowTo(true)}>
            How to play
          </button>
          <span>·</span>
          <a className="io-link" href="#classic">
            Classic mode
          </a>
          <span>·</span>
          <span className="io-fine">A fictional Total Defence exercise. Not an official MINDEF product.</span>
        </footer>
      </div>

      {howTo && <HowToPlay onClose={() => setHowTo(false)} />}
    </div>
  );
}

export function HowToPlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="io-modal-backdrop" onClick={onClose}>
      <div className="io-howto" onClick={(e) => e.stopPropagation()}>
        <div className="io-hand-head">
          <h3>How to play</h3>
          <button className="io-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <ol className="io-howto-steps">
          <li>
            <b>Mobilise.</b> Get troops: one for every three regions you hold (min 3), plus a bonus for every <b>whole sector</b> you hold. Tap your regions to
            place them.
          </li>
          <li>
            <b>Assault.</b> Attack from a region with 2+ troops into a neighbour. You roll up to 3 dice, they roll up to 2; highest dice are compared and
            ties go to the defender. Towns and hills (marked ▲) give the defender +1 on their best die. Wipe them out and you move in.
          </li>
          <li>
            <b>Redeploy.</b> Move troops once between your connected regions, and your turn ends.
          </li>
        </ol>
        <p>
          <b>Asset Cards.</b> Capture at least one region in a turn to earn a card. Trade three of a kind, or one of each, for troops; each trade in the game is
          worth more than the last.
        </p>
        <p>
          <b>Winning.</b> Complete your secret <b>Ops Order</b>, or be the last force on the island.
        </p>
      </div>
    </div>
  );
}
