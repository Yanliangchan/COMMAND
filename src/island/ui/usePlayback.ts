// ============================================================================
// Playback director: walks a resolved round's report step by step — sets the
// card, the arrows and the camera focus, fires effects and sounds, and reveals
// each battle's result on the map a beat after its card appears.
//
// Every timer it starts is tracked, so Skip, a new round or leaving the match
// cancels them all; nothing from a skipped round can land in the next one.
// Steps the player couldn't see (fog) flip the map's colours without a card.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { sound } from '../../audio/sound';
import { BOARD, INSTALLATIONS, INSTALLATION_INFO, ZoneId } from '../map';
import { sharedZones } from '../engine';
import { FACTIONS, FactionId, GameState, ReportStep, RoundReport } from '../types';
import type { Badge, Focus, Fx, OrderArrow } from './MapView';

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

/** Whether the viewer gets this step's detail: they took part, or could see where it happened. */
export function stepSeen(step: ReportStep, me: FactionId, spectator: boolean): boolean {
  if (spectator) return true;
  if (step.kind === 'BATTLE') return step.defender?.owner === me || step.attackers.some((a) => a.owner === me) || !step.seen || step.seen.includes(me);
  if (step.kind === 'CLASH') return step.a.owner === me || step.b.owner === me || !step.seen || step.seen.includes(me);
  if (step.kind === 'STRIKE') return step.by === me || !step.seen || step.seen.includes(me);
  return true;
}

export interface Director {
  playback: Playback | null;
  paused: boolean;
  setPaused: (p: boolean) => void;
  start: (report: RoundReport, before: GameState, after: GameState) => void;
  skip: () => void;
  fx: Fx[];
  addFx: (f: Fx, ms: number) => void;
  /** Schedule something that must not outlive the current round. */
  later: (fn: () => void, ms: number) => void;
}

export function usePlayback(opts: {
  me: FactionId;
  spectator: boolean;
  speed: 1 | 2;
  banner: (title: string, color: string, sub?: string) => void;
  onShake: () => void;
  onFinish: (pb: Playback) => void;
}): Director {
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [paused, setPaused] = useState(false);
  const [fx, setFx] = useState<Fx[]>([]);
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

  const addFx = useCallback(
    (f: Fx, ms: number) => {
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
    const prevMs = prev ? (stepSeen(prev, me, spectator) ? STEP_MS[prev.kind] ?? 800 : UNSEEN_MS) : 500;
    const wait = prevMs / speed;
    const tick = (fn: () => void, ms: number) => {
      clearTimeout(stepTimer.current);
      stepTimer.current = window.setTimeout(fn, ms);
    };
    if (next >= steps.length) tick(finish, 350 / speed);
    else tick(() => play(steps[next], next), wait);
    return () => clearTimeout(stepTimer.current);

    function play(step: ReportStep, i: number) {
      const { banner, onShake } = optsRef.current;
      const seen = stepSeen(step, me, spectator);
      let card: ReportStep | null = null;
      let focus: Focus | null = null;
      let naval: ZoneId | null = null;
      let arrows: OrderArrow[] | undefined;
      switch (step.kind) {
        case 'NAVAL':
          card = step;
          naval = step.zone;
          focus = { zone: step.zone };
          sound.play('attack');
          break;
        case 'STRIKE': {
          // The jet comes in first; the bombs land as it passes over.
          focus = seen ? { region: step.region } : null;
          addFx({ id: `jet-${i}`, kind: 'jet', region: step.region, color: FACTIONS[step.by].color }, 900 / speed);
          later(() => {
            addFx({ id: `strike-${i}`, kind: 'blast', region: step.region, color: '#fff' }, 1000);
            sound.play('attack');
          }, 480 / speed);
          break;
        }
        case 'MOVES':
          arrows = step.moves.map((m, k) => ({
            id: `mv-${k}`,
            from: m.from,
            to: m.to,
            color: FACTIONS[m.owner].color,
            label: String(m.count),
            via: m.landing ? sharedZones(m.from, m.to)[0] : undefined,
            travel: true,
          }));
          sound.play('move');
          break;
        case 'CLASH':
          if (seen) {
            card = step;
            focus = { between: step.at };
            sound.play('attack');
          }
          break;
        case 'BATTLE': {
          const mine = step.defender?.owner === me || step.attackers.some((a) => a.owner === me);
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
              addFx({ id: `boom-${i}`, kind: 'blast', region: step.region, color: '#fff' }, 900);
              if (mine) onShake();
              if (step.captured) {
                addFx({ id: `cap-${i}`, kind: 'ripple', region: step.region, color: FACTIONS[step.winner].color }, 1300);
                if (seen) sound.play('kill');
                const ki = INSTALLATIONS[step.region];
                if (ki && step.winner === me) banner(`${BOARD.byId[step.region].name} secured`, FACTIONS[me].color, INSTALLATION_INFO[ki].label);
                else if (ki && step.defender?.owner === me) banner(`${BOARD.byId[step.region].name} lost`, '#d9452f', `to ${FACTIONS[step.winner].name}`);
              }
            },
            (seen ? 850 : 120) / speed,
          );
          break;
        }
        case 'ELIMINATED':
          card = step;
          banner(`${FACTIONS[step.who].short} wiped out`, FACTIONS[step.who].color);
          break;
        case 'SCORE':
          card = step;
          sound.play('objective');
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
