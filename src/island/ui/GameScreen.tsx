// ============================================================================
// The match. Each round: plan in secret (deploy, march, land, sail, fly,
// recon) → Ready → every Pasukan's orders resolve together → watch the
// playback, battle by battle → round report → plan again.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { sound } from '../../audio/sound';
import { BOARD, INSTALLATIONS, INSTALLATION_INFO, REGION_IDS, SEA_ZONES, ZoneId } from '../map';
import {
  IllegalAction, alive, defenceBonus, installationsOf, player, recon, regionsOf, resolveRound, sharedZones, shipCapacity, submitOrders, validateOrders, viewFor,
} from '../engine';
import { BotLevel, planBot } from '../bot';
import { FACTIONS, FactionId, GameState, MAX_ROUNDS, Order, PlayerView, ReportStep, RoundReport, Side, VP_TARGET } from '../types';
import { Emblem } from './Glyphs';
import { Badge, Fx, Highlight, MapView, Marker, OrderArrow } from './MapView';

type Tool = 'deploy' | 'move' | 'strike' | 'cas' | 'recon';
type Amount = 1 | 5 | 'all';

interface Picker {
  from: string;
  to: string;
  zone: ZoneId | null;
  max: number;
  count: number;
}

interface Playback {
  report: RoundReport;
  before: GameState;
  after: GameState;
  index: number;
  overrides: Record<string, Badge>;
  arrows: OrderArrow[];
  card: ReportStep | null;
  naval: ZoneId | null;
}

interface ReportLine {
  color: string;
  text: string;
}

const STEP_MS: Partial<Record<ReportStep['kind'], number>> = {
  NAVAL: 1700, STRIKE: 650, MOVES: 1900, FAILED: 1200, CLASH: 1500, BATTLE: 1900, RECOMMISSION: 700, SCORE: 1900, ELIMINATED: 1600, VICTORY: 600,
};

function intelText(v: PlayerView['map'][string]): { text: string; fog: boolean } {
  if (v.intel.kind === 'exact') return { text: String(v.intel.troops), fog: false };
  if (v.intel.kind === 'band') return { text: v.intel.max >= 99 ? `${v.intel.min}+` : `${v.intel.min}–${v.intel.max}`, fog: true };
  return { text: '?', fog: true };
}

function sideText(sd: Side) {
  const bonus = sd.bonuses.reduce((n, b) => n + b.n, 0);
  return `${sd.troops} troops${bonus ? ` +${bonus}` : ''}`;
}

/** What the round meant for you, in a few lines. */
function reportLines(report: RoundReport, me: FactionId): ReportLine[] {
  const lines: ReportLine[] = [];
  const name = (id: string) => BOARD.byId[id].name;
  for (const st of report.steps) {
    if (st.kind === 'BATTLE') {
      const mineAttacking = st.attackers.some((a) => a.owner === me);
      const mineDefending = st.defender?.owner === me;
      if (!mineAttacking && !mineDefending) continue;
      if (st.captured && st.winner === me)
        lines.push({ color: FACTIONS[me].color, text: `Captured ${name(st.region)} — ${st.attackers.find((a) => a.owner === me)!.units[0]} moves in with ${st.survivors}.` });
      else if (st.captured && mineDefending) lines.push({ color: '#ff5a4e', text: `Lost ${name(st.region)} to ${FACTIONS[st.winner].name}.` });
      else if (mineDefending) lines.push({ color: FACTIONS[me].color, text: `Held ${name(st.region)} against ${st.attackers.map((a) => FACTIONS[a.owner].short).join(' & ')}.` });
      else lines.push({ color: '#ffb35c', text: `Attack on ${name(st.region)} beaten back by ${FACTIONS[st.winner].name}.` });
    } else if (st.kind === 'NAVAL' && st.sides.some((x) => x.owner === me)) {
      lines.push({ color: '#8fd6ff', text: `Naval battle in the ${SEA_ZONES[st.zone].name}: ${st.winner === me ? 'your fleet wins' : st.winner ? `${FACTIONS[st.winner].name} wins` : 'both fleets mauled'}.` });
    } else if (st.kind === 'FAILED' && st.owner === me) lines.push({ color: '#ffb35c', text: st.text });
    else if (st.kind === 'CLASH' && (st.a.owner === me || st.b.owner === me))
      lines.push({ color: '#ffb35c', text: `Columns clashed between ${name(st.at[0])} and ${name(st.at[1])}: ${st.winner === me ? 'yours pushed through' : st.winner ? 'yours were broken' : 'both shattered'}.` });
    else if (st.kind === 'SCORE' && st.gains[me]) lines.push({ color: '#ffc83d', text: `+${st.gains[me]} victory points from installations held.` });
    else if (st.kind === 'ELIMINATED') lines.push({ color: FACTIONS[st.who].color, text: `${FACTIONS[st.who].name} has been wiped off the island.` });
  }
  if (!lines.length) lines.push({ color: '#a8c0d6', text: 'A quiet round on your front.' });
  return lines;
}

export function GameScreen({ initial, level, onExit, onRestart }: { initial: GameState; level: BotLevel; onExit: () => void; onRestart: () => void }) {
  const [game, setGame] = useState(initial);
  const [draft, setDraft] = useState<Order[]>([]);
  const [tool, setTool] = useState<Tool>('deploy');
  const [amount, setAmount] = useState<Amount>(1);
  const [from, setFrom] = useState<string | null>(null);
  const [selShip, setSelShip] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [fx, setFx] = useState<Fx[]>([]);
  const [report, setReport] = useState<{ round: number; lines: ReportLine[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [banners, setBanners] = useState<{ id: number; title: string; sub?: string; color: string }[]>([]);
  const [shake, setShake] = useState(0);
  const banner = useCallback((title: string, color: string, sub?: string) => {
    const id = Math.random();
    setBanners((bs) => [...bs, { id, title, sub, color }]);
    window.setTimeout(() => setBanners((bs) => bs.filter((b) => b.id !== id)), 1900);
  }, []);
  const me = game.factions.find((f) => player(game, f).human)!;
  const view = useMemo(() => viewFor(game, me), [game, me]);
  const over = game.phase === 'GAME_OVER' && !playback;
  const planning = !playback && game.phase === 'PLANNING' && player(game, me).alive;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- the plan so far ----
  const deployed = useMemo(() => {
    const d: Record<string, number> = {};
    for (const o of draft) if (o.kind === 'DEPLOY') d[o.region] = (d[o.region] ?? 0) + o.count;
    return d;
  }, [draft]);
  const deployLeft = view.budget.troops - Object.values(deployed).reduce((a, b) => a + b, 0);
  const sortiesLeft = view.budget.sorties - draft.filter((o) => o.kind === 'STRIKE' || o.kind === 'CAS').length;
  const committed = (r: string, except?: Order) =>
    draft.reduce((n, o) => n + ((o.kind === 'MOVE' || o.kind === 'LAND') && o.from === r && o !== except ? o.count : 0), 0);
  const available = (r: string, except?: Order) => (game.map[r].owner === me ? game.map[r].troops + (deployed[r] ?? 0) - committed(r, except) - 1 : 0);
  const shipZoneAfter = (shipId: string) => {
    const sail = draft.find((o) => o.kind === 'SAIL' && o.ship === shipId) as Extract<Order, { kind: 'SAIL' }> | undefined;
    return sail ? sail.to : game.ships.find((sh) => sh.id === shipId)?.zone ?? null;
  };
  const myShipsIn = (z: ZoneId) => game.ships.filter((sh) => sh.owner === me && sh.zone && shipZoneAfter(sh.id) === z).length;
  const lifted = (z: ZoneId, except?: Order) => draft.reduce((n, o) => n + (o.kind === 'LAND' && o.zone === z && o !== except ? o.count : 0), 0);

  // ---- planning actions ----
  const addDeploy = (region: string) => {
    if (deployLeft <= 0) return setToast('Every new troop is placed — Undo or Clear to change.');
    const n = amount === 'all' ? deployLeft : Math.min(amount, deployLeft);
    setDraft((d) => [...d, { kind: 'DEPLOY', region, count: n }]);
    sound.play('ui');
  };

  const openPicker = (a: string, b: string) => {
    if (game.map[a].owner !== me) return;
    const existing = draft.find((o): o is Extract<Order, { kind: 'MOVE' | 'LAND' }> => (o.kind === 'MOVE' || o.kind === 'LAND') && o.from === a && o.to === b);
    if (BOARD.byId[a].neighbours.includes(b)) {
      const max = available(a, existing);
      if (max <= 0) return setToast(`${BOARD.byId[a].name} has no troops to spare — every region keeps one.`);
      return setPicker({ from: a, to: b, zone: null, max, count: existing ? existing.count : max });
    }
    const shared = sharedZones(a, b);
    const zones = shared.filter((z) => myShipsIn(z) > 0);
    if (!zones.length) {
      return setToast(
        shared.length
          ? `To land at ${BOARD.byId[b].name}, get a ship into the ${SEA_ZONES[shared[0]].name} first.`
          : `${BOARD.byId[b].name} isn't next to ${BOARD.byId[a].name}, and no sea zone links them.`,
      );
    }
    const zone = zones[0];
    const capacity = myShipsIn(zone) * shipCapacity(me) - lifted(zone, existing);
    const max = Math.min(available(a, existing), capacity);
    if (max <= 0) return setToast(capacity <= 0 ? `Your ships in the ${SEA_ZONES[zone].name} are full.` : `${BOARD.byId[a].name} has no troops to spare.`);
    setPicker({ from: a, to: b, zone, max, count: existing ? Math.min(existing.count, max) : max });
  };

  const confirmPicker = () => {
    if (!picker) return;
    const { from: a, to: b, zone, count } = picker;
    setDraft((d) => {
      const rest = d.filter((o) => !((o.kind === 'MOVE' || o.kind === 'LAND') && o.from === a && o.to === b));
      if (count <= 0) return rest;
      const order: Order = zone ? { kind: 'LAND', from: a, to: b, zone, count } : { kind: 'MOVE', from: a, to: b, count };
      return [...rest, order];
    });
    setPicker(null);
    setFrom(null);
    sound.play('ui');
  };

  const toggleAir = (kind: 'STRIKE' | 'CAS', region: string) => {
    const existing = draft.find((o) => o.kind === kind && o.region === region);
    if (existing) return setDraft((d) => d.filter((o) => o !== existing));
    if (sortiesLeft <= 0) return setToast('No air sorties left this round.');
    if (kind === 'STRIKE' && game.map[region].owner === me) return setToast("Don't bomb your own ground.");
    setDraft((d) => [...d, { kind, region }]);
    sound.play('ui');
  };

  const doRecon = (region: string) => {
    if (game.map[region].owner === me) return setToast('Recon enemy ground — you know your own.');
    try {
      setGame(recon(game, me, region));
      setToast(`Recon: ${BOARD.byId[region].name} and its neighbours revealed for this round.`);
      sound.play('contact');
    } catch (e) {
      if (e instanceof IllegalAction) setToast(e.message);
      else throw e;
    }
  };

  const onRegion = (id: string) => {
    if (!planning) return;
    if (tool === 'deploy') {
      if (game.map[id].owner !== me) return setToast('Deploy on your own ground.');
      return addDeploy(id);
    }
    if (tool === 'strike' || tool === 'cas') return toggleAir(tool === 'strike' ? 'STRIKE' : 'CAS', id);
    if (tool === 'recon') return doRecon(id);
    if (from && from !== id) return openPicker(from, id);
    if (game.map[id].owner === me) setFrom(from === id ? null : id);
  };

  const onShip = (id: string) => {
    if (!planning) return;
    const ship = game.ships.find((sh) => sh.id === id)!;
    if (ship.owner !== me) return setToast(`${ship.name} — ${FACTIONS[ship.owner].name}.`);
    setSelShip(selShip === id ? null : id);
  };

  const onZone = (z: ZoneId) => {
    if (!planning || !selShip) return;
    const ship = game.ships.find((sh) => sh.id === selShip)!;
    if (z !== ship.zone && !(ship.zone && SEA_ZONES[ship.zone].neighbours.includes(z))) return setToast('Ships sail one zone at a time.');
    setDraft((d) => {
      const rest = d.filter((o) => !(o.kind === 'SAIL' && o.ship === selShip));
      return z === ship.zone ? rest : [...rest, { kind: 'SAIL', ship: selShip, to: z }];
    });
    setSelShip(null);
  };

  const drag = {
    canStart: (id: string) => planning && game.map[id].owner === me && available(id) > 0,
    drop: (a: string, b: string) => {
      setTool('move');
      openPicker(a, b);
    },
  };

  // ---- Ready: submit, let the bots plan, resolve, play it back ----
  const ready = () => {
    if (!planning) return;
    const err = validateOrders(game, me, draft);
    if (err) return setToast(err);
    let s = submitOrders(game, me, draft);
    for (const f of alive(s)) {
      if (f === me) continue;
      const orders = planBot(
        () => viewFor(s, f),
        (r) => (s = recon(s, f, r)),
        level,
      );
      s = submitOrders(s, f, orders);
    }
    const { state, report: rep } = resolveRound(s);
    setDraft([]);
    setFrom(null);
    setSelShip(null);
    setReport(null);
    sound.play('turn');
    banner('Orders in — Execute!', FACTIONS[me].color, `Round ${rep.round}: every Pasukan moves at once`);
    setPlayback({ report: rep, before: s, after: state, index: -1, overrides: {}, arrows: [], card: null, naval: null });
  };

  // ---- playback director ----
  const finishPlayback = useCallback(
    (pb: Playback) => {
      const lost = REGION_IDS.filter((r) => pb.before.map[r].owner === me && pb.after.map[r].owner !== me);
      setGame(pb.after);
      setPlayback(null);
      setReport({ round: pb.report.round, lines: reportLines(pb.report, me) });
      setTool('deploy');
      if (pb.after.phase !== 'GAME_OVER') window.setTimeout(() => banner(`Round ${pb.after.round}`, FACTIONS[me].color, 'Plan your orders'), 200);
      if (lost.length) {
        const ids = lost.map((r) => `lost-${pb.report.round}-${r}`);
        setFx((f) => [...f, ...lost.map((region, i) => ({ id: ids[i], kind: 'alert' as const, region, color: '#ff5a4e' }))]);
        window.setTimeout(() => setFx((f) => f.filter((x) => !ids.includes(x.id))), 5000);
      }
    },
    [me],
  );

  useEffect(() => {
    if (!playback) return;
    const steps = playback.report.steps;
    const next = playback.index + 1;
    if (next >= steps.length) {
      const t = window.setTimeout(() => finishPlayback(playback), 400);
      return () => clearTimeout(t);
    }
    const step = steps[next];
    const delay = playback.index < 0 ? 500 : STEP_MS[steps[playback.index].kind] ?? 800;
    const t = window.setTimeout(() => {
      let arrows = playback.arrows;
      let naval: ZoneId | null = null;
      let card: ReportStep | null = null;
      switch (step.kind) {
        case 'NAVAL':
          naval = step.zone;
          card = step;
          sound.play('attack');
          break;
        case 'STRIKE': {
          // The jet comes in first; the bombs land as it passes over.
          const jet = `jet-${next}`, id = `strike-${next}`;
          setFx((f) => [...f, { id: jet, kind: 'jet', region: step.region, color: FACTIONS[step.by].color }]);
          window.setTimeout(() => {
            setFx((f) => [...f.filter((x) => x.id !== jet), { id, kind: 'blast', region: step.region, color: '#fff' }]);
            sound.play('attack');
          }, 480);
          window.setTimeout(() => setFx((f) => f.filter((x) => x.id !== id)), 1500);
          break;
        }
        case 'MOVES':
          arrows = step.moves.map((m, i) => ({
            id: `mv-${i}`,
            from: m.from,
            to: m.to,
            color: FACTIONS[m.owner].color,
            label: String(m.count),
            via: m.landing ? sharedZones(m.from, m.to)[0] : undefined,
            travel: true,
          }));
          sound.play('move');
          break;
        case 'BATTLE':
          card = step;
          // Reveal the result on the map once the card has had a moment.
          window.setTimeout(() => {
            setPlayback((p2) => (p2 ? { ...p2, overrides: { ...p2.overrides, [step.region]: { owner: step.winner, text: String(step.survivors), fog: false } } } : p2));
            const boom = `boom-${next}`;
            setFx((f) => [...f, { id: boom, kind: 'blast', region: step.region, color: '#fff' }]);
            window.setTimeout(() => setFx((f) => f.filter((x) => x.id !== boom)), 900);
            const mine = step.defender?.owner === me || step.attackers.some((a) => a.owner === me);
            if (mine) setShake((n) => n + 1);
            if (step.captured) {
              const id = `cap-${next}`;
              setFx((f) => [...f, { id, kind: 'ripple', region: step.region, color: FACTIONS[step.winner].color }]);
              window.setTimeout(() => setFx((f) => f.filter((x) => x.id !== id)), 1300);
              sound.play('kill');
              const ki = INSTALLATIONS[step.region];
              if (ki && step.winner === me) banner(`★ ${BOARD.byId[step.region].name} secured`, FACTIONS[me].color, INSTALLATION_INFO[ki].label);
              else if (ki && step.defender?.owner === me) banner(`${BOARD.byId[step.region].name} lost`, '#d9452f', `to ${FACTIONS[step.winner].name}`);
            }
          }, 850);
          sound.play('attack');
          break;
        default:
          card = step;
          if (step.kind === 'SCORE') sound.play('objective');
          if (step.kind === 'ELIMINATED') banner(`${FACTIONS[step.who].short} wiped out`, FACTIONS[step.who].color);
      }
      setPlayback((pb) => (pb ? { ...pb, index: next, arrows, card, naval } : pb));
    }, delay);
    return () => clearTimeout(t);
  }, [playback, finishPlayback]);

  // ---- what the map shows ----
  const shownView = useMemo(() => (playback ? viewFor(playback.before, me) : view), [playback?.before, view, me]);
  const badges = useMemo(() => {
    const out: Record<string, Badge> = {};
    for (const r of REGION_IDS) {
      const rv = shownView.map[r];
      const t = intelText(rv);
      out[r] = { owner: rv.owner, text: t.text, fog: t.fog };
      if (!playback && rv.owner === me && deployed[r]) out[r] = { ...out[r], text: String(game.map[r].troops + deployed[r]), extra: `+${deployed[r]}` };
    }
    if (playback) Object.assign(out, playback.overrides);
    return out;
  }, [shownView, playback, deployed, game, me]);

  const myColor = FACTIONS[me].color;
  const arrows: OrderArrow[] = playback
    ? playback.arrows
    : draft.flatMap((o, i): OrderArrow[] => {
        if (o.kind === 'MOVE' || o.kind === 'LAND')
          return [{ id: `o-${i}`, from: o.from, to: o.to, color: myColor, label: String(o.count), via: o.kind === 'LAND' ? o.zone : undefined, onClick: () => openPicker(o.from, o.to) }];
        if (o.kind === 'SAIL') {
          const zone = game.ships.find((sh) => sh.id === o.ship)?.zone;
          return zone ? [{ id: `o-${i}`, from: zone, to: o.to, color: myColor, sail: true }] : [];
        }
        return [];
      });

  const markers: Marker[] = playback
    ? []
    : draft
        .filter((o): o is Extract<Order, { kind: 'STRIKE' | 'CAS' }> => o.kind === 'STRIKE' || o.kind === 'CAS')
        .map((o) => ({ region: o.region, kind: o.kind, color: o.kind === 'STRIKE' ? '#d9452f' : '#2f8fd0' }));

  const highlights: Record<string, Highlight> = {};
  if (planning && !picker) {
    if (tool === 'deploy') for (const r of regionsOf(game, me)) highlights[r] = 'place';
    if (tool === 'strike') for (const r of REGION_IDS) if (game.map[r].owner !== me) highlights[r] = 'strike';
    if (tool === 'recon' && view.reconsLeft > 0) for (const r of REGION_IDS) if (game.map[r].owner !== me) highlights[r] = 'recon';
    if (tool === 'move' && from) {
      highlights[from] = 'source';
      for (const n of BOARD.byId[from].neighbours) highlights[n] = 'target';
      for (const r of REGION_IDS) if (!highlights[r] && r !== from && sharedZones(from, r).some((z) => myShipsIn(z) > 0)) highlights[r] = 'landing';
    }
  }

  const threats =
    playback || !player(game, me).alive
      ? []
      : regionsOf(game, me).filter((r) => {
          const mine = game.map[r].troops + (deployed[r] ?? 0) + defenceBonus(r);
          return BOARD.byId[r].neighbours.some((n) => {
            const iv = view.map[n];
            if (iv.owner === me) return false;
            const est = iv.intel.kind === 'exact' ? iv.intel.troops : iv.intel.kind === 'band' ? iv.intel.max : 0;
            return est > mine;
          });
        });

  // Keyboard: Enter = Ready (or confirm the picker), Esc = cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicker(null);
        setFrom(null);
        setSelShip(null);
      }
      if (e.key !== 'Enter' || (e.target as HTMLElement).closest?.('button')) return;
      if (picker) confirmPicker();
      else if (deployLeft === 0) ready();
    };
    // Mouse clicks shouldn't leave a button holding focus, or Enter would press it again.
    const onClick = (e: MouseEvent) => {
      if (e.detail > 0) (e.target as HTMLElement).closest?.('button')?.blur();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  });

  // Fleets move as soon as the naval phase has played.
  const ships = playback
    ? playback.report.steps.slice(0, playback.index + 1).some((st) => st.kind !== 'NAVAL')
      ? playback.after.ships
      : playback.before.ships
    : game.ships;
  const selZone = selShip ? game.ships.find((s) => s.id === selShip)?.zone : null;

  return (
    <div className={`io-game${shake % 2 ? ' io-shake-a' : shake ? ' io-shake-b' : ''}`}>
      <div className="io-map-wrap">
        <MapView
          badges={badges}
          highlights={highlights}
          dimOthers={Object.keys(highlights).length > 0}
          fx={fx}
          arrows={arrows}
          markers={markers}
          ships={ships}
          selectedShip={selShip}
          zoneHighlights={playback?.naval ? { [playback.naval]: 'battle' } : selZone ? Object.fromEntries(SEA_ZONES[selZone].neighbours.map((z) => [z, 'sail'])) : {}}
          onRegion={planning ? onRegion : undefined}
          onZone={planning ? onZone : undefined}
          onShip={planning ? onShip : undefined}
          threats={threats}
          drag={planning ? drag : undefined}
        />
      </div>

      <TopBar game={game} me={me} playing={!!playback} onExit={onExit} onLog={() => setLogOpen((v) => !v)} />

      <div className="io-side">
        <Installations game={game} me={me} />
      </div>

      {planning && (
        <OrdersPanel
          draft={draft}
          game={game}
          me={me}
          onRemove={(o) => setDraft((d) => d.filter((x) => x !== o))}
          onEdit={(o) => (o.kind === 'MOVE' || o.kind === 'LAND' ? openPicker(o.from, o.to) : undefined)}
        />
      )}

      {logOpen && <LogPanel game={game} onClose={() => setLogOpen(false)} />}

      {playback?.card && <StepCard step={playback.card} me={me} />}

      {report && planning && <ReportCard report={report} onClose={() => setReport(null)} />}

      {toast && <div className="io-toast">{toast}</div>}

      <div className="io-banners">
        {banners.map((b) => (
          <div key={b.id} className="io-banner" style={{ ['--c' as string]: b.color }}>
            <div className="io-banner-title">{b.title}</div>
            {b.sub && <div className="io-banner-sub">{b.sub}</div>}
          </div>
        ))}
      </div>

      {playback && (
        <div className="io-panel io-panel-wait" style={{ ['--c' as string]: myColor }}>
          <span>
            <b>Round {playback.report.round}</b> — all orders executing…
          </span>
          <button className="io-btn io-btn-ghost io-skip" onClick={() => finishPlayback(playback)} data-testid="skip">
            Skip ⏭
          </button>
        </div>
      )}

      {planning && (
        <PlanPanel
          view={view}
          tool={tool}
          setTool={(t) => (setTool(t), setFrom(null), setSelShip(null))}
          amount={amount}
          setAmount={setAmount}
          deployLeft={deployLeft}
          sortiesLeft={sortiesLeft}
          from={from}
          selShip={selShip}
          onUndo={() => setDraft((d) => d.slice(0, -1))}
          onClear={() => setDraft([])}
          onReady={ready}
          me={me}
        />
      )}

      {!planning && !playback && !over && (
        <div className="io-panel io-panel-wait">
          <span>
            <b>You have been wiped off the island.</b>
          </span>
          <button className="io-btn io-btn-ghost io-skip" onClick={onExit}>
            Main menu
          </button>
        </div>
      )}

      {picker && (
        <div className="io-modal-backdrop io-picker-backdrop" onClick={() => setPicker(null)}>
          <div className="io-picker" onClick={(e) => e.stopPropagation()} data-testid="picker">
            <div className="io-picker-head">
              {picker.zone ? '⚓ Landing' : game.map[picker.to].owner === me ? 'Reinforce' : 'Attack'}: <b>{BOARD.byId[picker.from].name}</b> → <b>{BOARD.byId[picker.to].name}</b>
            </div>
            <div className="io-picker-sub">
              {game.map[picker.from].unit}
              {picker.zone ? ` · across the ${SEA_ZONES[picker.zone].name} by ship` : ''}
            </div>
            <div className="io-slider-row">
              <input type="range" min={0} max={picker.max} value={picker.count} onChange={(e) => setPicker({ ...picker, count: Number(e.target.value) })} />
              <span className="io-count">{picker.count}</span>
            </div>
            {game.map[picker.to].owner !== me && (
              <div className="io-picker-sub">
                Their defence: {intelText(view.map[picker.to]).text} troops +{defenceBonus(picker.to)} ({BOARD.byId[picker.to].stronghold ? 'stronghold' : 'dug in'}). Ties go to the
                defender — and they may be moving too.
              </div>
            )}
            <div className="io-hand-actions">
              <button className="io-btn io-btn-ghost" onClick={() => setPicker({ ...picker, count: 0 })}>
                None
              </button>
              <button className="io-btn io-btn-primary" onClick={confirmPicker} data-testid="picker-ok">
                {picker.count ? `Send ${picker.count}` : 'Cancel order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {over && <Victory game={game} me={me} onRestart={onRestart} onExit={onExit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TopBar({ game, me, playing, onExit, onLog }: { game: GameState; me: FactionId; playing: boolean; onExit: () => void; onLog: () => void }) {
  return (
    <div className="io-topbar">
      <div className="io-logo-mini">
        COMMAND<span>ISLAND OPS</span>
      </div>
      <div className="io-players">
        {[...game.factions]
          .sort((a, b) => player(game, b).vp - player(game, a).vp)
          .map((f) => {
            const p = player(game, f);
            const fac = FACTIONS[f];
            return (
              <div key={f} className={`io-player${f === me ? ' io-player-active' : ''}${!p.alive ? ' io-player-dead' : ''}`} style={{ ['--c' as string]: fac.color, ['--d' as string]: fac.deep }}>
                <span className="io-player-emblem">
                  <Emblem faction={f} size={18} color="#fff" />
                </span>
                <span className="io-player-text">
                  <b>
                    {fac.short}
                    {f === me && <em> YOU</em>}
                  </b>
                  <small>
                    <span className="io-vp" key={p.vp}>
                      {p.vp} VP
                    </span> · {regionsOf(game, f).length} regions · {installationsOf(game, f).length}★
                  </small>
                </span>
              </div>
            );
          })}
      </div>
      <div className="io-top-right">
        <span className="io-round">
          Round {game.round}/{MAX_ROUNDS} · first to {VP_TARGET} VP{playing ? ' · resolving' : ''}
        </span>
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

function Installations({ game, me }: { game: GameState; me: FactionId }) {
  const held = installationsOf(game, me).length;
  return (
    <div className="io-sectors">
      <div className="io-sectors-head">
        <span>★ Key Installations</span>
        <span className="io-next">
          yours <b>{held}</b> = +{held} VP/round
        </span>
      </div>
      {Object.entries(INSTALLATIONS).map(([r, kind]) => {
        const owner = game.map[r].owner;
        return (
          <div key={r} className={`io-ki-row${owner === me ? ' io-sector-mine' : ''}`} title={INSTALLATION_INFO[kind].perk}>
            <i style={{ background: FACTIONS[owner].color }} />
            <span className="io-sector-name">{BOARD.byId[r].name}</span>
            <span className="io-ki-perk">{INSTALLATION_INFO[kind].label}</span>
          </div>
        );
      })}
    </div>
  );
}

function orderText(o: Order, game: GameState): string {
  const n = (id: string) => BOARD.byId[id].name;
  switch (o.kind) {
    case 'DEPLOY':
      return `Deploy ${o.count} → ${n(o.region)}`;
    case 'MOVE':
      return `${o.count} · ${n(o.from)} → ${n(o.to)}`;
    case 'LAND':
      return `⚓ ${o.count} · ${n(o.from)} → ${n(o.to)}`;
    case 'SAIL':
      return `${game.ships.find((s) => s.id === o.ship)?.name} → ${SEA_ZONES[o.to].name}`;
    case 'STRIKE':
      return `✈ Strike ${n(o.region)}`;
    case 'CAS':
      return `✈ Air support ${n(o.region)}`;
  }
}

function OrdersPanel({ draft, game, me, onRemove, onEdit }: { draft: Order[]; game: GameState; me: FactionId; onRemove: (o: Order) => void; onEdit: (o: Order) => void }) {
  const shown = draft.filter((o) => o.kind !== 'DEPLOY');
  return (
    <div className="io-orders" style={{ ['--c' as string]: FACTIONS[me].color }} data-testid="orders">
      <div className="io-sectors-head">
        <span>Your orders</span>
        <span className="io-next">secret until all are in</span>
      </div>
      {shown.length ? (
        shown.map((o, i) => (
          <div key={i} className="io-order-row">
            <button className="io-order-text" onClick={() => onEdit(o)}>
              {orderText(o, game)}
            </button>
            <button className="io-order-x" onClick={() => onRemove(o)} aria-label="Remove order">
              ✕
            </button>
          </div>
        ))
      ) : (
        <p className="io-orders-empty">Drag from your region onto a neighbour to march, or onto a far coast to land by sea. Tap a ship, then a sea zone, to sail.</p>
      )}
    </div>
  );
}

function LogPanel({ game, onClose }: { game: GameState; onClose: () => void }) {
  const items = game.log.slice(-60).reverse();
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

function SideRow({ sd, win, role }: { sd: Side; win: boolean; role: string }) {
  const f = FACTIONS[sd.owner];
  return (
    <div className={`io-bside${win ? ' io-bside-win' : ''}`} style={{ ['--c' as string]: f.color }}>
      <span className="io-player-emblem">
        <Emblem faction={sd.owner} size={16} color="#fff" />
      </span>
      <span className="io-bside-who">
        <b>
          {f.short} <small>{role}</small>
        </b>
        <small>{sd.units.join(' · ')}</small>
        {sd.bonuses.length > 0 && <small className="io-bside-bonus">{sd.bonuses.map((b) => `${b.label} +${b.n}`).join(' · ')}</small>}
      </span>
      <span className="io-bside-str">
        <b>{sd.strength}</b>
        <small>{sideText(sd)}</small>
      </span>
    </div>
  );
}

function StepCard({ step, me }: { step: ReportStep; me: FactionId }) {
  let body: React.ReactNode = null;
  if (step.kind === 'BATTLE') {
    body = (
      <>
        <div className="io-card-title">
          {INSTALLATIONS[step.region] && <span className="io-star">★</span>} Battle for {BOARD.byId[step.region].name}
        </div>
        {step.defender && <SideRow sd={step.defender} win={!step.captured} role="defending" />}
        {step.attackers.map((a) => (
          <SideRow key={a.owner} sd={a} win={step.captured && a.owner === step.winner} role="attacking" />
        ))}
        <div className={`io-card-verdict${step.captured ? ' io-captured' : ''}`}>
          {step.captured ? `CAPTURED by ${FACTIONS[step.winner].short}` : `HELD by ${FACTIONS[step.winner].short}`} · {step.survivors} left
        </div>
      </>
    );
  } else if (step.kind === 'NAVAL') {
    body = (
      <>
        <div className="io-card-title">⚓ Naval battle · {SEA_ZONES[step.zone].name}</div>
        {step.sides.map((sd) => (
          <div key={sd.owner} className={`io-bside${sd.owner === step.winner ? ' io-bside-win' : ''}`} style={{ ['--c' as string]: FACTIONS[sd.owner].color }}>
            <span className="io-player-emblem">
              <Emblem faction={sd.owner} size={16} color="#fff" />
            </span>
            <span className="io-bside-who">
              <b>{FACTIONS[sd.owner].short}</b>
              <small>{FACTIONS[sd.owner].squadron}</small>
            </span>
            <span className="io-bside-str">
              <b>{sd.ships}</b>
              <small>{step.sunk[sd.owner] ? `${step.sunk[sd.owner]} sunk` : 'ships'}</small>
            </span>
          </div>
        ))}
        <div className="io-card-verdict">{step.winner ? `${FACTIONS[step.winner].short} controls the ${SEA_ZONES[step.zone].name}` : 'Both fleets mauled — the sea is contested'}</div>
      </>
    );
  } else if (step.kind === 'CLASH') {
    body = (
      <>
        <div className="io-card-title">
          Columns clash · {BOARD.byId[step.at[0]].name} ↔ {BOARD.byId[step.at[1]].name}
        </div>
        <SideRow sd={step.a} win={step.winner === step.a.owner} role="marching" />
        <SideRow sd={step.b} win={step.winner === step.b.owner} role="marching" />
        <div className="io-card-verdict">{step.winner ? `${FACTIONS[step.winner].short} pushes through` : 'Both columns shattered'}</div>
      </>
    );
  } else if (step.kind === 'SCORE') {
    const gains = Object.entries(step.gains) as [FactionId, number][];
    body = (
      <>
        <div className="io-card-title">★ Installations score</div>
        <div className="io-score-row">
          {gains.map(([f, n]) => (
            <span key={f} className="io-score" style={{ background: FACTIONS[f].color }}>
              {FACTIONS[f].short} +{n}
            </span>
          ))}
        </div>
      </>
    );
  } else if (step.kind === 'FAILED') body = <div className="io-card-title">{step.text}</div>;
  else if (step.kind === 'ELIMINATED') body = <div className="io-card-title">{FACTIONS[step.who].name} has been wiped off the island.</div>;
  else if (step.kind === 'RECOMMISSION') body = <div className="io-card-title">{FACTIONS[step.owner].short} recommissions a ship in the {SEA_ZONES[step.zone].name}.</div>;
  if (!body) return null;
  const involved =
    (step.kind === 'BATTLE' && (step.defender?.owner === me || step.attackers.some((a) => a.owner === me))) ||
    (step.kind === 'NAVAL' && step.sides.some((x) => x.owner === me)) ||
    (step.kind === 'CLASH' && (step.a.owner === me || step.b.owner === me));
  return (
    <div className={`io-step-card${involved ? ' io-step-mine' : ''}`} data-testid="step-card">
      {body}
    </div>
  );
}

function ReportCard({ report, onClose }: { report: { round: number; lines: ReportLine[] }; onClose: () => void }) {
  return (
    <div className="io-recap" role="status" data-testid="report">
      <div className="io-recap-head">
        <b>Round {report.round} report</b>
        <button className="io-icon-btn" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      </div>
      <ul>
        {report.lines.map((l, i) => (
          <li key={i}>
            <i style={{ background: l.color }} />
            {l.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TOOL_TIPS: Record<Tool, string> = {
  deploy: 'Tap your regions to put new troops down. Mass them where you mean to strike — or where they will hit you.',
  move: 'Drag from your region onto a neighbour to march, or onto a far coast to land by sea. Every region keeps one troop. Nobody sees your orders until all are in.',
  strike: 'Air strike: knock 2 troops off an enemy region before anyone moves. Soften a target, or break up a stack about to hit you.',
  cas: 'Close air support: +3 strength to whatever you fight at that region this round, attacking or defending.',
  recon: 'Recon reveals a region and its neighbours exactly, right now. Look before you commit.',
};

interface PlanPanelProps {
  view: PlayerView;
  tool: Tool;
  setTool: (t: Tool) => void;
  amount: Amount;
  setAmount: (a: Amount) => void;
  deployLeft: number;
  sortiesLeft: number;
  from: string | null;
  selShip: string | null;
  onUndo: () => void;
  onClear: () => void;
  onReady: () => void;
  me: FactionId;
}

function PlanPanel({ view, tool, setTool, amount, setAmount, deployLeft, sortiesLeft, from, selShip, onUndo, onClear, onReady, me }: PlanPanelProps) {
  const fac = FACTIONS[me];
  const tip = selShip
    ? 'Tap a lit sea zone to sail there (or its own zone to stay). Ships in a zone you alone hold carry landings and add naval gunfire.'
    : tool === 'move' && from
      ? `From ${BOARD.byId[from].name}: tap a neighbour to march, or a lit coast to land — or just drag.`
      : TOOL_TIPS[tool];
  const tools: { id: Tool; label: string; badge?: string }[] = [
    { id: 'deploy', label: 'Deploy', badge: deployLeft > 0 ? String(deployLeft) : '✓' },
    { id: 'move', label: 'Move' },
    { id: 'strike', label: '✈ Strike', badge: String(sortiesLeft) },
    { id: 'cas', label: '✈ Air Support', badge: String(sortiesLeft) },
    { id: 'recon', label: '◉ Recon', badge: String(view.reconsLeft) },
  ];
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
          {tip}
        </div>
      </div>
      <div className="io-panel" style={{ ['--c' as string]: fac.color }}>
        <div className="io-steps">
          <span className="io-step io-step-on">Round {view.round} · plan your orders</span>
          <span className="io-step io-step-plain">
            +{view.budget.troops} troops: {view.budget.troopParts.map((p) => `${p.label} ${p.n}`).join(' · ')}
          </span>
        </div>
        <div className="io-panel-body">
          <div className="io-tools">
            {tools.map((t) => (
              <button key={t.id} className={`io-tool${tool === t.id ? ' on' : ''}`} onClick={() => setTool(t.id)} data-testid={`tool-${t.id}`}>
                {t.label}
                {t.badge && <b>{t.badge}</b>}
              </button>
            ))}
            {tool === 'deploy' && (
              <div className="io-seg" role="group" aria-label="Troops per tap">
                {([1, 5, 'all'] as Amount[]).map((a) => (
                  <button key={a} className={amount === a ? 'on' : ''} onClick={() => setAmount(a)}>
                    {a === 'all' ? 'All' : `+${a}`}
                  </button>
                ))}
              </div>
            )}
            <button className="io-btn io-btn-ghost io-small" onClick={onUndo}>
              Undo
            </button>
            <button className="io-btn io-btn-ghost io-small" onClick={onClear}>
              Clear
            </button>
          </div>
          <button className="io-btn io-btn-primary io-btn-main" onClick={onReady} disabled={deployLeft > 0} data-testid="ready">
            {deployLeft > 0 ? `Deploy ${deployLeft} more` : 'Ready — Execute'}
            <kbd>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function Victory({ game, me, onRestart, onExit }: { game: GameState; me: FactionId; onRestart: () => void; onExit: () => void }) {
  const w = game.winner!;
  const won = w === me;
  const fac = FACTIONS[w];
  const table = [...game.factions].sort((a, b) => player(game, b).vp - player(game, a).vp);
  return (
    <div className="io-modal-backdrop">
      <div className="io-victory" style={{ ['--c' as string]: fac.color, ['--d' as string]: fac.deep }}>
        <div className="io-victory-emblem">
          <Emblem faction={w} size={64} color="#fff" />
        </div>
        <h1>{won ? 'Victory!' : 'Defeat'}</h1>
        <p className="io-victory-who">{won ? 'The island is yours, Commander.' : `${fac.name} takes the exercise.`}</p>
        <p className="io-victory-reason">{game.winReason}</p>
        <div className="io-victory-table">
          {table.map((f) => (
            <div key={f} style={{ ['--c' as string]: FACTIONS[f].color }}>
              <i />
              <span>{FACTIONS[f].name}</span>
              <b>{player(game, f).vp} VP</b>
            </div>
          ))}
        </div>
        <div className="io-victory-stats">
          <span>
            <b>{game.round}</b> rounds
          </span>
          <span>
            <b>{game.stats.battles}</b> battles
          </span>
          <span>
            <b>{game.stats.captures}</b> captures
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
