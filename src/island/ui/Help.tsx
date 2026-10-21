// The field manual: how to play and the map key — one dialog, reachable from
// the title and from the "?" in the match. Every number comes from the tuning
// constants in types.ts, so the manual can't drift from the rules engine. The
// map key draws its symbols with the board's own classes (map.css), so it
// follows whatever the board draws.

import { KeyboardEvent, ReactNode, useRef, useState } from 'react';
import { INSTALLATIONS, INSTALLATION_INFO, InstallationKind } from '../map';
import {
  BASE_INCOME, BASE_RECONS, BASE_SORTIES, CAS_BONUS, DEFENCE_BONUS, FACTIONS, FACTION_IDS, FactionId, HARIMAU_AMBUSH_BONUS, INSTALLATION_INCOME,
  JERUNG_CAPACITY_BONUS, MAX_ROUNDS, NAVAL_GUNFIRE_BONUS, SHIP_CAPACITY, SHIP_REPAIR_ROUNDS, START_SHIPS, STRIKE_DAMAGE, STRONGHOLD_BONUS,
  VP_TARGET,
} from '../types';
import { Emblem, Icon, IconName } from './Glyphs';
import { Modal } from './Modal';
import { FACTION_INK, FOG } from './theme';
import './help.css';

type Tab = 'rules' | 'key';
const TABS: { id: Tab; label: string }[] = [
  { id: 'rules', label: 'How to play' },
  { id: 'key', label: 'Map key' },
];

export function Help({ onClose, initial = 'rules' }: { onClose: () => void; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ rules: null, key: null });
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  };
  return (
    <Modal title="Field manual" kicker="Exercise Island Ops" icon="log" onClose={onClose} className="io-help">
      <div className="io-tabs io-fm-tabs" role="tablist" aria-label="Field manual sections" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => (tabRefs.current[t.id] = el)}
            role="tab"
            id={`io-fm-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="io-fm-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.id === 'rules' ? 'orders' : 'flag'} size={16} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="io-help-body io-fm" role="tabpanel" id="io-fm-panel" aria-labelledby={`io-fm-tab-${tab}`} key={tab} tabIndex={0}>
        {tab === 'rules' ? <Rules /> : <MapKey />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Sec({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="io-fm-sec">
      <h3>
        <span className="io-fm-num" aria-hidden="true">
          {String(n).padStart(2, '0')}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Chip({ icon, tone = 'navy', children }: { icon: IconName | 'clock'; tone?: 'navy' | 'gold' | 'red' | 'blue' | 'green'; children?: ReactNode }) {
  return (
    <span className={`io-fm-chip io-fm-${tone}`} aria-hidden="true">
      {icon === 'clock' ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      ) : (
        <Icon name={icon} size={18} />
      )}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// How to play
// ---------------------------------------------------------------------------

const PLAN: { icon: IconName; label: string; tone: 'navy' | 'red' | 'blue' }[] = [
  { icon: 'deploy', label: 'Deploy', tone: 'navy' },
  { icon: 'move', label: 'Move', tone: 'navy' },
  { icon: 'ship', label: 'Navy', tone: 'blue' },
  { icon: 'plane', label: 'Air', tone: 'red' },
  { icon: 'eye', label: 'Recon', tone: 'navy' },
];

const EXECUTE: { icon: IconName; label: string }[] = [
  { icon: 'deploy', label: 'New troops arrive' },
  { icon: 'ship', label: 'Fleets sail, then fight' },
  { icon: 'strike', label: 'Air strikes hit' },
  { icon: 'move', label: 'Columns march; head-on ones clash' },
  { icon: 'shield', label: 'Every battle, all at once' },
  { icon: 'star', label: 'Score ★, repair ships' },
];

const INCOME_NAMES: Partial<Record<InstallationKind, string>> = { CITY: 'Marina Bay', INDUSTRY: 'Jurong Island', CAUSEWAY: 'Woodlands' };

function Rules() {
  const income = (Object.keys(INCOME_NAMES) as InstallationKind[]).map((k) => `${INCOME_NAMES[k]} +${INSTALLATION_INCOME[k]}`);
  const kinds = Object.keys(INSTALLATION_INFO) as InstallationKind[];
  const count = (k: InstallationKind) => Object.values(INSTALLATIONS).filter((v) => v === k).length;
  // The worked example: 6 troops + air support against 5 in a stronghold.
  const atk = 6, def = 5;
  const atkS = atk + CAS_BONUS, defS = def + STRONGHOLD_BONUS;
  const kept = Math.max(1, atk - Math.ceil(defS / 2));
  return (
    <>
      <p className="io-fm-lede">
        Every round, all task forces plan <b>at the same time and in secret</b>. When everyone is ready, every order happens at once. There are no dice:
        the stronger side wins. What you can't be sure of is what the others ordered, and how strong they really are.
      </p>

      <Sec n={1} title="Mission">
        <ul className="io-fm-win">
          <li>
            <Chip icon="star" tone="gold" />
            <span>
              <b>First to {VP_TARGET} VP.</b> Each <b>★ Key Installation</b> you hold at the end of a round scores 1 victory point.
            </span>
          </li>
          <li>
            <Chip icon="clock" />
            <span>
              <b>Or the most VP</b> when round {MAX_ROUNDS} ends.
            </span>
          </li>
          <li>
            <Chip icon="flag" tone="red" />
            <span>
              <b>Or the last task force</b> left on the island.
            </span>
          </li>
        </ul>
      </Sec>

      <Sec n={2} title="A round">
        <figure className="io-fm-round" aria-label="A round: plan in secret, press Ready, then everything resolves in order.">
          <div className="io-fm-phase">
            <span className="io-fm-phase-tag">Plan · in secret</span>
            <ol className="io-fm-plan">
              {PLAN.map((p) => (
                <li key={p.label}>
                  <Chip icon={p.icon} tone={p.tone} />
                  <span>{p.label}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="io-fm-ready" aria-hidden="true">
            <span>Ready</span>
          </div>
          <div className="io-fm-phase io-fm-phase-exec">
            <span className="io-fm-phase-tag">Execute · all at once, in this order</span>
            <ol className="io-fm-exec">
              {EXECUTE.map((p, i) => (
                <li key={p.label}>
                  <span className="io-fm-step">{i + 1}</span>
                  <Icon name={p.icon} size={16} />
                  <span>{p.label}</span>
                </li>
              ))}
            </ol>
          </div>
        </figure>

        <ul className="io-fm-orders">
          <li>
            <Chip icon="deploy" />
            <span>
              <b>Deploy</b> every new troop onto your own regions. You get {BASE_INCOME}, plus one for every three regions you hold, plus {income.join(', ')}{' '}
              if they're yours.
            </span>
          </li>
          <li>
            <Chip icon="move" />
            <span>
              <b>Move.</b> Drag from your region onto a neighbour — onto your own ground to reinforce, onto anyone else's to attack. Or pick Move, tap your
              region, then the target. Every region keeps at least one troop.
            </span>
          </li>
          <li>
            <Chip icon="ship" tone="blue" />
            <span>
              <b>Navy.</b> You start with {START_SHIPS} ships. Tap a ship, then a neighbouring sea zone, to sail. If yours are the only ships in a zone you{' '}
              <b>control</b> it: your ships carry landings between any two coasts on it ({SHIP_CAPACITY} troops each) and your fights on those coasts get naval
              gunfire (+{NAVAL_GUNFIRE_BONUS}). Rival fleets that meet fight: the biggest sinks the rest, losing half as many ships as the next-biggest had
              (rounded up); evenly matched fleets lose one each, and anything smaller is sunk. Sunk ships come back after {SHIP_REPAIR_ROUNDS} rounds at a Naval Base you hold.
            </span>
          </li>
          <li>
            <Chip icon="plane" tone="red" />
            <span>
              <b>Air.</b> Each sortie is a <b>Strike</b> (−{STRIKE_DAMAGE} troops on a region before anyone moves; it never kills the last troop) or{' '}
              <b>Air Support</b> (+{CAS_BONUS} to your side in a fight there, attacking or defending). {BASE_SORTIES} sortie a round, plus one for each Air
              Base.
            </span>
          </li>
          <li>
            <Chip icon="eye" />
            <span>
              <b>Recon.</b> You see exact numbers only on your own ground; next to it you see a range (1–2, 3–5, 6–9, 10+), and beyond that only colours.
              Recon reveals a region and its neighbours exactly for this round. {BASE_RECONS} a round, plus the Radar Station.{' '}
              <b>Recon is instant and can't be undone.</b>
            </span>
          </li>
        </ul>
      </Sec>

      <Sec n={3} title="Fights">
        <figure className="io-fm-fight" aria-label={`Example: ${atk} troops with air support, strength ${atkS}, attack ${def} troops in a stronghold, strength ${defS}. The attackers win and ${kept} hold the region; the defenders keep ${Math.floor(def / 2)} and fall back.`}>
          <div className="io-fm-side" style={{ ['--c' as string]: FACTIONS.SINGA.color }} aria-hidden="true">
            <span className="io-fm-side-name">Attacker</span>
            <span className="io-fm-pips">
              {Array.from({ length: atk }, (_, i) => (
                <i key={i} />
              ))}
              {Array.from({ length: CAS_BONUS }, (_, i) => (
                <i key={`b${i}`} className="io-fm-pip-air" />
              ))}
            </span>
            <span className="io-fm-sum">
              {atk} troops + {CAS_BONUS} air = <b>{atkS}</b>
            </span>
          </div>
          <div className="io-fm-vs" aria-hidden="true">
            VS
          </div>
          <div className="io-fm-side" style={{ ['--c' as string]: FACTIONS.HELANG.color }} aria-hidden="true">
            <span className="io-fm-side-name">Defender</span>
            <span className="io-fm-pips">
              {Array.from({ length: def }, (_, i) => (
                <i key={i} />
              ))}
              {Array.from({ length: STRONGHOLD_BONUS }, (_, i) => (
                <i key={`b${i}`} className="io-fm-pip-fort" />
              ))}
            </span>
            <span className="io-fm-sum">
              {def} troops + {STRONGHOLD_BONUS} stronghold = <b>{defS}</b>
            </span>
          </div>
          <figcaption aria-hidden="true">
            <b>
              {atkS} beats {defS}:
            </b>{' '}
            the attackers take the region, losing half of {defS} rounded up — <b>{kept} hold it</b>. The defenders keep half of {def} ({Math.floor(def / 2)}) and
            fall back next door.
          </figcaption>
        </figure>
        <ul className="io-fm-rules">
          <li>
            <b>Strength</b> = troops + bonuses. The defender gets +{DEFENCE_BONUS} dug in, or +{STRONGHOLD_BONUS} in a stronghold (towns and hills, marked
            with a little fort). Air support adds +{CAS_BONUS} to either side; naval gunfire +{NAVAL_GUNFIRE_BONUS}.
          </li>
          <li>
            The strongest side takes the region. <b>Ties go to the defender</b> — and if two attackers tie for strongest, they cancel out and the defender
            holds.
          </li>
          <li>The winner loses half the runner-up's strength in troops (rounded up), but always keeps at least one.</li>
          <li>
            The beaten side keeps half its troops (rounded down) and falls back — attackers the way they came, defenders to a neighbouring region of theirs.
            With nowhere to go, they surrender.
          </li>
          <li>
            Columns marching straight at each other <b>meet on the road</b> first: raw troops only. The bigger column pushes on, losing half the smaller one
            (rounded up); equal columns wipe each other out.
          </li>
        </ul>
      </Sec>

      <Sec n={4} title="Key Installations">
        <p className="io-fm-note">Each one scores 1 VP every round you hold it, and gives a perk while it's yours.</p>
        <ul className="io-fm-ki">
          {kinds.map((k) => (
            <li key={k}>
              <span className="io-fm-ki-star" aria-hidden="true">
                ★
              </span>
              <span>
                <b>
                  {INSTALLATION_INFO[k].label}
                  {count(k) > 1 ? ` ×${count(k)}` : ''}
                </b>
                <small>{INSTALLATION_INFO[k].perk}</small>
              </span>
            </li>
          ))}
        </ul>
      </Sec>

      <Sec n={5} title="Task forces">
        <ul className="io-fm-tf">
          {FACTION_IDS.map((f) => (
            <li key={f} style={{ ['--c' as string]: FACTIONS[f].color, ['--d' as string]: FACTIONS[f].deep }}>
              <span className="io-fm-medal" aria-hidden="true">
                <Emblem faction={f} size={20} color={FACTION_INK[f]} />
              </span>
              <span>
                <b>{FACTIONS[f].name}</b>
                <em>{FACTIONS[f].doctrine}</em>
                <span>
                  {FACTIONS[f].doctrineText}
                  {f === 'HARIMAU' ? ` (Ambush is +${HARIMAU_AMBUSH_BONUS}.)` : ''}
                  {f === 'JERUNG' ? ` (Ships carry ${SHIP_CAPACITY + JERUNG_CAPACITY_BONUS}; gunfire is +${NAVAL_GUNFIRE_BONUS * 2}.)` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Sec>
    </>
  );
}

// ---------------------------------------------------------------------------
// Map key — drawn with the board's own classes
// ---------------------------------------------------------------------------

const STAR = 'M0 -6 L1.8 -1.8 L6 -1.8 L2.6 1 L3.8 5.4 L0 2.8 L-3.8 5.4 L-2.6 1 L-6 -1.8 L-1.8 -1.8Z';
const FORT = 'M-3.6 3.6 V-2 H-2.2 V-3.8 H-0.7 V-2 H0.7 V-3.8 H2.2 V-2 H3.6 V3.6Z';

function KeyBadge({ text, fog = false, ki = false, fort = false, threat = false, extra, owner = 'HELANG' }: { text: string; fog?: boolean; ki?: boolean; fort?: boolean; threat?: boolean; extra?: string; owner?: FactionId }) {
  const c = FACTIONS[owner];
  const R = 15;
  const rx = text.length > 2 ? 21 : R;
  return (
    <svg viewBox="-38 -28 80 56" width={76} height={53} aria-hidden="true">
      {ki && <rect x={-rx - 5} y={-R - 5} width={2 * rx + 10} height={2 * R + 10} rx={R + 5} className="io-ki-ring" />}
      <rect x={-rx - 2.5} y={-R - 2.5} width={2 * rx + 5} height={2 * R + 5} rx={R + 2.5} fill="#fff" />
      <rect x={-rx} y={-R} width={2 * rx} height={2 * R} rx={R} fill={fog ? FOG.rim : c.deep} />
      <rect x={-rx + 3} y={-R + 3} width={2 * rx - 6} height={2 * R - 6} rx={R - 3} fill={fog ? FOG.fill : c.color} />
      {ki && <path d={STAR} transform={`translate(0 ${-R - 6})`} className="io-ki-star" />}
      {fort && (
        <g transform={`translate(${rx - 1} ${-R + 1})`} className="io-fort">
          <circle r={6.5} />
          <path d={FORT} />
        </g>
      )}
      <text className={`io-badge-num${fog ? ' io-badge-fog' : ''}`} dy="0.36em" fontSize={text.length > 2 ? 12 : 15} style={{ fill: fog ? '#fff' : FACTION_INK[owner] }}>
        {text}
      </text>
      {extra && (
        <g transform={`translate(${rx + 3} ${R - 3})`} className="io-badge-extra">
          <rect x={-1} y={-8} width={extra.length * 7 + 7} height={15} rx={7.5} />
          <text x={2.5} y={3.6}>
            {extra}
          </text>
        </g>
      )}
      {threat && (
        <g transform={`translate(${-rx - 1} ${-R + 3})`} className="io-threat">
          <path d="M0 -8 L8 6 L-8 6Z" />
          <text y="4.5">!</text>
        </g>
      )}
    </svg>
  );
}

/** A little patch of ground with the board's highlight outline on it. */
function KeyRegion({ hl }: { hl: 'target' | 'landing' }) {
  const d = 'M6 8 L30 3 L52 9 L56 26 L40 37 L14 35 L4 22Z';
  return (
    <svg viewBox="0 0 60 40" width={66} height={44} aria-hidden="true" className="io-fm-region">
      <path d={d} fill={FACTIONS.SINGA.color} stroke="rgba(0,0,0,0.25)" strokeWidth={1.5} />
      <path d={d} className={`io-hl-line io-hl-${hl}`} />
    </svg>
  );
}

function KeyGroup({ title, rows }: { title: string; rows: { icon: ReactNode; text: ReactNode }[] }) {
  return (
    <>
      <h3 className="io-fm-keyhead">{title}</h3>
      <ul className="io-fm-key">
        {rows.map((r, i) => (
          <li key={i}>
            <span className="io-fm-key-art">{r.icon}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function MapKey() {
  return (
    <>
      <KeyGroup
        title="Strength badges"
        rows={[
          { icon: <KeyBadge text="7" />, text: <><b>Exact strength</b> — your own ground, recon'd ground, or anything Tiger borders.</> },
          { icon: <KeyBadge text="3–5" fog />, text: <><b>Estimate</b> — enemy ground next to yours.</> },
          { icon: <KeyBadge text="?" fog />, text: <><b>Unknown</b> — beyond your borders. Recon to see it.</> },
          { icon: <KeyBadge text="9" extra="+3" />, text: <><b>New troops</b> you've placed this round (the green chip).</> },
        ]}
      />
      <KeyGroup
        title="Markers"
        rows={[
          { icon: <KeyBadge text="5" ki />, text: <><b>★ Key Installation</b> (gold ring) — 1 VP every round you hold it, plus a perk.</> },
          { icon: <KeyBadge text="4" fort />, text: <><b>Stronghold</b> (little fort) — the defender fights at +{STRONGHOLD_BONUS} instead of +{DEFENCE_BONUS}.</> },
          { icon: <KeyBadge text="3" threat owner="SINGA" />, text: <><b>Under threat</b> (red !) — a neighbour may be stronger than your defence.</> },
        ]}
      />
      <KeyGroup
        title="Highlights & orders"
        rows={[
          { icon: <KeyRegion hl="target" />, text: <><b>Yellow outline</b> — a neighbour you can march into.</> },
          { icon: <KeyRegion hl="landing" />, text: <><b>Dashed blue outline</b> — a coast your ships can land on.</> },
          { icon: <span className="io-fm-keyicon" style={{ background: '#d9452f' }}><Icon name="strike" size={16} /></span>, text: <><b>Strike</b> ordered on a region.</> },
          { icon: <span className="io-fm-keyicon" style={{ background: '#2f8fd0' }}><Icon name="cas" size={16} /></span>, text: <><b>Air support</b> ordered for a fight.</> },
        ]}
      />
      <h3 className="io-fm-keyhead">Who's who</h3>
      <p className="io-fm-note">Every task force has its own colour, emblem and texture on the map, so you can tell them apart without colour.</p>
      <ul className="io-fm-key io-fm-key-factions">
        {FACTION_IDS.map((f) => (
          <li key={f}>
            <svg viewBox="0 0 44 28" width={44} height={28} aria-hidden="true">
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
              <rect width="44" height="28" rx="6" fill={FACTIONS[f].color} />
              <rect width="44" height="28" rx="6" fill={`url(#io-key-pat-${f})`} />
            </svg>
            <span className="io-fm-medal" style={{ ['--c' as string]: FACTIONS[f].color, ['--d' as string]: FACTIONS[f].deep }} aria-hidden="true">
              <Emblem faction={f} size={16} color={FACTION_INK[f]} />
            </span>
            <span>
              <b>{FACTIONS[f].name}</b>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
