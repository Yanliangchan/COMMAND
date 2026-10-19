import { useEffect, useState } from 'react';
import { BOARD } from '../map';
import { FACTIONS, GameEvent } from '../types';

type Battle = Extract<GameEvent, { kind: 'BATTLE' }>;

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]],
};

export function Die({ value, color, lost, rolling, bonus }: { value: number; color: string; lost?: boolean; rolling?: boolean; bonus?: boolean }) {
  const face = Math.min(6, Math.max(1, value));
  return (
    <div className={`io-die${lost ? ' io-die-lost' : ''}${rolling ? ' io-die-rolling' : ''}`} style={{ background: color }}>
      <svg viewBox="0 0 100 100">
        {PIPS[face].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={9.5} fill="#fff" />
        ))}
      </svg>
      {bonus && <span className="io-die-bonus">+1</span>}
    </div>
  );
}

function timing(battle: Battle, compact?: boolean) {
  const tumble = compact ? 300 : 500;
  const steps = battle.rolls.length - 1;
  // A long Blitz still plays every roll, just faster, so the cascade never drags.
  const step = steps ? Math.min(compact ? 140 : 300, (compact ? 900 : 2400) / steps) : 0;
  return { tumble, step, steps };
}

/** How long the tray needs on screen to play out and still be read. */
export function trayDuration(battle: Battle, compact?: boolean): number {
  const t = timing(battle, compact);
  return t.tumble + t.step * t.steps + (compact ? 900 : 1900);
}

/**
 * A short tumble, then every roll of the battle in turn (a Blitz cascades
 * through them with a running tally), settling on the last.
 */
export function DiceTray({ battle, compact }: { battle: Battle; compact?: boolean }) {
  const [rolling, setRolling] = useState(true);
  const [tumble, setTumble] = useState(0);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const t = timing(battle, compact);
    setRolling(true);
    setIndex(0);
    const timers: number[] = [];
    const spin = window.setInterval(() => setTumble((x) => x + 1), 70);
    timers.push(
      window.setTimeout(() => {
        clearInterval(spin);
        setRolling(false);
      }, t.tumble),
    );
    for (let i = 1; i <= t.steps; i++) timers.push(window.setTimeout(() => setIndex(i), t.tumble + t.step * i));
    return () => {
      clearInterval(spin);
      timers.forEach(clearTimeout);
    };
  }, [battle, compact]);

  // A new battle can arrive while the last one's cascade is mid-way; never read past its rolls.
  const at = Math.min(index, battle.rolls.length - 1);
  const roll = battle.rolls[at];
  const done = !rolling && at === battle.rolls.length - 1;
  const shown = battle.rolls.slice(0, at + 1);
  const atkLoss = rolling ? 0 : shown.reduce((n, r) => n + r.atkLoss, 0);
  const defLoss = rolling ? 0 : shown.reduce((n, r) => n + r.defLoss, 0);
  const atk = FACTIONS[battle.attacker], def = FACTIONS[battle.defender];
  const pairs = Math.min(roll.atk.length, roll.def.length);
  const fake = (i: number) => 1 + ((tumble * 7 + i * 3) % 6);

  return (
    <div className={`io-dice-tray${compact ? ' io-dice-compact' : ''}`}>
      <div className="io-dice-head">
        <span style={{ color: atk.color }}>{BOARD.byId[battle.from].name}</span>
        <span className="io-dice-vs">{battle.mode === 'AMPHIBIOUS' ? '⚓ landing on' : 'attacks'}</span>
        <span style={{ color: def.color }}>{BOARD.byId[battle.to].name}</span>
      </div>
      <div className="io-dice-rows">
        <div className="io-dice-row">
          {roll.atk.map((v, i) => (
            <Die key={`${at}-${i}`} value={rolling ? fake(i) : v} color={atk.color} rolling={rolling} lost={!rolling && i < pairs && v <= roll.def[i]} />
          ))}
        </div>
        <div className="io-dice-row">
          {roll.def.map((v, i) => (
            <Die
              key={`${at}-${i}`}
              value={rolling ? fake(i + 3) : i === 0 && roll.stronghold ? v - 1 : v}
              bonus={!rolling && i === 0 && roll.stronghold}
              color={def.color}
              rolling={rolling}
              lost={!rolling && i < pairs && roll.atk[i] > v}
            />
          ))}
        </div>
      </div>
      {!rolling && (
        <div className="io-dice-result">
          {battle.rolls.length > 1 && (
            <span className="io-dice-blitz">
              BLITZ {at + 1}/{battle.rolls.length}
            </span>
          )}
          <span>
            <b style={{ color: atk.color }}>{atk.short}</b> −{atkLoss}
          </span>
          <span>
            <b style={{ color: def.color }}>{def.short}</b> −{defLoss}
          </span>
          {done && battle.captured && <span className="io-dice-captured">CAPTURED!</span>}
          {done && !battle.captured && battle.rolls.length > 1 && <span className="io-dice-held">HELD</span>}
        </div>
      )}
    </div>
  );
}
