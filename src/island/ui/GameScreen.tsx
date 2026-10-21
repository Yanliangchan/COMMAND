// ============================================================================
// The match. Each round: plan in secret (deploy, march, land, sail, fly,
// recon) → Ready → every task force's orders resolve together → watch the
// playback, battle by battle → round report → plan again.
//
// The draft is checked by the engine on every change (plan.ts), so what the
// HUD allows, what Ready accepts and what the rules resolve are one thing.
// The match is saved at the start of every round.
// ============================================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sound } from '../../audio/sound';
import { BOARD, INSTALLATIONS, REGION_IDS, SEA_ZONES, ZoneId, zonesOf } from '../map';
import { IllegalAction, alive, budget, controller, defenceBonus, player, recon, regionsOf, resolveRound, sharedZones, submitOrders, viewFor } from '../engine';
import { BotLevel, planBot } from '../bot';
import { CAS_BONUS, FACTIONS, FactionId, GameState, NAVAL_GUNFIRE_BONUS, Order, PlayerView, RoundReport, Ship } from '../types';
import { Amount, Dock, Picker, PickerState, PlaybackBar, SidePanel, SideTab, Tool, TopBar, orderText } from './Hud';
import { ReportCard, ReportLine, StepCard } from './Cards';
import { Victory } from './EndScreen';
import './hud.css';
import { Help } from './Help';
import { Badge, Highlight, Insets, MapView, Marker, OrderArrow } from './MapView';
import { defence, isMovement, plan, plural, regionName } from './plan';
import { saveMatch } from './save';
import { setPrefs, usePrefs } from './settings';
import { Playback, stepSeen, usePlayback } from './usePlayback';

function intelText(v: PlayerView['map'][string]): { text: string; fog: boolean } {
  if (v.intel.kind === 'exact') return { text: String(v.intel.troops), fog: false };
  if (v.intel.kind === 'band') return { text: v.intel.max >= 99 ? `${v.intel.min}+` : `${v.intel.min}–${v.intel.max}`, fog: true };
  return { text: '?', fog: true };
}

/** What the round meant for you, in a few lines — with the numbers. */
function reportLines(report: RoundReport, before: GameState, me: FactionId, spectator: boolean): ReportLine[] {
  const lines: ReportLine[] = [];
  const regionOwnerBefore = (r: string) => before.map[r].owner;
  const name = regionName;
  const vs = (a: number, b: number) => `${a} vs ${b}`;
  for (const st of report.steps) {
    if (st.kind === 'BATTLE') {
      const mineAttacking = st.attackers.find((a) => a.owner === me);
      const mineDefending = st.defender?.owner === me;
      const best = (xs: { strength: number }[]) => Math.max(0, ...xs.map((x) => x.strength));
      if (mineAttacking && st.captured && st.winner === me)
        lines.push({ tone: 'win', text: `Captured ${name(st.region)} (${vs(mineAttacking.strength, Math.max(st.defender?.strength ?? 0, best(st.attackers.filter((a) => a !== mineAttacking))))}) — ${mineAttacking.units[0]} moves in with ${st.survivors}.` });
      else if (mineDefending && st.captured)
        lines.push({ tone: 'loss', text: `Lost ${name(st.region)} to ${FACTIONS[st.winner].name} (${vs(st.defender!.strength, best(st.attackers))}).` });
      else if (mineDefending)
        lines.push({ tone: 'hold', text: `Held ${name(st.region)} against ${st.attackers.map((a) => FACTIONS[a.owner].name).join(' and ')} (${vs(st.defender!.strength, best(st.attackers))}).` });
      else if (mineAttacking)
        lines.push({ tone: 'fail', text: `Attack on ${name(st.region)} beaten back (${vs(mineAttacking.strength, Math.max(st.defender?.strength ?? 0, best(st.attackers.filter((a) => a !== mineAttacking))))}).` });
      else if (spectator && st.captured) lines.push({ tone: 'info', text: `${FACTIONS[st.winner].name} took ${name(st.region)}.` });
    } else if (st.kind === 'NAVAL' && st.sides.some((x) => x.owner === me)) {
      lines.push({ tone: st.winner === me ? 'win' : 'fail', text: `Naval battle in the ${SEA_ZONES[st.zone].name}: ${st.winner === me ? 'your fleet wins' : st.winner ? `${FACTIONS[st.winner].name} wins` : 'both fleets mauled'}.` });
    } else if (st.kind === 'FAILED' && st.owner === me) lines.push({ tone: 'fail', text: st.text });
    else if (st.kind === 'CLASH' && (st.a.owner === me || st.b.owner === me))
      lines.push({ tone: st.winner === me ? 'win' : 'fail', text: `Columns clashed between ${name(st.at[0])} and ${name(st.at[1])}: ${st.winner === me ? 'yours pushed through' : st.winner ? 'yours were broken' : 'both shattered'}.` });
    else if (st.kind === 'STRIKE' && st.by !== me && st.killed > 0 && report.steps.some((x) => x.kind === 'STRIKE') && regionOwnerBefore(st.region) === me)
      lines.push({ tone: 'loss', text: `${FACTIONS[st.by].name} air strike on ${name(st.region)}: ${plural(st.killed, 'troop')} lost.` });
    else if (st.kind === 'SCORE' && st.gains[me]) lines.push({ tone: 'vp', text: `+${plural(st.gains[me]!, 'victory point')} from installations held.` });
    else if (st.kind === 'ELIMINATED') lines.push({ tone: st.who === me ? 'loss' : 'info', text: `${FACTIONS[st.who].name} has been wiped off the island.` });
  }
  if (!lines.length) lines.push({ tone: 'info', text: 'A quiet round on your front.' });
  // Two identical lines (two strikes on the same region, say) read as one with a count.
  const merged: ReportLine[] = [];
  const seen = new Map<string, { line: ReportLine; n: number }>();
  for (const l of lines) {
    const hit = seen.get(l.text);
    if (hit) hit.n++;
    else {
      const entry = { line: { ...l }, n: 1 };
      seen.set(l.text, entry);
      merged.push(entry.line);
    }
  }
  for (const { line, n } of seen.values()) if (n > 1) line.text = `${line.text} (×${n})`;
  return merged;
}

function useLayout() {
  const get = () => {
    const w = window.innerWidth, h = window.innerHeight;
    // A side column needs width and height; short landscape phones stack instead.
    const side = w >= 1000 && h >= 560;
    return { side, sideW: w >= 1280 ? 300 : 270, w, h };
  };
  const [l, setL] = useState(get);
  useEffect(() => {
    const on = () => setL(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return l;
}

function useHeight(ref: React.RefObject<HTMLElement>) {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return h;
}

/** Ships after this draft's sails. */
function shipsAfter(ships: Ship[], draft: Order[]): Ship[] {
  return ships.map((sh) => {
    const sail = draft.find((o): o is Extract<Order, { kind: 'SAIL' }> => o.kind === 'SAIL' && o.ship === sh.id);
    return sail && sh.zone ? { ...sh, zone: sail.to } : sh;
  });
}

interface Props {
  initial: GameState;
  level: BotLevel;
  initialDraft?: Order[];
  onExit: () => void;
  onRestart: () => void;
}

export function GameScreen({ initial, level, initialDraft = [], onExit, onRestart }: Props) {
  const [game, setGame] = useState(initial);
  const [draft, setDraft] = useState<Order[]>(initialDraft);
  const [tool, setTool] = useState<Tool>('deploy');
  const [amount, setAmount] = useState<Amount>(1);
  const [from, setFrom] = useState<string | null>(null);
  const [selShip, setSelShip] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [report, setReport] = useState<{ round: number; lines: ReportLine[] } | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [tab, setTab] = useState<SideTab>('orders');
  const [sheet, setSheet] = useState(false);
  const [help, setHelp] = useState(false);
  const [spectate, setSpectate] = useState(false);
  const [banners, setBanners] = useState<{ id: number; title: string; sub?: string; color: string }[]>([]);
  const [shake, setShake] = useState(0);
  const prefs = usePrefs();
  const layout = useLayout();

  const me = game.factions.find((f) => player(game, f).human)!;
  const meAlive = player(game, me).alive;
  const view = useMemo(() => viewFor(game, me), [game, me]);

  const say = useCallback((text: string) => setToast({ id: Math.random(), text }), []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const bannerTimers = useRef(new Set<number>());
  useEffect(() => () => bannerTimers.current.forEach((t) => clearTimeout(t)), []);
  const banner = useCallback((title: string, color: string, sub?: string) => {
    const id = Math.random();
    setBanners((bs) => [...bs.slice(-1), { id, title, sub, color }]);
    const t = window.setTimeout(() => {
      bannerTimers.current.delete(t);
      setBanners((bs) => bs.filter((b) => b.id !== id));
    }, 1900);
    bannerTimers.current.add(t);
  }, []);

  // ---- playback ----
  const finishRef = useRef<(pb: Playback) => void>(() => {});
  const director = usePlayback({
    me,
    spectator: !meAlive || spectate,
    speed: prefs.speed,
    banner,
    onShake: () => setShake((n) => n + 1),
    onFinish: (pb) => finishRef.current(pb),
  });
  const { playback } = director;
  const over = game.phase === 'GAME_OVER' && !playback;
  const planning = !playback && game.phase === 'PLANNING' && meAlive;

  finishRef.current = (pb: Playback) => {
    busy.current = false;
    const lost = REGION_IDS.filter((r) => pb.before.map[r].owner === me && pb.after.map[r].owner !== me);
    setGame(pb.after);
    setReport({ round: pb.report.round, lines: reportLines(pb.report, pb.before, me, !player(pb.after, me).alive) });
    setTool('deploy');
    if (!layout.side) setTab('orders');
    lost.forEach((region, i) => director.addFx({ id: `lost-${pb.report.round}-${i}`, kind: 'alert', region, color: '#ff5a4e' }, 4500));
  };

  // ---- persistence: every change of the match or the draft ----
  useEffect(() => {
    if (playback) return;
    saveMatch({ game, level, draft });
  }, [game, draft, level, playback]);

  // ---- the plan, as the engine sees it ----
  const p = useMemo(() => plan(game, me, draft), [game, me, draft]);
  const problems = p.issues.filter(Boolean).length;
  const deployed = useMemo(() => {
    const d: Record<string, number> = {};
    for (const o of draft) if (o.kind === 'DEPLOY') d[o.region] = (d[o.region] ?? 0) + o.count;
    return d;
  }, [draft]);
  const myShipsIn = p.shipsIn;
  const plannedShips = useMemo(() => shipsAfter(game.ships, draft), [game.ships, draft]);

  // ---- planning actions ----
  const addDeploy = (region: string) => {
    if (p.deployLeft <= 0) return say('Every new troop is placed — Undo, or remove one from the Orders list, to change.');
    const n = amount === 'all' ? p.deployLeft : Math.min(amount, p.deployLeft);
    setDraft((d) => [...d, { kind: 'DEPLOY', region, count: n }]);
    sound.play('ui');
  };

  const openPicker = (a: string, b: string) => {
    if (game.map[a].owner !== me) return;
    const existing = draft.find((o): o is Extract<Order, { kind: 'MOVE' | 'LAND' }> => isMovement(o) && o.from === a && o.to === b);
    const attack = game.map[b].owner !== me;
    let zone: ZoneId | null = null;
    let max: number;
    if (BOARD.byId[a].neighbours.includes(b)) {
      max = p.available(a, existing);
      if (max <= 0) return say(`${regionName(a)} has no troops to spare — every region keeps one. Deploy more there first.`);
    } else {
      const shared = sharedZones(a, b);
      const zones = shared.filter((z) => myShipsIn(z) > 0);
      if (!zones.length)
        return say(
          shared.length
            ? `To land at ${regionName(b)}, get a ship into the ${SEA_ZONES[shared[0]].name} first.`
            : `${regionName(b)} isn't next to ${regionName(a)}, and no sea zone links them.`,
        );
      zone = existing?.kind === 'LAND' ? existing.zone : zones.sort((x, y) => p.liftLeft(y, existing) - p.liftLeft(x, existing))[0];
      const capacity = p.liftLeft(zone, existing);
      max = Math.min(p.available(a, existing), capacity);
      if (max <= 0) return say(capacity <= 0 ? `Your ships in the ${SEA_ZONES[zone].name} are full.` : `${regionName(a)} has no troops to spare.`);
    }
    const myBonuses: { label: string; n: number }[] = [];
    if (attack) {
      if (draft.some((o) => o.kind === 'CAS' && o.region === b)) myBonuses.push({ label: 'Air support', n: CAS_BONUS });
      if (zonesOf(b).some((z) => controller(plannedShips, z) === me)) myBonuses.push({ label: 'Naval gunfire', n: NAVAL_GUNFIRE_BONUS * (me === 'JERUNG' ? 2 : 1) });
    }
    const def = attack ? defence(view, b) : null;
    const bonus = myBonuses.reduce((n, x) => n + x.n, 0);
    // Default to enough to win against the worst case they could have — not to everything you've got.
    const need = def ? Math.max(1, def.high + 1 - bonus) : max;
    const count = existing ? Math.min(existing.count, max) : Math.min(max, need);
    setPicker({ from: a, to: b, zone, max, count, existing: !!existing, attack, myBonuses, def });
  };

  const confirmPicker = () => {
    if (!picker) return;
    const { from: a, to: b, zone, count } = picker;
    setDraft((d) => {
      const rest = d.filter((o) => !(isMovement(o) && o.from === a && o.to === b));
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
    if (existing) {
      setDraft((d) => d.filter((o) => o !== existing));
      return say(`${kind === 'STRIKE' ? 'Strike' : 'Air support'} on ${regionName(region)} cancelled.`);
    }
    if (p.sortiesLeft <= 0) return say('No air sorties left this round — tap an existing air order to cancel it.');
    if (kind === 'STRIKE' && game.map[region].owner === me) return say("Strike enemy ground — you can't bomb your own.");
    setDraft((d) => [...d, { kind, region }]);
    sound.play('ui');
  };

  const doRecon = (region: string) => {
    if (game.map[region].owner === me) return say('Recon enemy ground — you already know your own.');
    if (view.reconsLeft <= 0) return say('No recon left this round.');
    try {
      setGame(recon(game, me, region));
      say(`Recon: ${regionName(region)} and its neighbours revealed for this round. (Recon can't be undone.)`);
      sound.play('contact');
    } catch (e) {
      if (e instanceof IllegalAction) say(e.message);
      else throw e;
    }
  };

  const onRegion = (id: string) => {
    if (!planning) return;
    if (selShip) setSelShip(null);
    if (tool === 'deploy') {
      if (game.map[id].owner !== me) return say('Deploy on your own ground — the regions in your colour.');
      return addDeploy(id);
    }
    if (tool === 'strike' || tool === 'cas') return toggleAir(tool === 'strike' ? 'STRIKE' : 'CAS', id);
    if (tool === 'recon') return doRecon(id);
    if (from && from !== id) return openPicker(from, id);
    if (game.map[id].owner === me) setFrom(from === id ? null : id);
    else say('Pick one of your own regions first, then where to send its troops.');
  };

  const onShip = (id: string) => {
    if (!planning) return;
    const ship = game.ships.find((sh) => sh.id === id)!;
    if (ship.owner !== me) return say(`${ship.name} — ${FACTIONS[ship.owner].name}.`);
    setFrom(null);
    setSelShip(selShip === id ? null : id);
  };

  const onZone = (z: ZoneId) => {
    if (!planning || !selShip) return;
    const ship = game.ships.find((sh) => sh.id === selShip)!;
    if (z !== ship.zone && !(ship.zone && SEA_ZONES[ship.zone].neighbours.includes(z))) return say('Ships sail one sea zone at a time.');
    setDraft((d) => {
      const rest = d.filter((o) => !(o.kind === 'SAIL' && o.ship === selShip));
      return z === ship.zone ? rest : [...rest, { kind: 'SAIL', ship: selShip, to: z }];
    });
    setSelShip(null);
    sound.play('ui');
  };

  const drag = useMemo(
    () =>
      planning
        ? {
            canStart: (id: string) => game.map[id].owner === me && p.available(id) > 0,
            drop: (a: string, b: string) => {
              setTool('move');
              openPicker(a, b);
            },
          }
        : undefined,
    // openPicker reads the latest draft through closures rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planning, game, me, p, draft, view],
  );

  const undo = () => {
    const last = draft[draft.length - 1];
    if (!last) return;
    setDraft((d) => d.slice(0, -1));
    say(`Undone: ${orderText(last, game)}.`);
  };

  // ---- Ready: submit, let the bots plan, resolve, play it back ----
  // Set from Ready until the round's playback ends: a second press before React
  // has re-rendered must not resolve the same round again.
  const busy = useRef(false);
  const runRound = useCallback(
    (orders: Order[] | null) => {
      if (busy.current) return;
      busy.current = true;
      try {
        let s = orders ? submitOrders(game, me, orders) : game;
        for (const f of alive(s)) {
          if (f === me) continue;
          try {
            const bot = planBot(
              () => viewFor(s, f),
              (r) => (s = recon(s, f, r)),
              level,
            );
            s = submitOrders(s, f, bot);
          } catch (e) {
            // A bot that can't produce legal orders just reinforces its first region — the round still goes ahead.
            console.error(`Bot ${f} failed to plan:`, e);
            const home = regionsOf(s, f)[0];
            s = submitOrders(s, f, [{ kind: 'DEPLOY', region: home, count: budget(s, f).troops }]);
          }
        }
        const { state, report: rep } = resolveRound(s);
        // Save the outcome now, before the playback: leaving mid-playback must
        // not bring back the pre-round state with the result already known.
        saveMatch({ game: state, level, draft: [] });
        setDraft([]);
        setFrom(null);
        setSelShip(null);
        setReport(null);
        setPicker(null);
        sound.play('turn');
        if (orders) banner('Orders in — Execute!', FACTIONS[me].color, `Round ${rep.round}: every task force moves at once`);
        director.start(rep, s, state);
      } catch (e) {
        busy.current = false;
        console.error(e);
        say(e instanceof IllegalAction ? e.message : 'Something went wrong resolving the round. Your orders are kept — try Ready again.');
      }
    },
    [game, me, level, banner, director, say],
  );

  const ready = () => {
    if (!planning) return;
    if (p.deployLeft > 0) return say(`Deploy ${p.deployLeft} more ${p.deployLeft === 1 ? 'troop' : 'troops'} first — tap your regions.`);
    const bad = p.issues.findIndex(Boolean);
    if (bad >= 0) return say(`${orderText(draft[bad], game)}: ${p.issues[bad]}`);
    runRound(draft);
  };

  // Eliminated and watching: the bots play on, round after round.
  useEffect(() => {
    if (!spectate || meAlive || playback || game.phase !== 'PLANNING') return;
    const t = window.setTimeout(() => runRound(null), 700);
    return () => clearTimeout(t);
  }, [spectate, meAlive, playback, game, runRound]);

  // ---- keyboard: Enter = confirm picker / Ready, Esc = cancel. Bound once; reads the latest state. ----
  const keys = useRef({ picker, confirmPicker, ready, help });
  keys.current = { picker, confirmPicker, ready, help };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.help) return;
      const target = e.target as HTMLElement;
      if (e.key === 'Escape') {
        setPicker(null);
        setFrom(null);
        setSelShip(null);
        return;
      }
      if (e.key !== 'Enter' || e.repeat) return;
      // Buttons, inputs and focused map regions handle their own Enter.
      if (target.closest?.('button, input, [role="button"], a')) {
        if (k.picker && target.closest('input')) (e.preventDefault(), k.confirmPicker());
        return;
      }
      if (k.picker) k.confirmPicker();
      else k.ready();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- what the map shows ----
  const shownView = useMemo(() => (playback ? viewFor(playback.before, me) : view), [playback, view, me]);
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
  const arrows: OrderArrow[] = useMemo(
    () =>
      playback
        ? playback.arrows
        : draft.flatMap((o, i): OrderArrow[] => {
            if (isMovement(o))
              return [{ id: `o-${i}`, from: o.from, to: o.to, color: myColor, label: String(o.count), via: o.kind === 'LAND' ? o.zone : undefined, broken: !!p.issues[i] }];
            if (o.kind === 'SAIL') {
              const zone = game.ships.find((sh) => sh.id === o.ship)?.zone;
              return zone ? [{ id: `o-${i}`, from: zone, to: o.to, color: myColor, sail: true }] : [];
            }
            return [];
          }),
    [playback, draft, myColor, p.issues, game.ships],
  );

  const markers: Marker[] = useMemo(
    () =>
      playback
        ? []
        : draft
            .filter((o): o is Extract<Order, { kind: 'STRIKE' | 'CAS' }> => o.kind === 'STRIKE' || o.kind === 'CAS')
            .map((o) => ({ region: o.region, kind: o.kind, color: o.kind === 'STRIKE' ? '#d9452f' : '#2f8fd0' })),
    [playback, draft],
  );

  const highlights = useMemo(() => {
    const h: Record<string, Highlight> = {};
    if (!planning || picker) return h;
    const enemy = (r: string) => game.map[r].owner !== me;
    if (selShip) return h;
    if (tool === 'deploy' && p.deployLeft > 0) for (const r of regionsOf(game, me)) h[r] = 'place';
    if (tool === 'strike' && p.sortiesLeft > 0) for (const r of REGION_IDS) if (enemy(r)) h[r] = 'strike';
    if (tool === 'cas' && p.sortiesLeft > 0) {
      for (const o of draft) if (isMovement(o)) h[o.to] = 'friendly';
      for (const r of regionsOf(game, me)) if (BOARD.byId[r].neighbours.some(enemy)) h[r] = 'friendly';
    }
    if (tool === 'recon' && view.reconsLeft > 0) for (const r of REGION_IDS) if (enemy(r) && view.map[r].intel.kind !== 'exact') h[r] = 'recon';
    if (tool === 'move') {
      if (from) {
        h[from] = 'source';
        for (const n of BOARD.byId[from].neighbours) h[n] = 'target';
        for (const r of REGION_IDS) if (!h[r] && r !== from && sharedZones(from, r).some((z) => myShipsIn(z) > 0)) h[r] = 'landing';
      } else for (const r of regionsOf(game, me)) if (p.available(r) > 0) h[r] = 'place';
    }
    return h;
  }, [planning, picker, game, me, selShip, tool, p, draft, view, from, myShipsIn]);

  const threats = useMemo(
    () =>
      playback || !meAlive
        ? []
        : regionsOf(game, me).filter((r) => {
            const mine = game.map[r].troops + (deployed[r] ?? 0) + defenceBonus(r);
            return BOARD.byId[r].neighbours.some((n) => {
              const iv = view.map[n];
              if (iv.owner === me) return false;
              const est = iv.intel.kind === 'exact' ? iv.intel.troops : iv.intel.kind === 'band' ? Math.min(iv.intel.max, 14) : 0;
              return est > mine;
            });
          }),
    [playback, meAlive, game, me, deployed, view],
  );

  const ships = playback ? (playback.sailed ? playback.after.ships : playback.before.ships) : game.ships;
  const selZone = selShip ? game.ships.find((s) => s.id === selShip)?.zone : null;
  const zoneHighlights = useMemo(
    () => (playback?.naval ? { [playback.naval]: 'battle' as const } : selZone ? Object.fromEntries([selZone, ...SEA_ZONES[selZone].neighbours].map((z) => [z, 'sail' as const])) : {}),
    [playback?.naval, selZone],
  );

  const describe = useCallback(
    (id: string) => {
      const rv = view.map[id];
      const t = intelText(rv);
      const own = rv.owner === me ? 'yours' : FACTIONS[rv.owner].name;
      const troops = t.text === '?' ? 'strength unknown' : `${t.text} troops${deployed[id] ? ` plus ${deployed[id]} new` : ''}`;
      return `${regionName(id)}, ${own}, ${troops}${INSTALLATIONS[id] ? ', Key Installation' : ''}${BOARD.byId[id].stronghold ? ', stronghold' : ''}${from === id ? ', selected' : ''}`;
    },
    [view, me, deployed, from],
  );
  const home = useMemo(() => regionsOf(initial, me), [initial, me]);

  // ---- hint line: Encik coaches the first rounds, then explains each tool ----
  const movements = draft.filter(isMovement).length;
  const hint = !prefs.tips
    ? ''
    : selShip
      ? 'Tap a lit sea zone to sail there — or the ship’s own zone to stay. Ships alone in a zone carry landings and add naval gunfire.'
      : problems
        ? `An order can't go ahead: ${p.issues.find(Boolean)}`
        : tool === 'deploy' && p.deployLeft > 0
          ? game.round === 1 && !draft.length
            ? `Every round starts with new troops. Tap your regions to place ${p.deployLeft} — mass them where you'll attack, or where the red ! says you're threatened.`
            : `Tap your regions to place ${plural(p.deployLeft, 'more troop', 'more troops')}.`
          : tool === 'move' && from
            ? `From ${regionName(from)}: tap a yellow neighbour to march, or a dashed blue coast to land by sea.`
            : tool === 'strike'
              ? p.sortiesLeft > 0
                ? 'Tap an enemy region: −2 troops there before anyone moves. Tap again to cancel.'
                : 'No sorties left. Tap an existing strike to cancel it.'
              : tool === 'cas'
                ? p.sortiesLeft > 0
                  ? 'Tap a lit region where you will fight: +3 to your side there, attacking or defending.'
                  : 'No sorties left. Tap existing air support to cancel it.'
                : tool === 'recon'
                  ? view.reconsLeft > 0
                    ? 'Tap an enemy region to see it and its neighbours exactly. Recon is instant — it can’t be undone.'
                    : 'No recon left this round.'
                  : !movements && game.round <= 2
                    ? 'All deployed. Now drag from one of your regions onto an enemy neighbour to attack. Every ★ you hold at the end of a round is a victory point.'
                    : tool === 'move'
                      ? 'Drag from your region onto a neighbour to march, or onto a far coast to land by sea. Every region keeps one troop.'
                      : 'Ready when you are. Nobody sees your orders until every task force is in.';

  // ---- layout zones ----
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const topH = useHeight(topRef);
  const bottomH = useHeight(bottomRef);
  const bandH = useHeight(bandRef);
  const sideOn = layout.side && !over;
  const insets: Insets = useMemo(
    () => ({ top: (topH || 58) + bandH, right: sideOn ? layout.sideW + 16 : 0, bottom: bottomH, left: 0 }),
    [topH, bandH, bottomH, sideOn, layout.sideW],
  );

  const card = playback?.card && stepSeen(playback.card, me, !meAlive || spectate) ? <StepCard step={playback.card} me={me} /> : null;
  const reportCard = report && !playback ? <ReportCard round={report.round} lines={report.lines} onClose={() => setReport(null)} /> : null;

  const sidePanel = (asSheet: boolean) => (
    <SidePanel
      tab={(playback || !meAlive) && tab === 'orders' ? 'log' : tab}
      setTab={setTab}
      draft={draft}
      issues={p.issues}
      game={game}
      me={me}
      sheet={asSheet}
      onRemove={(o) => setDraft((d) => d.filter((x) => x !== o))}
      onEdit={(o) => (isMovement(o) ? openPicker(o.from, o.to) : undefined)}
      onClose={asSheet ? () => setSheet(false) : undefined}
      top={!asSheet ? card ?? reportCard : undefined}
    />
  );

  return (
    <div className={`io-game${shake % 2 ? ' io-shake-a' : shake ? ' io-shake-b' : ''}`}>
      <MapView
        badges={badges}
        highlights={highlights}
        dimOthers={Object.keys(highlights).length > 0}
        fx={director.fx}
        arrows={arrows}
        markers={markers}
        ships={ships}
        selectedShip={selShip}
        zoneHighlights={zoneHighlights}
        onRegion={planning ? onRegion : undefined}
        onZone={planning ? onZone : undefined}
        onShip={planning ? onShip : undefined}
        threats={threats}
        drag={drag}
        focus={playback?.focus ?? null}
        insets={insets}
        camera
        home={home}
        describe={describe}
        selected={from}
      />

      <div ref={topRef} className="io-top-zone">
        <TopBar game={game} me={me} resolving={!!playback} onHelp={() => setHelp(true)} onMenu={onExit} />
      </div>

      {/* Small screens: playback cards and the report get a band of their own above the map. */}
      {!layout.side && (card || reportCard) && (
        <div ref={bandRef} className="io-band" style={{ top: topH || 58, maxHeight: Math.max(120, Math.min(layout.h * 0.45, layout.h - (topH || 58) - bottomH - 12)) }}>
          {card ?? reportCard}
        </div>
      )}

      {sideOn && sidePanel(false)}

      <div ref={bottomRef} className="io-bottom" style={{ right: sideOn ? layout.sideW + 16 : 0 }}>
        {toast && (
          <div key={toast.id} className="io-toast" role="status" aria-live="polite">
            {toast.text}
          </div>
        )}
        {!layout.side && sheet && planning && sidePanel(true)}
        {planning && (
          <Dock
            view={view}
            tool={tool}
            setTool={(t) => (setTool(t), setFrom(null), setSelShip(null))}
            amount={amount}
            setAmount={setAmount}
            deployLeft={p.deployLeft}
            sortiesLeft={p.sortiesLeft}
            hint={hint}
            onUndo={undo}
            onClear={() => (setDraft([]), say('All orders cleared.'))}
            onReady={ready}
            me={me}
            ordersCount={draft.length}
            onOrders={() => setSheet((v) => !v)}
            compact={!layout.side}
            problems={problems}
          />
        )}
        {playback && (
          <PlaybackBar
            round={playback.report.round}
            paused={director.paused}
            setPaused={director.setPaused}
            speed={prefs.speed}
            setSpeed={(s) => setPrefs({ speed: s })}
            onSkip={director.skip}
            me={me}
          />
        )}
        {!meAlive && !playback && !over && (
          <section className="io-dock io-dock-play" aria-label="Eliminated">
            <span className="io-play-title">
              <b>Your task force has been wiped off the island.</b> {spectate ? 'Watching the rest of the exercise…' : 'Watch how it ends?'}
            </span>
            <div className="io-play-ctl">
              {!spectate && (
                <button className="io-btn io-btn-primary" onClick={() => setSpectate(true)} data-testid="spectate">
                  Watch to the end
                </button>
              )}
              <button className="io-btn io-btn-ghost" onClick={onExit}>
                Main menu
              </button>
            </div>
          </section>
        )}
      </div>

      <div className="io-banners" style={{ top: insets.top, bottom: insets.bottom, right: insets.right }} aria-hidden="true">
        {banners.map((b) => (
          <div key={b.id} className="io-banner" style={{ ['--c' as string]: b.color }}>
            <div className="io-banner-title">{b.title}</div>
            {b.sub && <div className="io-banner-sub">{b.sub}</div>}
          </div>
        ))}
      </div>

      {picker && (
        <div className="io-picker-wrap" style={{ top: (topH || 58) + 8, bottom: insets.bottom + 8, right: insets.right }} onClick={() => setPicker(null)}>
          <div className="io-picker-inner" onClick={(e) => e.stopPropagation()}>
            <Picker p={picker} game={game} onChange={(n) => setPicker({ ...picker, count: n })} onConfirm={confirmPicker} onCancel={() => setPicker(null)} />
          </div>
        </div>
      )}

      {help && <Help onClose={() => setHelp(false)} />}

      {over && <Victory game={game} me={me} level={level} onRestart={onRestart} onExit={onExit} />}
    </div>
  );
}

