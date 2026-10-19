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

/** Shows the last roll of a battle: a short tumble, then the faces settle and losers grey out. */
export function DiceTray({ battle, compact }: { battle: Battle; compact?: boolean }) {
  const [rolling, setRolling] = useState(true);
  const [tumble, setTumble] = useState(0);
  useEffect(() => {
    setRolling(true);
    const spin = setInterval(() => setTumble((t) => t + 1), 70);
    const stop = setTimeout(() => {
      clearInterval(spin);
      setRolling(false);
    }, compact ? 350 : 550);
    return () => {
      clearInterval(spin);
      clearTimeout(stop);
    };
  }, [battle, compact]);

  const roll = battle.rolls[battle.rolls.length - 1];
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
            <Die key={i} value={rolling ? fake(i) : v} color={atk.color} rolling={rolling} lost={!rolling && i < pairs && v <= roll.def[i]} />
          ))}
        </div>
        <div className="io-dice-row">
          {roll.def.map((v, i) => (
            <Die
              key={i}
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
          {battle.rolls.length > 1 && <span className="io-dice-blitz">BLITZ ×{battle.rolls.length}</span>}
          <span>
            <b style={{ color: atk.color }}>{atk.short}</b> −{battle.atkLoss}
          </span>
          <span>
            <b style={{ color: def.color }}>{def.short}</b> −{battle.defLoss}
          </span>
          {battle.captured && <span className="io-dice-captured">CAPTURED!</span>}
        </div>
      )}
    </div>
  );
}
