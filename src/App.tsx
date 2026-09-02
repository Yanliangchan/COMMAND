import React, { useEffect, useRef, useState } from 'react';
import { useMultiplayer } from './net/client';
import { TopBar } from './components/TopBar';
import { FormationList } from './components/FormationList';
import { UnitDetailPanel } from './components/UnitDetailPanel';
import { MapCanvas } from './components/MapCanvas';
import { OverlayToggles } from './components/OverlayToggles';
import { BattleReportModal } from './components/BattleReportModal';
import { EndGameScreen } from './components/EndGameScreen';
import { Lobby } from './components/Lobby';
import { Camera, Overlays } from './render/renderMap';
import { TargetMode } from './App.types';
import { computeReachable, distance, formationAt } from './game/engine';
import { Formation } from './game/types';

export default function App() {
  const net = useMultiplayer();
  const { state, you } = net;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(null);
  const [camera, setCamera] = useState<Camera>({ x: 20, y: 30, scale: 11 });
  const [overlays, setOverlays] = useState<Overlays>({ terrain: true, movement: true, intel: true, supply: false, objectives: true });
  const [showReportId, setShowReportId] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);
  const lastRoundRef = useRef<number | null>(null);

  const selected = state && selectedId ? state.formations[selectedId] ?? null : null;

  useEffect(() => {
    // Dev/QA hook only — lets automated smoke tests inspect connection + game
    // state without clicking through pixel-exact canvas coordinates.
    (window as any).__COMMAND_DEBUG__ = { net, state, you, setSelectedId, setCamera, computeReachable };
  });

  useEffect(() => {
    if (state?.lastBattleReport && state.lastBattleReport.id !== shownRef.current) {
      shownRef.current = state.lastBattleReport.id;
      setShowReportId(state.lastBattleReport.id);
    }
  }, [state?.lastBattleReport]);

  useEffect(() => {
    if (!state || !you) return;
    // Recenter the camera on the viewer's own forces the first time their
    // game state arrives, and whenever a new round starts.
    if (lastRoundRef.current === state.round) return;
    lastRoundRef.current = state.round;
    const mine = Object.values(state.formations).filter((f) => f.owner === you);
    if (mine.length) {
      const avgX = mine.reduce((s, f) => s + f.x, 0) / mine.length;
      const avgY = mine.reduce((s, f) => s + f.y, 0) / mine.length;
      setCamera((c) => ({ ...c, x: avgX, y: avgY }));
    }
  }, [state, you]);

  useEffect(() => {
    setSelectedId(null);
    setTargetMode(null);
  }, [state?.activePlayer]);

  if (!state || !you) {
    return (
      <Lobby
        status={net.status}
        roomCode={net.roomCode}
        error={net.error}
        onCreate={net.createRoom}
        onJoin={net.joinRoom}
        onQuickMatch={net.quickMatch}
        onVsBot={net.vsBot}
        onCancel={net.leaveToLobby}
      />
    );
  }

  const myTurn = state.activePlayer === you;

  const clearMode = () => setTargetMode(null);

  const handleFormationClick = (f: Formation) => {
    if (targetMode === 'ATTACK' && selected) {
      if (f.owner !== selected.owner) {
        net.sendAction({ type: 'ATTACK', attackerId: selected.id, targetId: f.id });
        clearMode();
        return;
      }
    }
    if (targetMode === 'AIR_TARGET') {
      if (f.owner !== you) {
        net.sendAction({ type: 'AIR', x: f.x, y: f.y });
        clearMode();
        return;
      }
    }
    if (f.owner === you) {
      setSelectedId(f.id);
      if (!targetMode) clearMode();
    }
  };

  const handleTileClick = (x: number, y: number) => {
    if (!selected) return;
    switch (targetMode) {
      case 'MOVE':
        net.sendAction({ type: 'MOVE', formationId: selected.id, x, y });
        clearMode();
        break;
      case 'ATTACK': {
        const f = formationAt(state, x, y);
        if (f && f.owner !== selected.owner) net.sendAction({ type: 'ATTACK', attackerId: selected.id, targetId: f.id });
        clearMode();
        break;
      }
      case 'ARTILLERY':
        net.sendAction({ type: 'ARTILLERY', formationId: selected.id, x, y });
        clearMode();
        break;
      case 'AIR_TARGET':
        net.sendAction({ type: 'AIR', x, y });
        clearMode();
        break;
      case 'ENGINEER_BRIDGE':
        net.sendAction({ type: 'ENGINEER_BRIDGE', formationId: selected.id, x, y });
        clearMode();
        break;
      case 'ENGINEER_CLEAR':
        net.sendAction({ type: 'ENGINEER_CLEAR', formationId: selected.id, x, y });
        clearMode();
        break;
      case 'SPECIAL_OP':
        net.sendAction({ type: 'SPECIAL_OP', formationId: selected.id, x, y });
        clearMode();
        break;
      case 'AMPHIBIOUS': {
        const cargo = Object.values(state.formations).find(
          (o) => o.owner === selected.owner && o.id !== selected.id && distance(o.x, o.y, selected.x, selected.y) <= 1 && o.type !== 'FRIGATE' && o.type !== 'NAVAL_TRANSPORT'
        );
        if (cargo) net.sendAction({ type: 'AMPHIBIOUS', transportId: selected.id, cargoId: cargo.id, x, y });
        clearMode();
        break;
      }
      default:
        break;
    }
  };

  const objectivesCaptured = state.objectives.filter((o) => o.controlledBy === you).length;
  const showGameOver = state.phase === 'GAME_OVER';
  const report = showReportId && state.lastBattleReport?.id === showReportId ? state.lastBattleReport : null;
  const showDisconnectBanner = net.status === 'opponent_disconnected';

  return (
    <div className="app-root">
      <TopBar state={state} you={you} />
      {showDisconnectBanner && (
        <div className="reconnect-banner">
          <span className="pulse-dot" /> Opponent disconnected &mdash; waiting for them to reconnect&hellip;
        </div>
      )}
      <div className="main-area">
        <div className="left-panel">
          <FormationList state={state} viewer={you} selectedId={selectedId} onSelect={(f) => setSelectedId(f.id)} />
        </div>
        <div className="center-area">
          <OverlayToggles overlays={overlays} setOverlays={setOverlays} />
          <div className="canvas-wrap">
            <MapCanvas
              state={state}
              viewer={you}
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
              onFortify={() => net.sendAction({ type: 'FORTIFY', formationId: selected.id })}
              onRecon={() => net.sendAction({ type: 'RECON', formationId: selected.id })}
              onResupply={() => net.sendAction({ type: 'RESUPPLY', formationId: selected.id })}
              onAir={() => net.sendAction({ type: 'AIR', x: selected.x, y: selected.y })}
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
          AP Remaining: <b>{state.players[you].ap}</b>
        </div>
        <div className="bottom-center">
          Objectives Held: {objectivesCaptured} / {state.objectives.length}
        </div>
        <div className="bottom-right">
          <button className="end-turn-btn" onClick={() => net.endTurn()} disabled={!myTurn}>
            {myTurn ? 'End Turn →' : `${state.activePlayer}'s Turn…`}
          </button>
        </div>
      </div>

      {report && <BattleReportModal report={report} onClose={() => setShowReportId(null)} />}
      {showGameOver && <EndGameScreen state={state} you={you} onRestart={net.leaveToLobby} />}
    </div>
  );
}
