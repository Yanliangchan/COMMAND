// ============================================================================
// The match HUD. Layout zones (see island.css):
//   top bar · map (fitted to what's left) · side panel (right on wide screens,
//   a sheet on small ones) · command dock (bottom).
// Nothing in the HUD ever sits on the map's safe area uninvited.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { sound } from '../../audio/sound';
import { BOARD, INSTALLATIONS, INSTALLATION_INFO, SEA_ZONES } from '../map';
import { installationsOf, logFor, player, regionsOf } from '../engine';
import { FACTIONS, FactionId, GameState, MAX_ROUNDS, Order, PlayerView, VP_TARGET } from '../types';
import { Emblem, Icon, IconName } from './Glyphs';
import { DefenceReadout, plural } from './plan';
import { FACTION_INK } from './theme';

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export function useMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(sound.getSettings().muted);
  useEffect(() => sound.subscribe(() => setMuted(sound.getSettings().muted)), []);
  return [muted, () => sound.setMuted(!muted)];
}

export function SoundButton() {
  const [muted, toggle] = useMuted();
  return (
    <button className="io-icon-btn" onClick={toggle} aria-label={muted ? 'Sound off — turn on' : 'Sound on — turn off'} aria-pressed={!muted} title={muted ? 'Sound off' : 'Sound on'}>
      <Icon name={muted ? 'mute' : 'sound'} />
    </button>
  );
}

export function TopBar({ game, me, resolving, onHelp, onMenu }: { game: GameState; me: FactionId; resolving: boolean; onHelp: () => void; onMenu: () => void }) {
  // Fixed order — you first — so your chip never jumps around; the leader gets a crown instead.
  const order = [me, ...game.factions.filter((f) => f !== me)];
  const top = Math.max(...game.factions.map((f) => player(game, f).vp));
  return (
    <header className="io-topbar">
      <div className="io-logo-mini" aria-hidden="true">
        COMMAND<span>ISLAND OPS</span>
      </div>
      <ul className="io-players" aria-label="Task forces">
        {order.map((f) => {
          const p = player(game, f);
          const fac = FACTIONS[f];
          const lead = p.alive && p.vp === top && top > 0;
          return (
            <li
              key={f}
              className={`io-player${f === me ? ' io-player-me' : ''}${!p.alive ? ' io-player-dead' : ''}`}
              style={{ ['--c' as string]: fac.color, ['--d' as string]: fac.deep }}
              aria-label={`${fac.name}${f === me ? ' (you)' : ''}: ${p.vp} of ${VP_TARGET} victory points, ${regionsOf(game, f).length} regions, ${installationsOf(game, f).length} installations${p.alive ? '' : ', eliminated'}${lead ? ', leading' : ''}`}
            >
              <span className="io-emblem-dot">
                <Emblem faction={f} size={18} color={FACTION_INK[f]} />
              </span>
              <span className="io-player-text" aria-hidden="true">
                <b>
                  {fac.short}
                  {f === me && <em>YOU</em>}
                  {lead && <i className="io-lead">▲</i>}
                </b>
                <span className="io-vpbar">
                  <span style={{ width: `${Math.min(100, (p.vp / VP_TARGET) * 100)}%` }} />
                </span>
                <small>
                  <span className="io-vp" key={p.vp}>
                    {p.vp}
                  </span>
                  <span className="io-vp-of">/{VP_TARGET} VP</span>
                  <span className="io-player-extra"> · {regionsOf(game, f).length} reg · {installationsOf(game, f).length}★</span>
                </small>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="io-top-right">
        <span className="io-round" title={`The exercise ends after round ${MAX_ROUNDS} if nobody reaches ${VP_TARGET} VP first.`}>
          <span className="io-round-full">Round </span>
          {game.round}
          <span className="io-round-of">/{MAX_ROUNDS}</span>
          {resolving && <span className="io-round-full"> · resolving</span>}
        </span>
        <button className="io-icon-btn" onClick={onHelp} aria-label="Field manual: how to play and map key" title="How to play">
          <Icon name="help" />
        </button>
        <SoundButton />
        <button className="io-icon-btn" onClick={onMenu} aria-label="Main menu (your match is saved)" title="Main menu — your match is saved">
          <Icon name="exit" />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Side panel: orders · installations · log
// ---------------------------------------------------------------------------

export type SideTab = 'orders' | 'bases' | 'log';

export function orderText(o: Order, game: GameState): string {
  const n = (id: string) => BOARD.byId[id].name;
  switch (o.kind) {
    case 'DEPLOY':
      return `+${plural(o.count, 'troop')} at ${n(o.region)}`;
    case 'MOVE':
      return `${o.count} ${game.map[o.to].owner === game.map[o.from].owner ? 'reinforce' : 'attack'} ${n(o.to)} from ${n(o.from)}`;
    case 'LAND':
      return `${o.count} land at ${n(o.to)} from ${n(o.from)}`;
    case 'SAIL':
      return `${game.ships.find((s) => s.id === o.ship)?.name} sails to ${SEA_ZONES[o.to].name}`;
    case 'STRIKE':
      return `Strike ${n(o.region)}`;
    case 'CAS':
      return `Air support at ${n(o.region)}`;
  }
}

const ORDER_ICON: Record<Order['kind'], IconName> = { DEPLOY: 'deploy', MOVE: 'move', LAND: 'anchor', SAIL: 'ship', STRIKE: 'strike', CAS: 'cas' };

export function SidePanel({
  tab, setTab, draft, issues, game, me, onRemove, onEdit, onClose, sheet, top,
}: {
  tab: SideTab;
  setTab: (t: SideTab) => void;
  draft: Order[];
  issues: (string | null)[];
  game: GameState;
  me: FactionId;
  onRemove: (o: Order) => void;
  onEdit: (o: Order) => void;
  onClose?: () => void;
  sheet: boolean;
  top?: React.ReactNode;
}) {
  const tabs: { id: SideTab; label: string; n?: number }[] = [
    { id: 'orders', label: 'Orders', n: draft.length },
    { id: 'bases', label: 'Installations', n: installationsOf(game, me).length },
    { id: 'log', label: 'Log' },
  ];
  return (
    <aside className={`io-side${sheet ? ' io-side-sheet' : ''}`} style={{ ['--c' as string]: FACTIONS[me].color }} aria-label="Orders, installations and log">
      {top}
      <div className="io-side-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
            {t.n !== undefined && <b>{t.n}</b>}
          </button>
        ))}
        {onClose && (
          <button className="io-icon-btn io-side-close" onClick={onClose} aria-label="Close panel">
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="io-side-body" role="tabpanel">
        {tab === 'orders' && <OrdersList draft={draft} issues={issues} game={game} onRemove={onRemove} onEdit={onEdit} />}
        {tab === 'bases' && <Installations game={game} me={me} />}
        {tab === 'log' && <LogList game={game} me={me} />}
      </div>
    </aside>
  );
}

function OrdersList({ draft, issues, game, onRemove, onEdit }: { draft: Order[]; issues: (string | null)[]; game: GameState; onRemove: (o: Order) => void; onEdit: (o: Order) => void }) {
  if (!draft.length)
    return (
      <p className="io-empty">
        No orders yet. <b>Deploy</b> your new troops, then drag from one of your regions onto a neighbour to march — or onto a far coast to land by sea. Tap
        a ship, then a sea zone, to sail. Nobody sees your orders until everyone is ready.
      </p>
    );
  // Several taps on one region are one deployment as far as the player is concerned.
  const rows: { orders: Order[]; issue: string | null; text: string }[] = [];
  const deployRow: Record<string, (typeof rows)[number]> = {};
  draft.forEach((o, i) => {
    if (o.kind === 'DEPLOY' && deployRow[o.region]) {
      const row = deployRow[o.region];
      row.orders.push(o);
      row.issue ??= issues[i];
      const n = row.orders.reduce((t, x) => t + (x.kind === 'DEPLOY' ? x.count : 0), 0);
      row.text = orderText({ ...o, count: n }, game);
      return;
    }
    const row = { orders: [o], issue: issues[i], text: orderText(o, game) };
    if (o.kind === 'DEPLOY') deployRow[o.region] = row;
    rows.push(row);
  });
  return (
    <ul className="io-order-list" data-testid="orders">
      {rows.map(({ orders, issue, text }, i) => {
        const o = orders[0];
        return (
          <li key={i} className={issue ? 'io-order-bad' : ''}>
            <button className="io-order-text" onClick={() => onEdit(o)} disabled={o.kind !== 'MOVE' && o.kind !== 'LAND'} title={issue ?? undefined}>
              <Icon name={ORDER_ICON[o.kind]} size={15} />
              <span>
                {text}
                {issue && <small>{issue}</small>}
              </span>
            </button>
            <button className="io-order-x" onClick={() => orders.forEach(onRemove)} aria-label={`Remove order: ${text}`}>
              <Icon name="close" size={14} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Installations({ game, me }: { game: GameState; me: FactionId }) {
  const held = installationsOf(game, me).length;
  return (
    <>
      <p className="io-side-note">
        You hold <b>{held}</b> — that's <b>+{held} VP</b> at the end of this round.
      </p>
      <ul className="io-ki-list">
        {Object.entries(INSTALLATIONS).map(([r, kind]) => {
          const owner = game.map[r].owner;
          return (
            <li key={r} className={owner === me ? 'io-mine' : ''}>
              <span className="io-emblem-dot io-emblem-sm" style={{ ['--c' as string]: FACTIONS[owner].color }} title={FACTIONS[owner].name}>
                <Emblem faction={owner} size={12} color={FACTION_INK[owner]} />
              </span>
              <span className="io-ki-name">
                {BOARD.byId[r].name}
                <small>
                  {INSTALLATION_INFO[kind].label} · {INSTALLATION_INFO[kind].perk}
                </small>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function LogList({ game, me }: { game: GameState; me: FactionId }) {
  // Only what this task force had eyes on — the same fog as the playback.
  const items = logFor(game, me).slice(-80).reverse();
  return (
    <ul className="io-log-list">
      {items.map((l, i) => (
        <li key={i} style={{ borderColor: l.who ? FACTIONS[l.who].color : '#7b8692' }}>
          <small>R{l.round}</small> {l.text}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Command dock
// ---------------------------------------------------------------------------

export type Tool = 'deploy' | 'move' | 'strike' | 'cas' | 'recon';
export type Amount = 1 | 5 | 'all';

const ENCIK = (
  <svg viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="22" r="13" fill="#e8b98a" />
    <path d="M6 17 Q8 4 22 5 Q35 6 34 15 L34 17Z" fill="#7a1f1f" />
    <circle cx="28" cy="10" r="2.5" fill="#f2c94c" />
    <rect x="13" y="21" width="5" height="2.2" rx="1" fill="#2b1d12" />
    <rect x="22" y="21" width="5" height="2.2" rx="1" fill="#2b1d12" />
    <path d="M15 29 Q20 27 25 29" stroke="#2b1d12" strokeWidth="1.8" fill="none" />
  </svg>
);

export function Dock({
  view, tool, setTool, amount, setAmount, deployLeft, sortiesLeft, hint, onUndo, onClear, onReady, me, ordersCount, onOrders, compact, problems,
}: {
  view: PlayerView;
  tool: Tool;
  setTool: (t: Tool) => void;
  amount: Amount;
  setAmount: (a: Amount) => void;
  deployLeft: number;
  sortiesLeft: number;
  hint: string;
  onUndo: () => void;
  onClear: () => void;
  onReady: () => void;
  me: FactionId;
  ordersCount: number;
  onOrders?: () => void;
  compact: boolean;
  problems: number;
}) {
  const tool_ = (id: Tool, label: string, icon: IconName, badge?: string, disabled = false) => (
    <button
      className={`io-tool${tool === id ? ' on' : ''}${disabled ? ' io-tool-spent' : ''}`}
      onClick={() => setTool(id)}
      aria-pressed={tool === id}
      data-testid={`tool-${id}`}
    >
      <Icon name={icon} size={17} />
      <span className="io-tool-label">{label}</span>
      {badge !== undefined && <b>{badge}</b>}
    </button>
  );
  const blocked = deployLeft > 0 || problems > 0;
  return (
    <section className="io-dock" style={{ ['--c' as string]: FACTIONS[me].color }} aria-label="Orders">
      <div className="io-dock-hint" role="status" aria-live="polite">
        <span className="io-encik-face">{ENCIK}</span>
        <span>
          <b>
            Round {view.round}
            <span className="io-round-of">/{MAX_ROUNDS}</span>
          </b>
          {hint && ' · '}
          {hint}
        </span>
      </div>
      <div className="io-dock-row">
        <div className="io-tools">
          {tool_('deploy', 'Deploy', 'deploy', deployLeft > 0 ? String(deployLeft) : '✓')}
          {tool_('move', 'Move', 'move')}
          <div className={`io-tool-group${sortiesLeft <= 0 ? ' io-tool-spent' : ''}`} role="group" aria-label={`Air sorties: ${sortiesLeft} left`}>
            <span className="io-tool-count" title="Air sorties left">
              <Icon name="plane" size={15} />
              {sortiesLeft}
            </span>
            {tool_('strike', 'Strike', 'strike')}
            {tool_('cas', 'Air support', 'cas')}
          </div>
          {tool_('recon', 'Recon', 'recon', String(view.reconsLeft), view.reconsLeft <= 0)}
          {tool === 'deploy' && (
            <div className="io-seg" role="group" aria-label="Troops per tap">
              {([1, 5, 'all'] as Amount[]).map((a) => (
                <button key={a} className={amount === a ? 'on' : ''} aria-pressed={amount === a} onClick={() => setAmount(a)}>
                  {a === 'all' ? 'All' : `+${a}`}
                </button>
              ))}
            </div>
          )}
          <button className="io-tool io-tool-plain io-tool-edit" onClick={onUndo} disabled={!ordersCount} aria-label="Undo last order">
            <Icon name="undo" size={17} />
            <span className="io-tool-label">Undo</span>
          </button>
          <button className="io-tool io-tool-plain io-tool-edit" onClick={onClear} disabled={!ordersCount} aria-label="Clear all orders">
            <Icon name="clear" size={17} />
            <span className="io-tool-label">Clear</span>
          </button>
          {compact && onOrders && (
            <button className="io-tool io-tool-plain io-tool-edit" onClick={onOrders} aria-label={`Show orders (${ordersCount})`} data-testid="orders-toggle">
              <Icon name="orders" size={17} />
              <span className="io-tool-label">Orders</span>
              <b>{ordersCount}</b>
            </button>
          )}
        </div>
        <button className="io-btn io-btn-primary io-btn-main" onClick={onReady} aria-disabled={blocked} data-blocked={blocked || undefined} data-testid="ready">
          {deployLeft > 0 ? `Deploy ${deployLeft} more` : problems ? `Fix ${plural(problems, 'order')}` : 'Ready — Execute'}
          <kbd aria-hidden="true">Enter</kbd>
        </button>
      </div>
    </section>
  );
}

export function PlaybackBar({ round, paused, setPaused, speed, setSpeed, onSkip, me }: { round: number; paused: boolean; setPaused: (p: boolean) => void; speed: 1 | 2; setSpeed: (s: 1 | 2) => void; onSkip: () => void; me: FactionId }) {
  return (
    <section className="io-dock io-dock-play" style={{ ['--c' as string]: FACTIONS[me].color }} aria-label="Playback">
      <span className="io-play-title">
        <b>Round {round}</b> — every order happens at once
      </span>
      <div className="io-play-ctl">
        <button className="io-tool io-tool-plain" onClick={() => setPaused(!paused)} aria-label={paused ? 'Resume playback' : 'Pause playback'} data-testid="pause">
          <Icon name={paused ? 'play' : 'pause'} size={17} />
          <span className="io-tool-label">{paused ? 'Play' : 'Pause'}</span>
        </button>
        <button className="io-tool io-tool-plain" onClick={() => setSpeed(speed === 1 ? 2 : 1)} aria-label={`Playback speed ${speed}×`} aria-pressed={speed === 2}>
          <span className="io-speed">{speed}×</span>
        </button>
        <button className="io-btn io-btn-ghost" onClick={onSkip} data-testid="skip">
          Skip <Icon name="skip" size={15} />
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Move / landing picker
// ---------------------------------------------------------------------------

export interface PickerState {
  from: string;
  to: string;
  zone: import('../map').ZoneId | null;
  max: number;
  count: number;
  existing: boolean;
  attack: boolean;
  myBonuses: { label: string; n: number }[];
  def: DefenceReadout | null;
}

export function Picker({ p, game, onChange, onConfirm, onCancel }: { p: PickerState; game: GameState; onChange: (n: number) => void; onConfirm: () => void; onCancel: () => void }) {
  // Keyboard players land on the slider: arrows to choose, Enter to send, Escape to cancel.
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    slider.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [p.from, p.to]);
  const mine = p.myBonuses.reduce((n, b) => n + b.n, 0);
  const strength = p.count + mine;
  let verdict: { text: string; tone: 'good' | 'risky' | 'bad' } | null = null;
  if (p.attack && p.def) {
    if (strength > p.def.high + p.def.mayAddAir) verdict = { text: 'Should take it — even if they fly air support', tone: 'good' };
    else if (strength > p.def.high) verdict = { text: p.def.mayAddAir ? `Should take it — unless they fly air support (+${p.def.mayAddAir})` : 'Should take it', tone: 'good' };
    else if (strength > p.def.low) verdict = { text: 'Could go either way', tone: 'risky' };
    else verdict = { text: 'Likely to be beaten back', tone: 'bad' };
  }
  const title = p.zone ? 'Landing' : p.attack ? 'Attack' : 'Reinforce';
  return (
    <div className="io-picker" role="dialog" aria-modal="false" aria-label={`${title}: ${BOARD.byId[p.from].name} to ${BOARD.byId[p.to].name}`} data-testid="picker">
      <div className="io-picker-head">
        <span className={`io-pill io-pill-${p.attack ? 'attack' : 'move'}`}>{title}</span>
        <b>{BOARD.byId[p.from].name}</b> <Icon name="move" size={15} /> <b>{BOARD.byId[p.to].name}</b>
        <button className="io-icon-btn io-picker-x" onClick={onCancel} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="io-picker-sub">
        {game.map[p.from].unit}
        {p.zone ? ` · by sea across the ${SEA_ZONES[p.zone].name}` : ''}
      </div>
      <div className="io-slider-row">
        <button className="io-icon-btn" onClick={() => onChange(Math.max(0, p.count - 1))} aria-label="One fewer" disabled={p.count <= 0}>
          −
        </button>
        <input type="range" min={0} max={p.max} value={p.count} onChange={(e) => onChange(Number(e.target.value))} aria-label="Troops to send" ref={slider} />
        <button className="io-icon-btn" onClick={() => onChange(Math.min(p.max, p.count + 1))} aria-label="One more" disabled={p.count >= p.max}>
          +
        </button>
        <span className="io-count" aria-live="polite">
          {p.count}
          <small>/{p.max}</small>
        </span>
      </div>
      {p.attack && p.def && (
        <div className="io-odds">
          <div>
            <span>You</span>
            <b>{strength}</b>
            <small>{[`${p.count} troops`, ...p.myBonuses.map((b) => `${b.label} +${b.n}`)].join(' · ')}</small>
          </div>
          <div>
            <span>Them</span>
            <b>{p.def.low === p.def.high ? p.def.low : `${p.def.low}–${p.def.high}`}</b>
            <small>{[`${p.def.troops} troops`, ...p.def.bonuses.map((b) => `${b.label} +${b.n}`)].join(' · ')}</small>
          </div>
          {verdict && <p className={`io-verdict io-verdict-${verdict.tone}`}>{verdict.text}. Ties go to the defender — and they may be moving too.</p>}
        </div>
      )}
      <div className="io-actions">
        {p.existing && (
          <button className="io-btn io-btn-ghost" onClick={() => (onChange(0), onConfirm())}>
            Cancel order
          </button>
        )}
        <button className="io-btn io-btn-primary" onClick={onConfirm} data-testid="picker-ok" disabled={!p.count && !p.existing}>
          {p.count ? `Send ${p.count}` : 'Send none'}
        </button>
      </div>
    </div>
  );
}

