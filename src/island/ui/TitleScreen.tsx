import { useMemo, useState } from 'react';
import { BotLevel } from '../bot';
import { FACTIONS, FACTION_IDS, FactionId, MAX_ROUNDS, VP_TARGET } from '../types';
import { Emblem } from './Glyphs';
import { BOARD } from '../map';
import { Badge, MapView } from './MapView';

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
  const backdrop = useMemo(() => {
    const out: Record<string, Badge> = {};
    BOARD.regions.forEach((r, i) => (out[r.id] = { owner: FACTION_IDS[(i * 7 + r.sector.length * 3) % FACTION_IDS.length], text: String(1 + ((i * 13) % 9)), fog: false }));
    return out;
  }, []);
  const chosen = FACTIONS[setup.faction];

  return (
    <div className="io-title" style={{ ['--c' as string]: chosen.color }}>
      <div className="io-title-map" aria-hidden="true">
        <MapView badges={backdrop} showLabels={false} />
      </div>
      <div className="io-title-shade" />

      <div className="io-title-inner">
        <header className="io-hero">
          <div className="io-hero-kicker">A Total Defence strategy game</div>
          <h1 className="io-logo">
            COMMAND
            <span className="io-logo-tag">ISLAND OPS</span>
          </h1>
          <p className="io-tagline">Plan in secret. Strike together. Hold the island.</p>
        </header>

        <section className="io-setup">
          <h2>Choose your Pasukan</h2>
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
                  <span className="io-faction-power">{f.doctrine}</span>
                  <span className="io-faction-text">{f.doctrineText}</span>
                  <span className="io-faction-orbat">{f.battalions.join(' · ')} · {f.squadron}</span>
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
        <p>
          Every round, all Pasukan plan <b>at the same time and in secret</b>. When everyone is ready, all orders happen at once. No dice — the strongest force
          wins, and ties go to whoever holds the ground. What you can't be sure of is what the others ordered, and exactly how strong they are.
        </p>
        <ol className="io-howto-steps">
          <li>
            <b>Deploy</b> your new troops: 3 + one per three regions, plus extras from the City Centre, Energy Hub and Causeway.
          </li>
          <li>
            <b>Move.</b> Drag from your region onto a neighbour to march in (or reinforce). Every region keeps one troop. Columns that march straight at each
            other clash on the road.
          </li>
          <li>
            <b>Navy.</b> Ships sail one sea zone a round. Hold a zone alone and your ships carry landings between any two coasts on it, and add naval gunfire.
            Rival fleets in one zone fight; the bigger fleet wins.
          </li>
          <li>
            <b>Air.</b> Each sortie is a Strike (−2 troops on a region before anyone moves) or Air Support (+3 to your fight there). One sortie a round, plus
            one per Air Base.
          </li>
          <li>
            <b>Recon.</b> You only see rough numbers along your borders and nothing beyond. Recon shows a region and its neighbours exactly.
          </li>
        </ol>
        <p>
          <b>Winning.</b> Each ★ Key Installation you hold at the end of a round scores 1 victory point. First to {VP_TARGET} wins — or hold the most when round{' '}
          {MAX_ROUNDS} ends, or be the last Pasukan on the island.
        </p>
      </div>
    </div>
  );
}
