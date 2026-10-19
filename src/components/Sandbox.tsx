import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as engine from '../game/engine';
import { FORMATION_DEFS } from '../game/data';
import { randomScenario } from '../game/scenarios';
import { Camera, Overlays } from '../render/renderMap';
import { Formation, GameState, GRID_SIZE, PlayerId, otherPlayer } from '../game/types';
import { MapCanvas } from './MapCanvas';

type SandboxMode = 'SELECT' | 'REPOSITION' | 'MOVE' | 'ATTACK' | 'RECON' | 'FORTIFY';

/** A big-but-finite number, not Infinity — every downstream Math.min(cap, ap+x) stays well-behaved. */
const UNLIMITED_AP = 999;

/** Reset everything a real match would ration, so the next order is always free — see App-level doc below. */
function replenish(state: GameState) {
  state.players.SABRE.ap = UNLIMITED_AP;
  state.players.VANGUARD.ap = UNLIMITED_AP;
  state.players.SABRE.airSorties = 99;
  state.players.VANGUARD.airSorties = 99;
  state.players.SABRE.uavCharges = 99;
  state.players.VANGUARD.uavCharges = 99;
  Object.values(state.formations).forEach((f) => {
    f.movesUsed = 0;
    f.hasActedThisTurn = false;
    f.ammo = engine.maxAmmo(f);
  });
}

function freshState(): GameState {
  const scenario = randomScenario();
  const s = engine.initGame(scenario.seed, { mapName: scenario.name });
  replenish(s);
  return s;
}

/**
 * SANDBOX MODE (phase 11 §2) — free placement and free experimentation, no
 * server round-trip: it runs entirely client-side against the real, pure
 * engine functions in src/game/engine.ts (the same functions the server
 * calls), just with AP/moves/ammo replenished after every order so nothing
 * ever runs out and there is no turn structure to hand off. Combat, movement
 * legality, line of sight and detection are all the genuine rules — only the
 * RATIONING around them (AP, one action per round, ammo) is switched off, so
 * "what beats what" here is the same math a real match uses.
 *
 * REPOSITION is the one addition with no server equivalent: a raw teleport
 * (still gated on the destination being passable land/water for that
 * formation's arm, and unoccupied) for free placement, since there is no
 * movement-range concept worth respecting when the whole point is "put this
 * unit here and see what happens".
 */
export const Sandbox: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const [state, setState] = useState<GameState>(() => freshState());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<SandboxMode>('SELECT');
  const [side, setSide] = useState<PlayerId>('SABRE');
  const [camera, setCamera] = useState<Camera>({ x: GRID_SIZE / 2, y: GRID_SIZE / 2, scale: 11 });
  const [overlays] = useState<Overlays>({ movement: true, intel: true, objectives: true });
  const [note, setNote] = useState<string | null>('Sandbox — free placement, no AP limit, no turns. Esc to exit.');

  const selected = selectedId ? state.formations[selectedId] ?? null : null;

  const flash = useCallback((msg: string) => setNote(msg), []);

  const commit = useCallback(
    (mutator: (s: GameState) => { ok: boolean; reason: string } | unknown) => {
      let refused: string | null = null;
      setState((prev) => {
        // Engine functions mutate in place by convention — operate on the same
        // object, then hand React a fresh top-level reference to re-render.
        const res = mutator(prev) as { ok?: boolean; reason?: string } | undefined;
        // Same silent-no-op bug the live server fix closed: an order the
        // engine refused (bad range, no target, already acted, …) used to
        // leave sandbox play with no feedback either — surface it exactly
        // like the in-game toast does. No fog to worry about here: sandbox
        // is single-client, both sides fully visible, nothing to redact.
        if (res && res.ok === false && res.reason) refused = res.reason;
        replenish(prev);
        engine.refreshAllFog(prev);
        return { ...prev };
      });
      if (refused) flash(refused);
    },
    [flash]
  );

  const reset = useCallback(() => {
    setState(freshState());
    setSelectedId(null);
    setMode('SELECT');
    setNote('Sandbox reset — a fresh curated map, both full rosters redeployed.');
  }, []);

  // Self-contained capture-phase keyboard handling, same pattern as every
  // other modal/overlay in this app (Tutorial/HelpPanel/Briefing): Escape
  // exits back to the landing page, and stopPropagation keeps this the only
  // listener that sees the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (mode !== 'SELECT') setMode('SELECT');
        else onExit();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, onExit]);

  const handleFormationClick = (f: Formation) => {
    if (mode === 'ATTACK' && selected && f.owner !== selected.owner) {
      commit((s) => engine.attackAction(s, selected.id, f.id));
      setMode('SELECT');
      return;
    }
    setSelectedId(f.id);
    setSide(f.owner);
    if (mode !== 'REPOSITION') setMode('SELECT');
  };

  const isPassableFor = (f: Formation, x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return false;
    const tile = state.tiles[y][x];
    const naval = FORMATION_DEFS[f.type].isNaval;
    if (naval) return tile.terrain === 'WATER' && !!tile.navigable;
    return tile.terrain !== 'WATER' || !!tile.bridge;
  };

  const handleTileClick = (x: number, y: number) => {
    if (!selected) return;
    switch (mode) {
      case 'REPOSITION': {
        if (!isPassableFor(selected, x, y)) {
          flash('That tile is not passable ground for this formation.');
          return;
        }
        if (engine.formationAt(state, x, y)) {
          flash('That tile is already occupied.');
          return;
        }
        commit((s) => {
          const f = s.formations[selected.id];
          if (f) {
            f.x = x;
            f.y = y;
            f.fortified = false;
            f.fortifyTier = 0;
          }
        });
        break;
      }
      case 'MOVE':
        commit((s) => engine.moveFormation(s, selected.id, x, y));
        setMode('SELECT');
        break;
      case 'ATTACK': {
        const target = engine.formationAt(state, x, y);
        if (target && target.owner !== selected.owner) commit((s) => engine.attackAction(s, selected.id, target.id));
        setMode('SELECT');
        break;
      }
      default:
        break;
    }
  };

  const roster = useMemo(
    () => Object.values(state.formations).filter((f) => f.owner === side).sort((a, b) => a.shortName.localeCompare(b.shortName)),
    [state.formations, side]
  );

  return (
    <div className="app-root sandbox-root" data-testid="sandbox">
      <MapCanvas
        state={state}
        viewer={side}
        selected={selected}
        overlays={overlays}
        targetMode={mode === 'SELECT' ? null : mode}
        onTileClick={handleTileClick}
        onFormationClick={(f) => handleFormationClick(f)}
        camera={camera}
        setCamera={setCamera}
      />

      <div className="sandbox-hud" data-testid="sandbox-hud">
        <div className="sandbox-hud-head">
          <b>SANDBOX</b>
          <span>{state.mapName}</span>
        </div>
        <div className="sandbox-side-toggle" role="group" aria-label="Controlling side">
          {(['SABRE', 'VANGUARD'] as PlayerId[]).map((p) => (
            <button
              key={p}
              className={`sandbox-side-btn ${side === p ? 'active' : ''}`}
              onClick={() => setSide(p)}
              data-testid={`sandbox-side-${p}`}
            >
              {p}
            </button>
          ))}
        </div>
        {note && <div className="sandbox-note">{note}</div>}
        {selected ? (
          <div className="sandbox-selected">
            <div className="sandbox-selected-name">
              {selected.shortName} ({selected.owner}) — {Math.round(selected.strength)}% strength
            </div>
            <div className="sandbox-actions">
              <button className={`btn-secondary small ${mode === 'REPOSITION' ? 'active' : ''}`} onClick={() => setMode('REPOSITION')} data-testid="sandbox-reposition">
                Reposition
              </button>
              <button className={`btn-secondary small ${mode === 'MOVE' ? 'active' : ''}`} onClick={() => setMode('MOVE')} data-testid="sandbox-move">
                Move
              </button>
              <button className={`btn-secondary small ${mode === 'ATTACK' ? 'active' : ''}`} onClick={() => setMode('ATTACK')} data-testid="sandbox-attack">
                Attack
              </button>
              <button
                className="btn-secondary small"
                onClick={() => {
                  commit((s) => engine.reconAction(s, selected.id));
                  setMode('SELECT');
                }}
                data-testid="sandbox-recon"
              >
                Recon
              </button>
              <button
                className="btn-secondary small"
                onClick={() => {
                  commit((s) => engine.fortifyAction(s, selected.id));
                  setMode('SELECT');
                }}
                data-testid="sandbox-fortify"
              >
                Fortify
              </button>
              <button className="btn-ghost small" onClick={() => setMode('SELECT')}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="sandbox-note">Click a formation on the map or below to select it.</div>
        )}

        <div className="sandbox-roster" data-testid="sandbox-roster">
          {roster.map((f) => (
            <button
              key={f.id}
              className={`sandbox-roster-row ${selectedId === f.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedId(f.id);
                setMode('SELECT');
              }}
            >
              <span>{f.shortName}</span>
              <span className="sandbox-roster-str">{Math.round(f.strength)}%</span>
            </button>
          ))}
        </div>

        <div className="sandbox-foot">
          <button className="btn-secondary small" onClick={reset} data-testid="sandbox-reset">
            Reset
          </button>
          <button className="btn-ghost small" onClick={onExit} data-testid="sandbox-exit">
            Exit (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
