// ============================================================================
// Playback director: walks a resolved round's report step by step — sets the
// card, the arrows and the camera focus, fires effects and sounds, and reveals
// each battle's result on the map a beat after its card appears.
//
// Every timer it starts is tracked, so Skip, a new round or leaving the match
// cancels them all; nothing from a skipped round can land in the next one.
// Steps the player couldn't see (fog) flip the map's colours without a card,
// go by quickly, and never size an effect by numbers the player can't know.
//
// Effects are PlayFx (Effects.tsx): MapView's Fx plus a `burst` describing the
// richer effect, so they pass through MapView's `fx` prop unchanged.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { SoundName, sound } from '../../audio/sound';
import { BOARD, INSTALLATIONS, INSTALLATION_INFO, ZoneId } from '../map';
import { sharedZones } from '../engine';
import { FACTIONS, FactionId, GameState, ReportStep, RoundReport } from '../types';
import type { Badge, Focus, Fx, OrderArrow } from './MapView';
import { PlayFx, allowTrails, prefersReducedMotion, setTravelSpeed } from './Effects';

export interface Playback {
  report: RoundReport;
  before: GameState;
  after: GameState;
  index: number;
  overrides: Record<string, Badge>;
  arrows: OrderArrow[];
  card: ReportStep | null;
  focus: Focus | null;
  naval: ZoneId | null;
  /** Ships have sailed once the naval phase has played. */
  sailed: boolean;
}

const STEP_MS: Partial<Record<ReportStep['kind'], number>> = {
  NAVAL: 1700, STRIKE: 750, MOVES: 1800, FAILED: 1500, CLASH: 1600, BATTLE: 2000, RECOMMISSION: 800, SCORE: 1800, ELIMINATED: 1700, VICTORY: 600,
};
/** A step the player can't see detail of goes by quickly. */
const UNSEEN_MS = 450;
/**
 * Before the first step: the "Orders in — Execute!" banner (1.9 s, starts to
 * leave at ~1.5 s) has the screen to itself, so the first card arrives as it goes.
 * Spectated rounds have no banner.
 */
const FIRST_MS = 1450;
const FIRST_MS_SPECTATING = 500;
/** When a battle's result lands, after its card appears (cards.css --io-rev matches this). */
const REVEAL_MS = 850;

/** The moves this viewer is entitled to see: their own, and any they had eyes on. */
export function visibleMoves(step: Extract<ReportStep, { kind: 'MOVES' }>, me: FactionId, spectator: boolean) {
  return spectator ? step.moves : step.moves.filter((m) => m.owner === me || !m.seen || m.seen.includes(me));
}

/** Whether the viewer gets this step's detail: they took part, or could see where it happened. */
export function stepSeen(step: ReportStep, me: FactionId, spectator: boolean): boolean {
  if (spectator) return true;
  if (step.kind === 'BATTLE') return step.defender?.owner === me || step.attackers.some((a) => a.owner === me) || !step.seen || step.seen.includes(me);
  if (step.kind === 'CLASH') return step.a.owner === me || step.b.owner === me || !step.seen || step.seen.includes(me);
  if (step.kind === 'STRIKE') return step.by === me || !step.seen || step.seen.includes(me);
  if (step.kind === 'MOVES') return visibleMoves(step, me, spectator).length > 0;
  return true;
}

export interface Director {
  playback: Playback | null;
  paused: boolean;
  setPaused: (p: boolean) => void;
  start: (report: RoundReport, before: GameState, after: GameState) => void;
  skip: () => void;
  /** Effects for MapView's `fx` prop — PlayFx (Effects.tsx), which are Fx with a burst. */
  fx: Fx[];
  addFx: (f: Fx | PlayFx, ms: number) => void;
  /** Schedule something that must not outlive the current round. */
  later: (fn: () => void, ms: number) => void;
}

export function usePlayback(opts: {
  me: FactionId;
  spectator: boolean;
  speed: 1 | 2;
  banner: (title: string, color: string, sub?: string) => void;
  /** Shake the board; size 0–1 (a bigger battle shakes harder — see effects.css). */
  onShake: (size?: number) => void;
  onFinish: (pb: Playback) => void;
}): Director {
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [paused, setPaused] = useState(false);
  const [fx, setFx] = useState<PlayFx[]>([]);
  const timers = useRef(new Set<number>());
  /** The clock to the next step — separate, so moving on a step never cancels that step's own effects. */
  const stepTimer = useRef(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pbRef = useRef(playback);
  pbRef.current = playback;

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);
  const clearAll = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current.clear();
    clearTimeout(stepTimer.current);
  }, []);
  useEffect(() => clearAll, [clearAll]);

  // Playback speed for the cards' CSS timings (--io-speed) and travelling tokens.
  const speedNow = opts.speed;
  useEffect(() => {
    setTravelSpeed(speedNow);
    document.documentElement.style.setProperty('--io-speed', String(speedNow));
  }, [speedNow]);

  const addFx = useCallback(
    (f: PlayFx, ms: number) => {
      setFx((list) => [...list.filter((x) => x.id !== f.id), f]);
      later(() => setFx((list) => list.filter((x) => x.id !== f.id)), ms);
    },
    [later],
  );

  const finish = useCallback(() => {
    const pb = pbRef.current;
    if (!pb) return;
    clearAll();
    setFx([]);
    setPlayback(null);
    setPaused(false);
    optsRef.current.onFinish(pb);
  }, [clearAll]);

  const start = useCallback(
    (report: RoundReport, before: GameState, after: GameState) => {
      clearAll();
      setFx([]);
      setPaused(false);
      setPlayback({ report, before, after, index: -1, overrides: {}, arrows: [], card: null, focus: null, naval: null, sailed: false });
    },
    [clearAll],
  );

  // One effect per step: it depends on the step index, not on the whole
  // playback object, so revealing a battle result doesn't restart the clock.
  const index = playback?.index ?? null;
  const report = playback?.report ?? null;
  useEffect(() => {
    if (index === null || !report || paused) return;
    const { me, spectator, speed } = optsRef.current;
    const steps = report.steps;
    const next = index + 1;
    const prev = index >= 0 ? steps[index] : null;
    const wait = prev ? (stepSeen(prev, me, spectator) ? STEP_MS[prev.kind] ?? 800 : UNSEEN_MS) / speed : spectator ? FIRST_MS_SPECTATING : FIRST_MS;
    const tick = (fn: () => void, ms: number) => {
      clearTimeout(stepTimer.current);
      stepTimer.current = window.setTimeout(fn, ms);
    };
    // The last step (usually the score) gets its full time too, then the round ends.
    if (next >= steps.length) tick(finish, wait);
    else tick(() => play(steps[next], next), wait);
    return () => clearTimeout(stepTimer.current);

    function play(step: ReportStep, i: number) {
      const { banner, onShake } = optsRef.current;
      const seen = stepSeen(step, me, spectator);
      const still = prefersReducedMotion();
      const pb = pbRef.current;
      /** A burst effect: lives for `ms` at 1× (scaled by speed), plus a margin. */
      const burst = (id: string, b: PlayFx['burst'], ms: number) =>
        addFx({ id: `${id}-${i}`, kind: 'blast', region: '', color: '#fff', burst: b, speed }, ms / speed + 120);
      /** A sound that must not outlive the round. */
      const cue = (name: SoundName, ms: number) => (ms ? later(() => sound.play(name), ms / speed) : sound.play(name));
      let card: ReportStep | null = null;
      let focus: Focus | null = null;
      let naval: ZoneId | null = null;
      let arrows: OrderArrow[] | undefined;
      switch (step.kind) {
        case 'NAVAL': {
          card = step;
          naval = step.zone;
          focus = { zone: step.zone };
          const sides = step.sides.map((sd) => ({ color: FACTIONS[sd.owner].color, ships: sd.ships, sunk: step.sunk[sd.owner] ?? 0 }));
          burst('naval', { type: 'naval', zone: step.zone, sides }, 1700);
          cue('salvo', 0);
          if (sides.some((s) => s.sunk)) cue('sink', 950);
          break;
        }
        case 'STRIKE': {
          // The jet comes in with its shadow; the bombs land as it passes over.
          focus = seen ? { region: step.region } : null;
          burst('strike', { type: 'strike', region: step.region, color: FACTIONS[step.by].color }, 1250);
          cue('jet', 0);
          cue('boom', 400);
          break;
        }
        case 'MOVES': {
          const moves = visibleMoves(step, me, spectator);
          arrows = moves.map((m, k) => ({
            id: `mv-${i}-${k}`,
            from: m.from,
            to: m.to,
            color: FACTIONS[m.owner].color,
            label: String(m.count),
            via: m.landing ? sharedZones(m.from, m.to)[0] : undefined,
            travel: true,
          }));
          if (moves.length) {
            // The tokens themselves (MapView → Traveller) kick up dust and land with a thump — at most 8 of them.
            allowTrails(8);
            cue('move', 0);
            cue('thump', 1480);
          }
          break;
        }
        case 'CLASH':
          if (seen) {
            card = step;
            focus = { between: step.at };
            cue('clash', 200);
          }
          burst('sparks', { type: 'sparks', between: step.at }, 700);
          break;
        case 'BATTLE': {
          const mine = step.defender?.owner === me || step.attackers.some((a) => a.owner === me);
          const sides = [...(step.defender ? [step.defender] : []), ...step.attackers];
          // Only a fight the viewer saw is sized by its numbers.
          const size = seen ? Math.min(1, sides.reduce((n, sd) => n + sd.strength, 0) / 18) : 0.2;
          if (seen) {
            card = step;
            focus = { region: step.region };
            sound.play('attack');
          }
          // Reveal the result on the map once the card has had a moment.
          later(
            () => {
              setPlayback((p) =>
                p ? { ...p, overrides: { ...p.overrides, [step.region]: { owner: step.winner, text: seen ? String(step.survivors) : '?', fog: !seen } } } : p,
              );
              burst('impact', { type: 'impact', region: step.region, size }, 1150);
              if (seen) sound.play(size > 0.55 ? 'bigboom' : 'boom');
              if (!still && seen && (mine || size > 0.6)) {
                // The board's shake scales with the fight (effects.css reads --io-quake).
                document.documentElement.style.setProperty('--io-quake', (0.5 + size).toFixed(2));
                onShake(size);
              }
              if (step.captured) {
                burst('capture', { type: 'capture', region: step.region, color: FACTIONS[step.winner].color }, 1450);
                if (seen) sound.play(step.winner === me ? 'capture' : 'kill');
                const ki = INSTALLATIONS[step.region];
                if (ki && step.winner === me) banner(`${BOARD.byId[step.region].name} secured`, FACTIONS[me].color, INSTALLATION_INFO[ki].label);
                else if (ki && step.defender?.owner === me) banner(`${BOARD.byId[step.region].name} lost`, '#d9452f', `to ${FACTIONS[step.winner].name}`);
              }
            },
            (seen ? REVEAL_MS : 120) / speed,
          );
          break;
        }
        case 'ELIMINATED': {
          card = step;
          banner(`${FACTIONS[step.who].short} wiped out`, FACTIONS[step.who].color);
          const where = pb ? Object.keys(pb.before.map).filter((r) => pb.before.map[r].owner === step.who) : [];
          if (where.length) burst('wipe', { type: 'wipe', regions: where.slice(0, 4), color: FACTIONS[step.who].color }, 1400);
          cue('knell', 0);
          break;
        }
        case 'SCORE': {
          card = step;
          // A star rises from every installation that scored, in its holder's colour.
          const gains = step.gains;
          const from = pb
            ? Object.keys(INSTALLATIONS)
                .filter((r) => pb.after.map[r] && gains[pb.after.map[r].owner])
                .map((r) => ({ region: r, color: FACTIONS[pb.after.map[r].owner].color }))
            : [];
          if (from.length) burst('stars', { type: 'stars', from }, 1100 + Math.min(12, from.length) * 70);
          cue('objective', 0);
          Object.keys(gains).forEach((_, k) => cue('tick', 450 + k * 180));
          break;
        }
        case 'RECOMMISSION':
          card = step;
          burst('launch', { type: 'launch', zone: step.zone, color: FACTIONS[step.owner].color }, 1100);
          break;
        default:
          card = step;
      }
      setPlayback((p) =>
        p
          ? {
              ...p,
              index: i,
              card,
              focus,
              naval,
              arrows: arrows ?? (step.kind === 'BATTLE' || step.kind === 'CLASH' ? p.arrows : []),
              sailed: p.sailed || step.kind !== 'NAVAL',
            }
          : p,
      );
    }
  }, [index, report, paused, later, clearAll, finish, addFx]);

  return { playback, paused, setPaused, start, skip: finish, fx, addFx, later };
}
