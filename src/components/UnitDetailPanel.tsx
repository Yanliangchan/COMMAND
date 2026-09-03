import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { canReorganize, maxAmmo, movesRemaining, usesAmmo } from '../game/engine';
import { movementProfile, supportedFormation } from '../game/movement';
import { currentDetectionRange, detectionModifiers } from '../game/detection';
import { COHESION_RADIUS, DETECTION, Formation, GameState, REORGANIZE_COOLDOWN_ROUNDS, gridRef } from '../game/types';

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
  const movesLeft = movesRemaining(f);
  const mv = movementProfile(f);
  const partner = supportedFormation(state, f);
  // Passive detection is situational — the number quoted is what this formation
  // actually achieves from the ground it is standing on right now.
  const detect = currentDetectionRange(state, f);
  const sweep = currentDetectionRange(state, f, true);
  const detectMods = detectionModifiers(state, f);
  const partnerDistance = partner ? Math.abs(partner.x - f.x) + Math.abs(partner.y - f.y) : 0;
  const separated = !!partner && partnerDistance > COHESION_RADIUS;

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
        {f.onAlert && (
          <span className="mini-chip chip-alert" title="No reaction shot fired yet this alert period — reacts once to an enemy that moves into range and line of sight." data-testid="alert-chip">
            ⚠ on alert
          </span>
        )}
        {canReorganize(state, f) && f.owner === state.activePlayer && (
          <span className="mini-chip chip-reorg" title="No move made this round and off cooldown — press S to stand down and reconstitute." data-testid="reorg-ready-chip">
            ● reorganize ready
          </span>
        )}
      </div>

      <div className="unit-move-block" data-testid="unit-movement">
        <div className="unit-move-row">
          <span className="k">Movement</span>
          <span className="v" data-testid="movement-range">
            {mv.effectiveRange} tiles
          </span>
        </div>
        <div className="unit-move-row">
          <span className="k">Movement Actions</span>
          <span className={`v ${movesLeft > 0 ? '' : 'spent'}`} data-testid="movement-actions">
            {movesLeft} / {mv.movesMax}
          </span>
        </div>
        <div className="unit-move-row">
          <span className="k">On roads</span>
          <span className="v">{mv.roadRange} tiles</span>
        </div>
        <div className="unit-move-note">
          {mv.mobilityLabel}
          {mv.roughMultiplier > 1 && ` · forest / built-up going ×${mv.roughMultiplier}`}
        </div>
        {mv.modifiers.map((m) => (
          <div className="unit-move-note warn" key={m.label} data-testid="movement-modifier">
            Range reduced ×{m.multiplier} — {m.label}
          </div>
        ))}
      </div>

      <Bar label="Strength" value={f.strength} color="var(--olive)" />
      <Bar label="Readiness" value={f.readiness} color="var(--blue)" />
      {/* Suppression (phase 7) — a distinct bar, never folded into readiness or
          morale. 0 unless the formation has actually been suppressed, and
          redacted (-1) for an enemy known only to IDENTIFIED. */}
      {f.suppression >= 0 && (
        <Bar label="Suppression" value={f.suppression} color="#8a6fae" />
      )}
      {/* Ammunition (phase 6) — whole rounds, drawn as pips, and shown ONLY for
          the guns and the ships that actually use them. Everything else has no
          ammunition line at all, which is one fewer number to read. */}
      {usesAmmo(f) && (
        <div className="stat-row" data-testid="ammo-row">
          <span className="stat-label">Ammunition</span>
          <div className="ammo-pips" title="Ready fire missions. One comes back at the end of any round this formation does not fire.">
            {Array.from({ length: maxAmmo(f) }).map((_, i) => (
              <span key={i} className={`ammo-pip ${i < f.ammo ? 'full' : ''}`} />
            ))}
          </div>
          <span className="stat-val" data-testid="ammo-count">
            {f.ammo} / {maxAmmo(f)}
          </span>
        </div>
      )}

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
          <span className="k">Detection range</span>
          <span className="v" data-testid="detection-range" title="Passive spotting range from this tile — no order or AP required.">
            {detect} tiles {detect !== DETECTION[f.type].baseRange && <em>(base {DETECTION[f.type].baseRange})</em>}
          </span>
        </div>
        <div>
          <span className="k">Recon sweep (R)</span>
          <span className="v" data-testid="recon-range" title="Range of a deliberate Recon order — sees through cover and identifies contacts.">
            {sweep} tiles
          </span>
        </div>
      </div>
      <div className="unit-card-rows">
        <div>
          <span className="k">Grid</span>
          <span className="v" data-testid="unit-grid">{gridRef(f.x, f.y)}</span>
        </div>
        {partner && (
          <div>
            <span className="k">Supporting</span>
            <span className="v" style={{ color: separated ? 'var(--danger)' : undefined }} data-testid="support-link">
              {partner.shortName} — {partnerDistance} tiles{separated ? ' (separated)' : ''}
            </span>
          </div>
        )}
      </div>
      <div className="unit-detect-block" data-testid="unit-detection">
        <div className="unit-move-note">{DETECTION[f.type].sensorLabel}</div>
        {detectMods.map((m) => (
          <div className={`unit-move-note ${m.good ? 'good' : 'warn'}`} key={m.label} data-testid="detection-modifier">
            {m.good ? '▲' : '▼'} {m.label}
          </div>
        ))}
      </div>

      {f.lastReorganizedRound > 0 && state.round - f.lastReorganizedRound < REORGANIZE_COOLDOWN_ROUNDS && (
        <div className="unit-move-note warn" data-testid="reorganize-cooldown">
          Reorganize on cooldown — ready again in {REORGANIZE_COOLDOWN_ROUNDS - (state.round - f.lastReorganizedRound)} round
          {REORGANIZE_COOLDOWN_ROUNDS - (state.round - f.lastReorganizedRound) === 1 ? '' : 's'}.
        </div>
      )}

      <div className="unit-card-order">
        <span className="k">Current orders</span> {f.lastOrder}
      </div>
    </div>
  );
};
