import React, { useEffect, useRef, useState } from 'react';
import { useGameStore } from './game/store';
import { TopBar } from './components/TopBar';
import { FormationList } from './components/FormationList';
import { UnitDetailPanel } from './components/UnitDetailPanel';
import { MapCanvas } from './components/MapCanvas';
import { OverlayToggles } from './components/OverlayToggles';
import { BattleReportModal } from './components/BattleReportModal';
import { TurnHandoffScreen } from './components/TurnHandoffScreen';
import { EndGameScreen } from './components/EndGameScreen';
import { Camera, Overlays } from './render/renderMap';
import { TargetMode } from './App.types';
import { distance, formationAt, refreshFogOfWar } from './game/engine';
import { Formation } from './game/types';

export default function App() {
  const { state, actions } = useGameStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(null);
  const [camera, setCamera] = useState<Camera>({ x: 20, y: 30, scale: 11 });
  const [overlays, setOverlays] = useState<Overlays>({ terrain: true, movement: true, intel: true, supply: false, objectives: true });
  const [showReportId, setShowReportId] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);

  const selected = selectedId ? state.formations[selectedId] ?? null : null;

  useEffect(() => {
    // Dev/QA hook only — lets automated smoke tests drive the game without
    // clicking through pixel-exact canvas coordinates. Harmless in prod.
    (window as any).__COMMAND_DEBUG__ = { state, actions, setSelectedId, setCamera, refreshFogOfWar };
  });

  useEffect(() => {
    if (state.lastBattleReport && state.lastBattleReport.id !== shownRef.current) {
      shownRef.current = state.lastBattleReport.id;
      setShowReportId(state.lastBattleReport.id);
    }
  }, [state.lastBattleReport]);

  useEffect(() => {
    // Recenter camera on the active player's forces when the turn changes.
    const mine = Object.values(state.formations).filter((f) => f.owner === state.activePlayer);
    if (mine.length) {
      const avgX = mine.reduce((s, f) => s + f.x, 0) / mine.length;
      const avgY = mine.reduce((s, f) => s + f.y, 0) / mine.length;
      setCamera((c) => ({ ...c, x: avgX, y: avgY }));
    }
    setSelectedId(null);
    setTargetMode(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activePlayer, state.round]);

  const clearMode = () => setTargetMode(null);

  const handleFormationClick = (f: Formation) => {
    if (targetMode === 'ATTACK' && selected) {
      if (f.owner !== selected.owner) {
        actions.attack(selected.id, f.id);
        clearMode();
        return;
      }
    }
    if (targetMode === 'AIR_TARGET') {
      if (f.owner !== state.activePlayer) {
        actions.air(f.x, f.y);
        clearMode();
        return;
      }
    }
    if (f.owner === state.activePlayer) {
      setSelectedId(f.id);
      if (!targetMode) clearMode();
    }
  };

  const handleTileClick = (x: number, y: number) => {
    if (!selected) return;
    switch (targetMode) {
      case 'MOVE':
        actions.move(selected.id, x, y);
        clearMode();
        break;
      case 'ATTACK': {
        const f = formationAt(state, x, y);
        if (f && f.owner !== selected.owner) actions.attack(selected.id, f.id);
        clearMode();
        break;
      }
      case 'ARTILLERY':
        actions.artillery(selected.id, x, y);
        clearMode();
        break;
      case 'AIR_TARGET':
        actions.air(x, y);
        clearMode();
        break;
      case 'ENGINEER_BRIDGE':
        actions.engineerBridge(selected.id, x, y);
        clearMode();
        break;
      case 'ENGINEER_CLEAR':
        actions.engineerClear(selected.id, x, y);
        clearMode();
        break;
      case 'SPECIAL_OP':
        actions.specialOp(selected.id, x, y);
        clearMode();
        break;
      case 'AMPHIBIOUS': {
        const cargo = Object.values(state.formations).find(
          (o) => o.owner === selected.owner && o.id !== selected.id && distance(o.x, o.y, selected.x, selected.y) <= 1 && o.type !== 'FRIGATE' && o.type !== 'NAVAL_TRANSPORT'
        );
        if (cargo) actions.amphibious(selected.id, cargo.id, x, y);
        clearMode();
        break;
      }
      default:
        break;
    }
  };

  const objectivesCaptured = state.objectives.filter((o) => o.controlledBy === state.activePlayer).length;

  const showHandoff = state.phase === 'TURN_HANDOFF';
  const showGameOver = state.phase === 'GAME_OVER';
  const report = showReportId && state.lastBattleReport?.id === showReportId ? state.lastBattleReport : null;

  return (
    <div className="app-root">
      <TopBar state={state} />
      <div className="main-area">
        <div className="left-panel">
          <FormationList state={state} viewer={state.activePlayer} selectedId={selectedId} onSelect={(f) => setSelectedId(f.id)} />
        </div>
        <div className="center-area">
          <OverlayToggles overlays={overlays} setOverlays={setOverlays} />
          <div className="canvas-wrap">
            <MapCanvas
              state={state}
              viewer={state.activePlayer}
              selected={selected}
              overlays={overlays}
              targetMode={targetMode}
              onTileClick={handleTileClick}
              onFormationClick={handleFormationClick}
              camera={camera}
              setCamera={setCamera}
            />
          </div>
        </div>
        <div className="right-panel">
          {selected ? (
            <UnitDetailPanel
              state={state}
              formation={selected}
              targetMode={targetMode}
              setTargetMode={setTargetMode}
              onFortify={() => actions.fortify(selected.id)}
              onRecon={() => actions.recon(selected.id)}
              onResupply={() => actions.resupply(selected.id)}
              onAir={() => actions.air(selected.x, selected.y)}
            />
          ) : (
            <div className="unit-panel empty">
              <div className="panel-title">NO UNIT SELECTED</div>
              <p className="hint-text">Select a formation from the list or click one on the battlefield.</p>
            </div>
          )}
        </div>
      </div>
      <div className="bottom-bar">
        <div className="bottom-left">
          AP Remaining: <b>{state.players[state.activePlayer].ap}</b>
        </div>
        <div className="bottom-center">
          Objectives Held: {objectivesCaptured} / {state.objectives.length}
        </div>
        <div className="bottom-right">
          <button className="end-turn-btn" onClick={() => actions.endTurn()}>
            End Turn →
          </button>
        </div>
      </div>

      {report && <BattleReportModal report={report} onClose={() => setShowReportId(null)} />}
      {showHandoff && <TurnHandoffScreen state={state} onContinue={() => actions.beginPlayerTurn()} />}
      {showGameOver && <EndGameScreen state={state} onRestart={() => actions.reset()} />}
    </div>
  );
}
