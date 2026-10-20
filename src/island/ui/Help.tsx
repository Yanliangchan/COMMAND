// How to play and the map key — one dialog, reachable from the title and from
// the "?" in the match.

import { useState } from 'react';
import {
  BASE_INCOME, CAS_BONUS, DEFENCE_BONUS, HARIMAU_AMBUSH_BONUS, JERUNG_CAPACITY_BONUS, MAX_ROUNDS, NAVAL_GUNFIRE_BONUS, SHIP_CAPACITY,
  SHIP_REPAIR_ROUNDS, STRIKE_DAMAGE, STRONGHOLD_BONUS, VP_TARGET, FACTIONS, FACTION_IDS,
} from '../types';
import { Emblem, Icon } from './Glyphs';
import { Modal } from './Modal';
import { FACTION_INK, FOG } from './theme';

type Tab = 'rules' | 'key';

export function Help({ onClose, initial = 'rules' }: { onClose: () => void; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <Modal title="Field manual" onClose={onClose} className="io-help">
      <div className="io-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>
          How to play
        </button>
        <button role="tab" aria-selected={tab === 'key'} className={tab === 'key' ? 'on' : ''} onClick={() => setTab('key')}>
          Map key
        </button>
      </div>
      <div className="io-help-body" role="tabpanel">
        {tab === 'rules' ? <Rules /> : <MapKey />}
      </div>
    </Modal>
  );
}

function Rules() {
  return (
    <>
      <p className="io-lede">
        Every round, all task forces plan <b>at the same time and in secret</b>. When everyone is ready, every order happens at once. There are no dice: the
        stronger side wins. What you can't be sure of is what the others ordered, and how strong they really are.
      </p>
      <h3>Winning</h3>
      <p>
        Each <b>★ Key Installation</b> you hold at the end of a round scores <b>1 victory point</b>. First to <b>{VP_TARGET} VP</b> wins — or the most VP
        when round {MAX_ROUNDS} ends, or the last task force on the island.
      </p>
      <h3>A round</h3>
      <ol className="io-help-steps">
        <li>
          <b>Deploy</b> every new troop onto your own regions. You get {BASE_INCOME}, plus one for every three regions you hold, plus Marina Bay +2, Jurong
          Island +2 and Woodlands +1 if they're yours.
        </li>
        <li>
          <b>Move.</b> Drag from your region onto a neighbour — onto your own ground to reinforce, onto anyone else's to attack. Or pick Move, tap your
          region, then the target. Every region keeps at least one troop.
        </li>
        <li>
          <b>Navy.</b> Tap a ship, then a neighbouring sea zone, to sail. If yours are the only ships in a zone you <b>control</b> it: your ships carry
          landings between any two coasts on it ({SHIP_CAPACITY} troops each) and your fights on those coasts get naval gunfire (+{NAVAL_GUNFIRE_BONUS}).
          Rival fleets that meet fight; the bigger fleet wins, an even fight sinks one of each. Sunk ships come back after {SHIP_REPAIR_ROUNDS} rounds at
          a Naval Base you hold.
        </li>
        <li>
          <b>Air.</b> Each sortie is a <b>Strike</b> (−{STRIKE_DAMAGE} troops on a region before anyone moves; it never kills the last troop) or{' '}
          <b>Air Support</b> (+{CAS_BONUS} to your side in a fight there, attacking or defending). One sortie a round, plus one for each Air Base.
        </li>
        <li>
          <b>Recon.</b> You see exact numbers only on your own ground; next to it you see a range (1–2, 3–5, 6–9, 10+), and beyond that nothing. Recon
          reveals a region and its neighbours exactly for this round. One a round, plus the Radar Station. <b>Recon is instant and can't be undone.</b>
        </li>
      </ol>
      <h3>Fights</h3>
      <ul className="io-help-list">
        <li>
          <b>Strength</b> = troops + bonuses. The defender gets +{DEFENCE_BONUS} dug in, or +{STRONGHOLD_BONUS} in a stronghold (towns and hills, marked
          with a little fort).
        </li>
        <li>
          The strongest side takes the region. <b>Ties go to the defender</b> — and if two attackers tie for strongest, they cancel out and the defender
          holds.
        </li>
        <li>
          The winner loses half the runner-up's strength (rounded up). The beaten side keeps half its troops and falls back — attackers the way they
          came, defenders to a neighbouring region of theirs. With nowhere to go, they surrender.
        </li>
        <li>Columns marching straight at each other meet on the road first: raw troops only, the bigger column pushes on.</li>
      </ul>
      <h3>Task forces</h3>
      <ul className="io-help-list io-help-factions">
        {FACTION_IDS.map((f) => (
          <li key={f} style={{ ['--c' as string]: FACTIONS[f].color }}>
            <span className="io-emblem-dot">
              <Emblem faction={f} size={16} color={FACTION_INK[f]} />
            </span>
            <span>
              <b>{FACTIONS[f].name}</b> — {FACTIONS[f].doctrine}: {FACTIONS[f].doctrineText}
              {f === 'HARIMAU' ? ` (Ambush is +${HARIMAU_AMBUSH_BONUS}.)` : f === 'JERUNG' ? ` (Ships carry ${SHIP_CAPACITY + JERUNG_CAPACITY_BONUS}.)` : ''}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function KeyBadge({ text, fog = false, ki = false, extra }: { text: string; fog?: boolean; ki?: boolean; extra?: string }) {
  const c = FACTIONS.HELANG;
  const rx = text.length > 2 ? 21 : 15;
  return (
    <svg viewBox="-34 -26 68 52" width={68} height={52} aria-hidden="true">
      {ki && <rect x={-rx - 5} y={-20} width={2 * rx + 10} height={40} rx={20} fill="#ffc83d" stroke="#7a5200" />}
      <rect x={-rx - 2.5} y={-17.5} width={2 * rx + 5} height={35} rx={17.5} fill="#fff" />
      <rect x={-rx} y={-15} width={2 * rx} height={30} rx={15} fill={fog ? FOG.rim : c.deep} />
      <rect x={-rx + 3} y={-12} width={2 * rx - 6} height={24} rx={12} fill={fog ? FOG.fill : c.color} />
      {ki && <path d="M0 -6 L1.8 -1.8 L6 -1.8 L2.6 1 L3.8 5.4 L0 2.8 L-3.8 5.4 L-2.6 1 L-6 -1.8 L-1.8 -1.8Z" transform="translate(0 -21)" fill="#ffc83d" stroke="#5a3d00" />}
      <text dy="0.36em" textAnchor="middle" fontFamily="Russo One, sans-serif" fontSize={text.length > 2 ? 12 : 15} fill="#fff">
        {text}
      </text>
      {extra && (
        <g transform="translate(17 11)">
          <rect x={-1} y={-8} width={22} height={15} rx={7.5} fill="#1f9d4c" stroke="#fff" />
          <text x={2.5} y={3.6} fontFamily="Russo One, sans-serif" fontSize={9.5} fill="#fff">
            {extra}
          </text>
        </g>
      )}
    </svg>
  );
}

function MapKey() {
  const rows: { icon: React.ReactNode; text: React.ReactNode }[] = [
    { icon: <KeyBadge text="7" />, text: <><b>Exact strength</b> — your own ground, recon'd ground, or anything Tiger borders.</> },
    { icon: <KeyBadge text="3–5" fog />, text: <><b>Estimate</b> — enemy ground next to yours.</> },
    { icon: <KeyBadge text="?" fog />, text: <><b>Unknown</b> — beyond your borders. Recon to see it.</> },
    { icon: <KeyBadge text="9" extra="+3" />, text: <><b>New troops</b> you've placed this round.</> },
    { icon: <KeyBadge text="5" ki />, text: <><b>★ Key Installation</b> — 1 VP every round you hold it, plus a perk.</> },
    {
      icon: (
        <svg viewBox="-12 -12 24 24" width={30} height={30} aria-hidden="true" className="io-fort">
          <circle r={9} />
          <path d="M-3.6 3.6 V-2 H-2.2 V-3.8 H-0.7 V-2 H0.7 V-3.8 H2.2 V-2 H3.6 V3.6Z" />
        </svg>
      ),
      text: <><b>Stronghold</b> — the defender fights at +{STRONGHOLD_BONUS} instead of +{DEFENCE_BONUS}.</>,
    },
    {
      icon: (
        <svg viewBox="-12 -12 24 24" width={30} height={30} aria-hidden="true" className="io-threat">
          <path d="M0 -8 L8 6 L-8 6Z" />
          <text y="4.5">!</text>
        </svg>
      ),
      text: <><b>Under threat</b> — a neighbour may be stronger than your defence.</>,
    },
    { icon: <span className="io-key-swatch io-key-target" />, text: <><b>Yellow outline</b> — a neighbour you can march into.</> },
    { icon: <span className="io-key-swatch io-key-landing" />, text: <><b>Dashed blue outline</b> — a coast your ships can land on.</> },
    { icon: <span className="io-key-icon" style={{ background: '#d9452f' }}><Icon name="strike" size={16} /></span>, text: <><b>Strike</b> ordered on a region.</> },
    { icon: <span className="io-key-icon" style={{ background: '#2f8fd0' }}><Icon name="cas" size={16} /></span>, text: <><b>Air support</b> ordered for a fight.</> },
  ];
  return (
    <>
      <ul className="io-key">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="io-key-art">{r.icon}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <h3>Who's who</h3>
      <p className="io-help-note">Every task force has its own colour, emblem and texture on the map, so you can tell them apart without colour.</p>
      <ul className="io-key io-key-factions">
        {FACTION_IDS.map((f) => (
          <li key={f}>
            <svg viewBox="0 0 44 28" width={44} height={28} aria-hidden="true">
              <rect width="44" height="28" rx="6" fill={FACTIONS[f].color} />
              <rect width="44" height="28" rx="6" fill={`url(#io-key-pat-${f})`} />
              <defs>
                {f === 'SINGA' && (
                  <pattern id="io-key-pat-SINGA" width="12" height="12" patternUnits="userSpaceOnUse">
                    <path d="M0 6 L6 0 L12 6 L6 12Z" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />
                  </pattern>
                )}
                {f === 'HARIMAU' && (
                  <pattern id="io-key-pat-HARIMAU" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
                    <rect width="4.5" height="14" fill="rgba(60,30,0,0.25)" />
                  </pattern>
                )}
                {f === 'HELANG' && (
                  <pattern id="io-key-pat-HELANG" width="11" height="11" patternUnits="userSpaceOnUse">
                    <circle cx="5.5" cy="5.5" r="1.6" fill="rgba(255,255,255,0.35)" />
                  </pattern>
                )}
                {f === 'JERUNG' && (
                  <pattern id="io-key-pat-JERUNG" width="18" height="10" patternUnits="userSpaceOnUse">
                    <path d="M0 6 Q4.5 2 9 6 T18 6" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.3" />
                  </pattern>
                )}
              </defs>
            </svg>
            <span className="io-emblem-dot" style={{ ['--c' as string]: FACTIONS[f].color }}>
              <Emblem faction={f} size={16} color={FACTION_INK[f]} />
            </span>
            <span>{FACTIONS[f].name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
