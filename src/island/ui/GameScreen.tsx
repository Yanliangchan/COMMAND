// ============================================================================
// The match: map + HUD + turn flow. Bots play one visible step at a time.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sound } from '../../audio/sound';
import { BOARD, SECTORS, SECTOR_IDS, regionsInSector } from '../map';
import {
  IllegalAction, apply, attackOptions, canStrike, connectedOwned, current, missionProgress, player, regionsOf, reinforcement, troopsOf,
} from '../engine';
import { BotLevel, botAction } from '../bot';
import { Action, FACTIONS, FactionId, GameEvent, GameState, MAX_HAND } from '../types';
import { DiceTray } from './Dice';
import { Emblem } from './Glyphs';
import { HandDrawer } from './Hand';
import { Arrow, Fx, Highlight, MapView } from './MapView';

type Battle = Extract<GameEvent, { kind: 'BATTLE' }>;

interface Banner {
  id: number;
  title: string;
  sub?: string;
  color: string;
}

interface Selection {
  from?: string;
  to?: string;
  striking?: boolean;
}

type Amount = 1 | 5 | 'all';
type Speed = 1 | 2 | 4;

export function GameScreen({ initial, level, onExit, onRestart }: { initial: GameState; level: BotLevel; onExit: () => void; onRestart: () => void }) {
  const [game, setGame] = useState(initial);
  const [sel, setSel] = useState<Selection>({});
  const [amount, setAmount] = useState<Amount>(1);
  const [count, setCount] = useState(1);
  const [handOpen, setHandOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [fx, setFx] = useState<Fx[]>([]);
  const [battle, setBattle] = useState<Battle | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const lastTick = useRef(game.tick - 1);
  const human = game.order.find((f) => player(game, f).human) ?? null;
  const me = current(game);
  const myTurn = me === human && game.phase !== 'GAME_OVER';
  const over = game.phase === 'GAME_OVER';

  // ---- effects director: turn new engine events into animation + sound ----
  useEffect(() => {
    const fresh = game.events.filter((e) => e.tick > lastTick.current);
    lastTick.current = game.tick;
    // Timers are deliberately not cancelled when the next event lands: a ripple
    // or banner should finish even if a bot acts again before it does.
    const later = (fn: () => void, ms: number) => window.setTimeout(fn, ms);
    const banner = (b: Omit<Banner, 'id'>, delay = 0) =>
      later(() => {
        const id = Math.random();
        setBanners((bs) => [...bs, { ...b, id }]);
        window.setTimeout(() => setBanners((bs) => bs.filter((x) => x.id !== id)), 1900);
      }, delay);
    for (const { event: e } of fresh) {
      switch (e.kind) {
        case 'BATTLE':
          setBattle(e);
          sound.play('attack');
          break;
        case 'CAPTURE': {
          const id = `${game.tick}-${e.region}`;
          later(() => {
            setFx((f) => [...f, { id, kind: 'ripple', region: e.region, color: FACTIONS[e.by].color }]);
            sound.play('kill');
          }, 450);
          later(() => setFx((f) => f.filter((x) => x.id !== id)), 1700);
          break;
        }
        case 'STRIKE': {
          const id = `${game.tick}-strike`;
          setFx((f) => [...f, { id, kind: 'blast', region: e.region, color: '#fff' }]);
          sound.play('attack');
          later(() => setFx((f) => f.filter((x) => x.id !== id)), 1100);
          break;
        }
        case 'SECTOR':
          banner({ title: 'Sector Secured', sub: `${FACTIONS[e.by].name} · ${SECTORS[e.sector].name} · +${SECTORS[e.sector].bonus}/turn`, color: FACTIONS[e.by].color }, 600);
          later(() => sound.play('objective'), 600);
          break;
        case 'ELIMINATED':
          banner({ title: `${FACTIONS[e.who].name} Eliminated`, sub: `by the ${FACTIONS[e.by].name}`, color: FACTIONS[e.by].color }, 900);
          break;
        case 'TURN':
          if (e.who === human) {
            banner({ title: 'Your Turn', sub: `Round ${e.round}`, color: FACTIONS[e.who].color });
            sound.play('turn');
          }
          break;
        case 'TRADE':
          banner({ title: `+${e.troops} Troops`, sub: `${FACTIONS[e.who].name} cashes in Asset Cards`, color: FACTIONS[e.who].color });
          break;
        case 'CARD':
          if (e.who === human) setToast(`New Asset Card: ${e.card.asset}`);
          break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.tick]);

  useEffect(() => {
    if (!battle) return;
    // Your own rolls always get time to read; bot rolls follow the speed setting.
    const t = window.setTimeout(() => setBattle(null), battle.attacker === human ? 2400 : 1500 / speed);
    return () => clearTimeout(t);
  }, [battle, human, speed]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- bot loop ----
  useEffect(() => {
    if (over || myTurn) return;
    const action = botAction(game, level);
    const lastEvent = game.events[game.events.length - 1];
    const justFought = lastEvent?.tick === game.tick && (lastEvent.event.kind === 'BATTLE' || lastEvent.event.kind === 'CAPTURE' || lastEvent.event.kind === 'ELIMINATED');
    const base = justFought ? 1250 : action.type === 'PLACE' ? 500 : action.type === 'ATTACK' || action.type === 'STRIKE' ? 450 : action.type === 'TRADE' ? 800 : 350;
    const t = window.setTimeout(() => setGame((g) => (g === game ? apply(g, action) : g)), base / speed);
    return () => clearTimeout(t);
  }, [game, myTurn, over, level, speed]);

  // Keep selections valid as the board changes under them.
  useEffect(() => {
    if (!myTurn) setSel({});
  }, [myTurn]);

  const dispatch = useCallback(
    (action: Action) => {
      try {
        const next = apply(game, action);
        setGame(next);
        return next;
      } catch (e) {
        if (e instanceof IllegalAction) setToast(e.message);
        else throw e;
        return null;
      }
    },
    [game],
  );

  // ---- derived view state ----
  const options = useMemo(() => (myTurn && sel.from && game.phase === 'ASSAULT' ? attackOptions(game, sel.from) : []), [game, sel.from, myTurn]);
  const redeployTargets = useMemo(
    () => (myTurn && sel.from && game.phase === 'REDEPLOY' && game.map[sel.from].troops > 1 ? connectedOwned(game, sel.from) : []),
    [game, sel.from, myTurn],
  );
  const placing = myTurn && !game.pendingMove && (game.phase === 'MOBILISE' || game.reserve > 0);

  const highlights = useMemo(() => {
    const h: Record<string, Highlight> = {};
    if (!myTurn || game.pendingMove) return h;
    if (placing) {
      for (const r of regionsOf(game, me)) h[r] = 'place';
      return h;
    }
    if (sel.striking) {
      for (const r of BOARD.regions) if (game.map[r.id].owner !== me && game.map[r.id].troops > 1) h[r.id] = 'strike';
      return h;
    }
    if (sel.from) h[sel.from] = 'source';
    for (const o of options) h[o.to] = o.mode === 'LAND' ? 'attack' : 'amphibious';
    for (const r of redeployTargets) h[r] = 'friendly';
    return h;
  }, [game, myTurn, placing, sel, options, redeployTargets, me]);

  const arrow: Arrow | null = battle
    ? { from: battle.from, to: battle.to, color: FACTIONS[battle.attacker].color }
    : sel.from && sel.to
      ? { from: sel.from, to: sel.to, color: game.phase === 'REDEPLOY' ? '#ffffff' : '#ffd23f' }
      : game.pendingMove
        ? { from: game.pendingMove.from, to: game.pendingMove.to, color: '#ffffff' }
        : null;

  // Seed the slider whenever a new move/redeploy opens.
  useEffect(() => {
    if (game.pendingMove) setCount(game.pendingMove.max);
  }, [game.pendingMove?.from, game.pendingMove?.to]);
  useEffect(() => {
    if (game.phase === 'REDEPLOY' && sel.from && sel.to) setCount(game.map[sel.from].troops - 1);
  }, [sel.from, sel.to]);

  const onRegion = (id: string) => {
    if (!myTurn || game.pendingMove) return;
    const h = game.map[id];
    if (placing) {
      if (h.owner !== me) return setToast('Place troops on your own regions.');
      const n = amount === 'all' ? game.reserve : amount;
      dispatch({ type: 'PLACE', region: id, count: n });
      sound.play('ui');
      return;
    }
    if (game.phase === 'ASSAULT') {
      if (sel.striking) {
        if (h.owner !== me && dispatch({ type: 'STRIKE', region: id })) setSel({});
        return;
      }
      if (sel.from && options.some((o) => o.to === id)) return setSel({ from: sel.from, to: id });
      if (h.owner === me && h.troops >= 2) return setSel({ from: id });
      if (h.owner === me) setToast('Need at least 2 troops to attack from there.');
      return setSel({});
    }
    if (game.phase === 'REDEPLOY') {
      if (sel.from && redeployTargets.includes(id)) return setSel({ from: sel.from, to: id });
      if (h.owner === me && h.troops >= 2) return setSel({ from: id });
      return setSel({});
    }
  };

  const attack = (blitz: boolean) => {
    if (!sel.from || !sel.to) return;
    const next = dispatch({ type: 'ATTACK', from: sel.from, to: sel.to, blitz });
    if (!next) return;
    // Stay on the same target while it's still a fight; follow the advance after a capture.
    if (next.map[sel.to].owner === me) setSel(next.pendingMove ? {} : { from: sel.to });
    else if (next.map[sel.from].troops < 2) setSel({});
  };

  // Keyboard: Enter/Space = the primary action of the moment, Esc = clear selection.
  const primaryRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSel({});
      // A focused button already handles its own Enter; don't fire twice.
      if (e.key === 'Enter' && myTurn && !(e.target as HTMLElement).closest?.('button')) primaryRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [myTurn]);

  const meP = human ? player(game, human) : null;

  return (
    <div className="io-game">
      <div className="io-map-wrap">
        <MapView holdings={game.map} highlights={highlights} dimOthers={Object.keys(highlights).length > 0} fx={fx} arrow={arrow} onRegion={onRegion} />
      </div>

      <TopBar game={game} human={human} speed={speed} setSpeed={setSpeed} onExit={onExit} onLog={() => setLogOpen((v) => !v)} />

      {meP && <OpsOrder game={game} human={human!} />}

      {logOpen && <LogPanel game={game} onClose={() => setLogOpen(false)} />}

      {battle && (
        <div className="io-dice-anchor">
          <DiceTray battle={battle} compact={battle.attacker !== human} />
        </div>
      )}

      <div className="io-banners">
        {banners.map((b) => (
          <div key={b.id} className="io-banner" style={{ ['--c' as string]: b.color }}>
            <div className="io-banner-title">{b.title}</div>
            {b.sub && <div className="io-banner-sub">{b.sub}</div>}
          </div>
        ))}
      </div>

      {toast && <div className="io-toast">{toast}</div>}

      {!over && (
        <CommandPanel
          game={game}
          human={human}
          myTurn={myTurn}
          sel={sel}
          setSel={setSel}
          amount={amount}
          setAmount={setAmount}
          count={count}
          setCount={setCount}
          dispatch={dispatch}
          attack={attack}
          openHand={() => setHandOpen(true)}
          primaryRef={primaryRef}
        />
      )}

      {handOpen && meP && (
        <HandDrawer
          cards={meP.cards}
          faction={human!}
          tradesDone={game.tradesDone}
          canTrade={myTurn && (game.phase === 'MOBILISE' || meP.cards.length > MAX_HAND)}
          onTrade={(ids) => {
            if (dispatch({ type: 'TRADE', cardIds: ids }) && meP.cards.length - 3 < 3) setHandOpen(false);
          }}
          onClose={() => setHandOpen(false)}
        />
      )}

      {over && <Victory game={game} human={human} onRestart={onRestart} onExit={onExit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ game, human, speed, setSpeed, onExit, onLog }: { game: GameState; human: FactionId | null; speed: Speed; setSpeed: (s: Speed) => void; onExit: () => void; onLog: () => void }) {
  const turn = current(game);
  return (
    <div className="io-topbar">
      <div className="io-logo-mini">
        COMMAND<span>ISLAND OPS</span>
      </div>
      <div className="io-players">
        {game.order.map((f) => {
          const p = player(game, f);
          const fac = FACTIONS[f];
          return (
            <div
              key={f}
              className={`io-player${f === turn && !game.winner ? ' io-player-active' : ''}${!p.alive ? ' io-player-dead' : ''}`}
              style={{ ['--c' as string]: fac.color, ['--d' as string]: fac.deep }}
            >
              <span className="io-player-emblem">
                <Emblem faction={f} size={18} color="#fff" />
              </span>
              <span className="io-player-text">
                <b>
                  {fac.short}
                  {f === human && <em> YOU</em>}
                </b>
                <small>
                  {regionsOf(game, f).length} regions · {troopsOf(game, f)} troops · {p.cards.length} cards
                </small>
              </span>
            </div>
          );
        })}
      </div>
      <div className="io-top-right">
        <span className="io-round">Round {game.round}</span>
        <button className="io-chip-btn" onClick={() => setSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1)} title="Bot speed">
          ⏩ {speed}×
        </button>
        <button className="io-chip-btn" onClick={onLog}>
          Log
        </button>
        <button className="io-chip-btn" onClick={onExit}>
          Exit
        </button>
      </div>
    </div>
  );
}

function OpsOrder({ game, human }: { game: GameState; human: FactionId }) {
  const p = player(game, human);
  const prog = missionProgress(game, human);
  return (
    <div className="io-ops" style={{ ['--c' as string]: FACTIONS[human].color }}>
      <div className="io-ops-kicker">Your Ops Order</div>
      <div className="io-ops-text">{p.mission.text}</div>
      <div className="io-ops-progress">{prog.text}</div>
      <div className="io-ops-alt">…or be the last force standing.</div>
    </div>
  );
}

function LogPanel({ game, onClose }: { game: GameState; onClose: () => void }) {
  const items = game.log.slice(-40).reverse();
  return (
    <div className="io-log">
      <div className="io-log-head">
        <b>Ops Log</b>
        <button className="io-icon-btn" onClick={onClose} aria-label="Close log">
          ✕
        </button>
      </div>
      <div className="io-log-items">
        {items.map((l, i) => (
          <div key={i} className="io-log-item" style={{ borderColor: l.who ? FACTIONS[l.who].color : '#888' }}>
            <small>R{l.round}</small> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Encik's advice for the moment — concrete where it can be. */
function advice(game: GameState, me: FactionId): string {
  if (game.phase === 'MOBILISE') {
    for (const sec of SECTOR_IDS) {
      const missing = regionsInSector(sec).filter((r) => game.map[r].owner !== me);
      if (missing.length === 1)
        return `One region from the ${SECTORS[sec].name}! Take ${BOARD.byId[missing[0]].name} and it pays +${SECTORS[sec].bonus} troops every turn. Stack troops next to it.`;
    }
    return 'Don’t spread thin, recruit. Pile your troops on one border and punch through — that’s how sectors fall.';
  }
  if (game.phase === 'ASSAULT') {
    if (me === 'AIRFORCE' && canStrike(game)) return 'Soften them up first — your Precision Strike is ready. Then hit where they’re weakest.';
    if (me === 'NAVY') return 'Blue targets across the water are Amphibious Assaults — any coast is your front line.';
    return 'Attack with more troops than they have. Capture at least one region this turn to earn an Asset Card.';
  }
  return 'Pull idle troops off quiet regions and up to the front. One redeploy, then your turn ends.';
}

interface PanelProps {
  game: GameState;
  human: FactionId | null;
  myTurn: boolean;
  sel: Selection;
  setSel: (s: Selection) => void;
  amount: Amount;
  setAmount: (a: Amount) => void;
  count: number;
  setCount: (n: number) => void;
  dispatch: (a: Action) => GameState | null;
  attack: (blitz: boolean) => void;
  openHand: () => void;
  primaryRef: React.MutableRefObject<() => void>;
}

function CommandPanel({ game, human, myTurn, sel, setSel, amount, setAmount, count, setCount, dispatch, attack, openHand, primaryRef }: PanelProps) {
  const me = current(game);
  const fac = FACTIONS[me];

  if (!myTurn) {
    primaryRef.current = () => {};
    if (human && !player(game, human).alive)
      return (
        <div className="io-panel io-panel-wait" style={{ ['--c' as string]: FACTIONS[human].color }}>
          <span>
            <b>You have been eliminated.</b> Watching the rest of the exercise…
          </span>
        </div>
      );
    return (
      <div className="io-panel io-panel-wait" style={{ ['--c' as string]: fac.color }}>
        <span className="io-player-emblem">
          <Emblem faction={me} size={20} color="#fff" />
        </span>
        <span>
          <b>{fac.name}</b> is {game.phase === 'MOBILISE' ? 'mobilising' : game.phase === 'ASSAULT' ? 'on the attack' : 'redeploying'}…
        </span>
      </div>
    );
  }

  const p = player(game, me);
  const phases = ['MOBILISE', 'ASSAULT', 'REDEPLOY'] as const;
  const stepper = (
    <div className="io-steps">
      {phases.map((ph, i) => (
        <span key={ph} className={`io-step${game.phase === ph ? ' io-step-on' : ''}${phases.indexOf(game.phase as (typeof phases)[number]) > i ? ' io-step-done' : ''}`}>
          {i + 1}. {ph[0] + ph.slice(1).toLowerCase()}
        </span>
      ))}
    </div>
  );
  const cardsBtn = (
    <button className={`io-btn io-btn-cards${p.cards.length >= 3 ? ' io-pulse' : ''}`} onClick={openHand}>
      Cards <b>{p.cards.length}</b>
    </button>
  );

  let body: React.ReactNode;
  let primary: { label: string; run: () => void; disabled?: boolean } | null = null;

  if (game.pendingMove) {
    const pm = game.pendingMove;
    primary = { label: `Move ${count} in`, run: () => dispatch({ type: 'MOVE_IN', count }) };
    body = (
      <div className="io-slider-row">
        <span>
          Advance into <b>{BOARD.byId[pm.to].name}</b>
        </span>
        <input type="range" min={pm.min} max={pm.max} value={count} onChange={(e) => setCount(Number(e.target.value))} />
        <span className="io-count">{count}</span>
      </div>
    );
  } else if (game.phase === 'MOBILISE' || game.reserve > 0) {
    const rf = reinforcement(game, me);
    const mustTrade = p.cards.length >= MAX_HAND;
    primary = {
      label: game.reserve > 0 ? `Place ${game.reserve} more` : mustTrade ? 'Trade cards first' : 'Begin Assault →',
      run: () => (mustTrade ? openHand() : dispatch({ type: 'END_MOBILISE' })),
      disabled: game.reserve > 0,
    };
    body = (
      <div className="io-mob">
        <div className="io-reserve">
          <span className="io-reserve-num">{game.reserve}</span>
          <span className="io-reserve-label">
            troops to place
            <small>
              base {rf.base}
              {rf.sectors.map((x) => ` · ${SECTORS[x.sector].name.replace(' Sector', '')} +${x.bonus}`)}
              {rf.faction ? ` · Call-Up +${rf.faction}` : ''}
            </small>
          </span>
        </div>
        <div className="io-seg" role="group" aria-label="Troops per tap">
          {([1, 5, 'all'] as Amount[]).map((a) => (
            <button key={a} className={amount === a ? 'on' : ''} onClick={() => setAmount(a)}>
              {a === 'all' ? 'All' : `+${a}`}
            </button>
          ))}
        </div>
        {cardsBtn}
      </div>
    );
  } else if (game.phase === 'ASSAULT') {
    primary = { label: 'End Assault →', run: () => (setSel({}), dispatch({ type: 'END_ASSAULT' })) };
    if (sel.from && sel.to) {
      const a = game.map[sel.from].troops, d = game.map[sel.to].troops;
      const mode = attackOptions(game, sel.from).find((o) => o.to === sel.to)?.mode;
      const dice = Math.min(3, a - 1);
      primary = { label: 'Roll Dice', run: () => attack(false) };
      body = (
        <div className="io-attack">
          <div className="io-attack-matchup">
            <b>{BOARD.byId[sel.from].name}</b> <span className="io-n">{a}</span>
            <span className="io-vs">{mode === 'AMPHIBIOUS' ? '⚓' : '⚔'}</span>
            <span className="io-n io-n-enemy" style={{ background: FACTIONS[game.map[sel.to].owner].color }}>
              {d}
            </span>{' '}
            <b>{BOARD.byId[sel.to].name}</b>
          </div>
          <small>
            You roll {dice} · they roll {Math.min(2, d)}
            {BOARD.byId[sel.to].stronghold ? ' · stronghold: +1 on their best die' : ''}
          </small>
          <button className="io-btn io-btn-blitz" onClick={() => attack(true)}>
            ⚡ Blitz
          </button>
          <button className="io-btn io-btn-ghost" onClick={() => setSel({})}>
            Cancel
          </button>
        </div>
      );
    } else {
      body = (
        <div className="io-hint-row">
          <span className="io-hint">{sel.striking ? 'Pick an enemy region to strike.' : sel.from ? 'Pick a highlighted target.' : 'Pick one of your regions (2+ troops) to attack from.'}</span>
          {me === 'AIRFORCE' && (
            <button className={`io-btn io-btn-power${sel.striking ? ' on' : ''}`} disabled={!canStrike(game)} onClick={() => setSel(sel.striking ? {} : { striking: true })}>
              ✈ Precision Strike{p.powerUsed ? ' (used)' : ''}
            </button>
          )}
          {cardsBtn}
        </div>
      );
    }
  } else {
    primary = { label: 'End Turn', run: () => (setSel({}), dispatch({ type: 'END_TURN' })) };
    if (sel.from && sel.to) {
      const max = game.map[sel.from].troops - 1;
      primary = { label: `Redeploy ${count} & End Turn`, run: () => (setSel({}), dispatch({ type: 'REDEPLOY', from: sel.from!, to: sel.to!, count })) };
      body = (
        <div className="io-slider-row">
          <span>
            {BOARD.byId[sel.from].name} → <b>{BOARD.byId[sel.to].name}</b>
          </span>
          <input type="range" min={1} max={max} value={Math.min(count, max)} onChange={(e) => setCount(Number(e.target.value))} />
          <span className="io-count">{Math.min(count, max)}</span>
        </div>
      );
    } else body = <span className="io-hint">{sel.from ? 'Pick a connected region of yours.' : 'Pick a region to move troops from — or just end your turn.'}</span>;
  }

  primaryRef.current = () => primary && !primary.disabled && primary.run();

  return (
    <div className="io-panel-wrap">
      <div className="io-encik">
        <div className="io-encik-face" aria-hidden="true">
          <svg viewBox="0 0 40 40">
            <circle cx="20" cy="22" r="13" fill="#e8b98a" />
            <path d="M6 17 Q8 4 22 5 Q35 6 34 15 L34 17Z" fill="#7a1f1f" />
            <circle cx="28" cy="10" r="2.5" fill="#f2c94c" />
            <rect x="13" y="21" width="5" height="2.2" rx="1" fill="#2b1d12" />
            <rect x="22" y="21" width="5" height="2.2" rx="1" fill="#2b1d12" />
            <path d="M15 29 Q20 27 25 29" stroke="#2b1d12" strokeWidth="1.8" fill="none" />
          </svg>
        </div>
        <div className="io-encik-text">
          <b>Encik says</b>
          {advice(game, me)}
        </div>
      </div>
      <div className="io-panel" style={{ ['--c' as string]: fac.color }}>
        {stepper}
        <div className="io-panel-body">
          {body}
          {primary && (
            <button className="io-btn io-btn-primary io-btn-main" disabled={primary.disabled} onClick={primary.run}>
              {primary.label}
              <kbd>Enter</kbd>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Victory({ game, human, onRestart, onExit }: { game: GameState; human: FactionId | null; onRestart: () => void; onExit: () => void }) {
  const w = game.winner!;
  const won = w === human;
  const fac = FACTIONS[w];
  return (
    <div className="io-modal-backdrop">
      <div className="io-victory" style={{ ['--c' as string]: fac.color, ['--d' as string]: fac.deep }}>
        <div className="io-victory-emblem">
          <Emblem faction={w} size={64} color="#fff" />
        </div>
        <h1>{won ? 'Victory!' : 'Defeat'}</h1>
        <p className="io-victory-who">
          {won ? 'The island is yours, Commander.' : `The ${fac.name} takes the exercise.`}
        </p>
        <p className="io-victory-reason">{game.winReason}</p>
        <div className="io-victory-stats">
          <span>
            <b>{game.round}</b> rounds
          </span>
          <span>
            <b>{game.stats.captures}</b> captures
          </span>
          <span>
            <b>{game.stats.attacks}</b> dice rolls
          </span>
        </div>
        <div className="io-victory-actions">
          <button className="io-btn io-btn-primary" onClick={onRestart}>
            Play Again
          </button>
          <button className="io-btn io-btn-ghost" onClick={onExit}>
            Main Menu
          </button>
        </div>
      </div>
    </div>
  );
}
