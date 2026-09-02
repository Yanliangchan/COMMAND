import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { isInSupplyRange, movesRemaining } from '../game/engine';
import { Formation, GameState } from '../game/types';

const MORALE_COLOR: Record<string, string> = {
  Elite: 'var(--olive-bright)',
  Steady: 'var(--olive)',
  Stressed: 'var(--amber)',
  Shaken: 'var(--amber-dim)',
  Broken: 'var(--danger)',
};

function Bar({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <div className="stat-bar">
        <div className="stat-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color ?? 'var(--olive)' }} />
      </div>
      <span className="stat-val">{Math.round(value)}</span>
    </div>
  );
}

/**
 * Compact selected-unit card. It floats over the sheet and is deliberately
 * short: identity, condition, what it has left to give this round.
 */
export const UnitDetailPanel: React.FC<{
  state: GameState;
  formation: Formation;
  onCentre: () => void;
  onClose: () => void;
}> = ({ state, formation: f, onCentre, onClose }) => {
  const def = FORMATION_DEFS[f.type];
  const supplied = isInSupplyRange(state, f);
  const movesLeft = movesRemaining(f);

  return (
    <div className="unit-card">
      <div className="unit-card-head">
        <div>
          <div className="unit-card-short">{f.shortName}</div>
          <div className="unit-card-name">{f.name}</div>
        </div>
        <div className="unit-card-head-btns">
          <button className="icon-btn" title="Centre the camera on this formation (Z)" onClick={onCentre}>
            ⌖
          </button>
          <button className="icon-btn" title="Clear selection (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="unit-card-meta">
        {def.label} · {f.echelon} · {f.arm}
      </div>
      <div className="unit-card-equip">{f.equipment}</div>

      <div className="unit-card-chips">
        <span className={`mini-chip ${movesLeft > 0 ? 'chip-live' : 'chip-spent'}`} title="Movement actions used this round">
          {f.movesUsed} / {f.movesMax} movement actions
        </span>
        <span className={`mini-chip ${f.hasActedThisTurn ? 'chip-spent' : 'chip-live'}`} title="Major action (attack, recon, fortify, …)">
          {f.hasActedThisTurn ? 'major action used' : 'major action ready'}
        </span>
        {f.fortified && <span className="mini-chip chip-amber">fortified</span>}
        {!supplied && <span className="mini-chip chip-danger">out of supply</span>}
      </div>

      <Bar label="Strength" value={f.strength} color="var(--olive)" />
      <Bar label="Readiness" value={f.readiness} color="var(--blue)" />
      <Bar label="Supply" value={f.supply} color={supplied ? 'var(--olive)' : 'var(--danger)'} />
      {def.maxAmmo !== null && <Bar label="Ammo" value={f.ammo} color="var(--amber)" />}

      <div className="unit-card-rows">
        <div>
          <span className="k">Morale</span>
          <span className="v" style={{ color: MORALE_COLOR[f.morale] }}>
            {f.morale}
          </span>
        </div>
        <div>
          <span className="k">Attack range</span>
          <span className="v">{def.attackRange} tiles</span>
        </div>
        <div>
          <span className="k">Sight / recon</span>
          <span className="v">
            {def.sightRadius} / {def.reconRadius}
          </span>
        </div>
      </div>
      <div className="unit-card-order">
        <span className="k">Current orders</span> {f.lastOrder}
      </div>
    </div>
  );
};
