import { useMemo, useState } from 'react';
import { BotLevel } from '../bot';
import { BOARD } from '../map';
import { FACTIONS, FACTION_IDS, FactionId, MAX_ROUNDS, VP_TARGET } from '../types';
import { Emblem, Icon } from './Glyphs';
import { Help } from './Help';
import { SoundButton } from './Hud';
import { Badge, MapView } from './MapView';
import type { SavedMatch } from './save';
import { FACTION_INK } from './theme';
import './title.css';

export interface Setup {
  faction: FactionId;
  opponents: number;
  level: BotLevel;
}

const LEVELS: { id: BotLevel; label: string; blurb: string }[] = [
  { id: 'RECRUIT', label: 'Recruit', blurb: 'Bots get fewer reinforcements. Learn the ropes.' },
  { id: 'REGULAR', label: 'Regular', blurb: 'A fair fight.' },
  { id: 'VETERAN', label: 'Veteran', blurb: 'Bots get extra reinforcements and take every opening.' },
];

export function TitleScreen({ initial, onStart, saved, onResume }: { initial: Setup; onStart: (s: Setup) => void; saved: SavedMatch | null; onResume: () => void }) {
  const [setup, setSetup] = useState(initial);
  const [howTo, setHowTo] = useState(false);
  const backdrop = useMemo(() => {
    const out: Record<string, Badge> = {};
    BOARD.regions.forEach((r, i) => (out[r.id] = { owner: FACTION_IDS[(i * 7 + r.sector.length * 3) % FACTION_IDS.length], text: String(1 + ((i * 13) % 9)), fog: false }));
    return out;
  }, []);
  const chosen = FACTIONS[setup.faction];
  const level = LEVELS.find((l) => l.id === setup.level)!;
  const savedMe = saved?.game.factions.find((f) => saved.game.players[f]?.human);

  return (
    <div className="io-title" style={{ ['--c' as string]: chosen.color }}>
      <div className="io-title-map" aria-hidden="true">
        <MapView badges={backdrop} showLabels={false} cover />
      </div>
      <div className="io-title-shade" />

      <div className="io-title-tools">
        <SoundButton />
      </div>

      <main className="io-title-inner">
        <header className="io-hero">
          <div className="io-hero-kicker">A Total Defence strategy game</div>
          <h1 className="io-logo">
            COMMAND
            <span className="io-logo-tag">ISLAND OPS</span>
          </h1>
          <p className="io-tagline">Plan in secret. Strike together. Hold the island.</p>
        </header>

        {saved && savedMe && (
          <section className="io-card io-continue" style={{ ['--c' as string]: FACTIONS[savedMe].color }} aria-label="Match in progress">
            <span className="io-emblem-dot io-emblem-lg">
              <Emblem faction={savedMe} size={24} color={FACTION_INK[savedMe]} />
            </span>
            <span className="io-continue-text">
              <b>Match in progress</b>
              <small>
                {FACTIONS[savedMe].name} · round {saved.game.round} of {MAX_ROUNDS} · {saved.game.players[savedMe]!.vp} VP
              </small>
            </span>
            <button className="io-btn io-btn-primary" onClick={onResume} data-testid="continue">
              Continue
            </button>
          </section>
        )}

        <section className="io-card io-setup" aria-labelledby="io-setup-title">
          <h2 id="io-setup-title">Choose your task force</h2>
          <div className="io-factions" role="radiogroup" aria-labelledby="io-setup-title">
            {FACTION_IDS.map((id) => {
              const f = FACTIONS[id];
              const on = setup.faction === id;
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={on}
                  className={`io-faction${on ? ' io-faction-on' : ''}`}
                  style={{ ['--c' as string]: f.color, ['--d' as string]: f.deep }}
                  onClick={() => setSetup({ ...setup, faction: id })}
                  data-testid={`faction-${id}`}
                >
                  <span className="io-faction-top">
                    <span className="io-emblem-dot io-emblem-lg">
                      <Emblem faction={id} size={26} color={FACTION_INK[id]} />
                    </span>
                    <span>
                      <span className="io-faction-name">{f.name}</span>
                      <span className="io-faction-power">{f.doctrine}</span>
                    </span>
                  </span>
                  <span className="io-faction-text">{f.doctrineText}</span>
                  <span className="io-faction-orbat">
                    {f.battalions.join(' · ')} · {f.squadron}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="io-setup-row">
            <div className="io-field">
              <span className="io-field-label" id="io-opp-label">
                Opponents
              </span>
              <div className="io-seg" role="radiogroup" aria-labelledby="io-opp-label">
                {[2, 3].map((n) => (
                  <button key={n} role="radio" aria-checked={setup.opponents === n} className={setup.opponents === n ? 'on' : ''} onClick={() => setSetup({ ...setup, opponents: n })}>
                    {n} bots
                  </button>
                ))}
              </div>
            </div>
            <div className="io-field">
              <span className="io-field-label" id="io-lvl-label">
                Difficulty
              </span>
              <div className="io-seg" role="radiogroup" aria-labelledby="io-lvl-label" aria-describedby="io-lvl-blurb">
                {LEVELS.map((l) => (
                  <button key={l.id} role="radio" aria-checked={setup.level === l.id} className={setup.level === l.id ? 'on' : ''} onClick={() => setSetup({ ...setup, level: l.id })}>
                    {l.label}
                  </button>
                ))}
              </div>
              <span className="io-field-note" id="io-lvl-blurb">
                {level.blurb}
              </span>
            </div>
            <div className="io-setup-go">
              <button className="io-btn io-btn-ghost" onClick={() => setHowTo(true)} data-testid="howto">
                <Icon name="help" /> How to play
              </button>
              <button className="io-btn io-btn-primary io-btn-deploy" onClick={() => onStart(setup)} data-testid="deploy">
                {saved ? 'New match' : 'Start'}
              </button>
            </div>
          </div>
          <p className="io-setup-goal">
            <Icon name="star" size={14} className="io-star" /> Hold Key Installations — each one scores a victory point every round. First to {VP_TARGET} VP wins.
          </p>
        </section>

        <footer className="io-title-foot">
          <a className="io-link" href="#classic">
            Classic mode
          </a>
          <span aria-hidden="true">·</span>
          <span className="io-fine">A fictional Total Defence exercise. Not an official MINDEF product.</span>
        </footer>
      </main>

      {howTo && <Help onClose={() => setHowTo(false)} />}
    </div>
  );
}
