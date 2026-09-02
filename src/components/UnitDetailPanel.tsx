import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { isInSupplyRange } from '../game/engine';
import { AP_COSTS, Formation, GameState } from '../game/types';
import { TargetMode } from '../App.types';

const MORALE_COLOR: Record<string, string> = {
  Elite: 'var(--olive-bright)',
  Steady: 'var(--olive)',
  Stressed: 'var(--amber)',
  Shaken: 'var(--amber-dim)',
  Broken: 'var(--danger)',
};

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <div className="stat-bar">
        <div className="stat-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color ?? 'var(--olive)' }} />
      </div>
      <span className="stat-val">{Math.round(value)}%</span>
    </div>
  );
}

export const UnitDetailPanel: React.FC<{
  state: GameState;
  formation: Formation;
  targetMode: TargetMode;
  setTargetMode: (m: TargetMode) => void;
  onFortify: () => void;
  onRecon: () => void;
  onResupply: () => void;
  onAir: () => void;
}> = ({ state, formation: f, targetMode, setTargetMode, onFortify, onRecon, onResupply, onAir }) => {
  const def = FORMATION_DEFS[f.type];
  const ap = state.players[state.activePlayer].ap;
  const canAct = !f.hasActedThisTurn && f.owner === state.activePlayer;
  const supplied = isInSupplyRange(state, f);

  const btn = (label: string, cost: number, mode: TargetMode | null, onClick?: () => void, disabledExtra?: boolean) => {
    const disabled = !canAct || ap < cost || disabledExtra;
    return (
      <button
        key={label}
        className={`action-btn ${targetMode === mode ? 'active' : ''}`}
        disabled={disabled}
        onClick={() => {
          if (onClick) onClick();
          else if (mode) setTargetMode(mode);
        }}
        title={disabled ? 'Not enough AP or unit has already acted' : ''}
      >
        {label} <span className="ap-tag">{cost} AP</span>
      </button>
    );
  };

  return (
    <div className="unit-panel">
      <div className="panel-title">
        {f.name} <span className="unit-owner">{f.owner}</span>
      </div>
      <div className="unit-flavor">{def.flavor}</div>
      <div className="unit-order">Last order: {f.lastOrder}</div>

      <Stat label="Strength" value={f.strength} color="var(--olive)" />
      <Stat label="Readiness" value={f.readiness} color="var(--blue)" />
      <Stat label="Supply" value={f.supply} color={supplied ? 'var(--olive)' : 'var(--danger)'} />
      {def.maxAmmo !== null && <Stat label="Ammo" value={f.ammo} color="var(--amber)" />}
      <div className="stat-row">
        <span className="stat-label">Morale</span>
        <span className="morale-badge" style={{ color: MORALE_COLOR[f.morale] }}>
          {f.morale}
        </span>
      </div>
      {f.fortified && <div className="fortified-tag">FORTIFIED</div>}
      {!supplied && <div className="supply-warn">OUT OF SUPPLY RANGE</div>}

      <div className="panel-title" style={{ marginTop: 10 }}>
        ACTIONS
      </div>
      <div className="action-grid">
        {btn('Move', AP_COSTS.MOVE, 'MOVE')}
        {btn('Attack', AP_COSTS.ATTACK, 'ATTACK')}
        {f.type !== 'LOGISTICS' && f.type !== 'ENGINEER' && btn('Recon', AP_COSTS.RECON, null, onRecon)}
        {btn('Fortify', AP_COSTS.FORTIFY, null, onFortify)}
        {btn('Resupply', AP_COSTS.RESUPPLY, null, onResupply, !supplied)}
        {f.type === 'ARTILLERY' && btn('Fire Mission', AP_COSTS.ARTILLERY, 'ARTILLERY', undefined, f.ammo < 10)}
        {f.type === 'ENGINEER' && btn('Build Bridge', AP_COSTS.ENGINEER_BRIDGE, 'ENGINEER_BRIDGE')}
        {f.type === 'ENGINEER' && btn('Clear Obstacle', AP_COSTS.ENGINEER_CLEAR, 'ENGINEER_CLEAR')}
        {f.type === 'COMMANDO' && btn('Special Op', AP_COSTS.SPECIAL_OP, 'SPECIAL_OP')}
        {f.type === 'NAVAL_TRANSPORT' && btn('Amphibious Landing', AP_COSTS.AMPHIBIOUS, 'AMPHIBIOUS')}
        {btn('Air Strike (call-in)', AP_COSTS.AIR, 'AIR_TARGET', undefined, state.players[state.activePlayer].airSorties < 1)}
      </div>
      {targetMode && (
        <div className="target-hint">
          {targetMode === 'MOVE' && 'Click a highlighted tile to move.'}
          {targetMode === 'ATTACK' && 'Click a red-ringed enemy formation to attack.'}
          {targetMode === 'ARTILLERY' && 'Click a target tile within range (6) for a fire mission.'}
          {targetMode === 'AIR_TARGET' && 'Click a tile with a visible enemy formation to call an air strike.'}
          {targetMode === 'ENGINEER_BRIDGE' && 'Click an adjacent river tile to build a bridge.'}
          {targetMode === 'ENGINEER_CLEAR' && 'Click an adjacent tile to clear obstacles/fortification.'}
          {targetMode === 'SPECIAL_OP' && 'Click a tile within recon radius for a raid or deep recon.'}
          {targetMode === 'AMPHIBIOUS' && 'Select an embarked/adjacent formation, then a coastal destination tile.'}
          <button className="cancel-btn" onClick={() => setTargetMode(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};
