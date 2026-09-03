import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMultiplayer } from './net/client';
import { TopBar } from './components/TopBar';
import { FormationList } from './components/FormationList';
import { UnitDetailPanel } from './components/UnitDetailPanel';
import { MapCanvas } from './components/MapCanvas';
import { OverlayToggles } from './components/OverlayToggles';
import { ActionBar } from './components/ActionBar';
import { BattleReportModal } from './components/BattleReportModal';
import { EndGameScreen } from './components/EndGameScreen';
import { Legend } from './components/Legend';
import { HelpPanel } from './components/HelpPanel';
import { Lobby } from './components/Lobby';
import { GroupMovePreview, MovementPreview } from './components/MovementPreview';
import { Camera, Overlays } from './render/renderMap';
import { TargetMode } from './App.types';
import { ActionAvailability, actionAvailability, ACTION_BY_SHORTCUT, formationsWithActions } from './game/actions';
import { computeReachable, formationAt } from './game/engine';
import { cohesionAdvisory, planGroupMove, planMove } from './game/movement';
import { AP_COSTS, Formation, GRID_SIZE } from './game/types';

const TARGET_HINTS: Record<string, string> = {
  MOVE: 'Click a highlighted tile to move there. Shift-click friendly formations to group them for a formation move.',
  MOVE_GROUP: 'Click the objective tile — the whole group advances together at the slowest formation\u2019s pace.',
  ATTACK: 'Click a red-ringed enemy inside your attack range.',
  ARTILLERY: 'Click a spotted enemy inside the red range diamond to fire on it.',
  AIR_TARGET: 'Click any spotted enemy formation to call the strike in.',
  ENGINEER_BRIDGE: 'Click an adjacent river tile to bridge it.',
  ENGINEER_CLEAR: 'Click an adjacent tile to clear its obstacles and dug-in defences.',
  SPECIAL_OP: 'Click a tile within commando reach to raid or probe it.',
};

/** True when the keystroke belongs to a text field and must not act as a shortcut. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export default function App() {
  const net = useMultiplayer();
  const { state, you } = net;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(null);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: GRID_SIZE / 2, y: GRID_SIZE / 2, scale: 11 });
  const [overlays, setOverlays] = useState<Overlays>({ terrain: true, movement: true, intel: true, supply: false, objectives: true });
  const [showReportId, setShowReportId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rosterCollapsed, setRosterCollapsed] = useState(false);
  const [endTurnWarn, setEndTurnWarn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const shownRef = useRef<string | null>(null);
  const lastRoundRef = useRef<number | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const selected = state && selectedId ? state.formations[selectedId] ?? null : null;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    // Dev/QA hook only — lets automated smoke tests inspect connection + game
    // state without clicking through pixel-exact canvas coordinates.
    (window as any).__COMMAND_DEBUG__ = { net, state, you, setSelectedId, setCamera, computeReachable, selectedId, targetMode };
  });

  useEffect(() => {
    if (state?.lastBattleReport && state.lastBattleReport.id !== shownRef.current) {
      shownRef.current = state.lastBattleReport.id;
      setShowReportId(state.lastBattleReport.id);
    }
  }, [state?.lastBattleReport]);

  useEffect(() => {
    if (!state || !you) return;
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
    setTargetMode(null);
    setEndTurnWarn(false);
    setGroupIds([]);
  }, [state?.activePlayer]);

  // Drop group members that no longer exist (destroyed, or not ours).
  useEffect(() => {
    if (!state || !you) return;
    setGroupIds((ids) => {
      const keep = ids.filter((id) => state.formations[id]?.owner === you);
      return keep.length === ids.length ? ids : keep;
    });
  }, [state?.formations, you]);

  const myTurn = !!state && !!you && state.activePlayer === you;

  const actions: ActionAvailability[] = useMemo(
    () => (state && you && selected ? actionAvailability(state, selected, you) : []),
    [state, you, selected]
  );

  const readyFormations = useMemo(() => (state && you ? formationsWithActions(state, you) : []), [state, you]);

  const groupFormations = useMemo(
    () => (state ? (groupIds.map((id) => state.formations[id]).filter(Boolean) as Formation[]) : []),
    [state, groupIds]
  );

  // ---- Movement preview -----------------------------------------------------
  // planMove / planGroupMove are the SAME pure functions the server validates
  // with, so what the preview promises is exactly what the move will do.
  const movePlan = useMemo(
    () => (state && selected && targetMode === 'MOVE' && hoverTile ? planMove(state, selected, hoverTile.x, hoverTile.y) : null),
    [state, selected, targetMode, hoverTile?.x, hoverTile?.y]
  );
  const moveAdvisory = useMemo(
    () =>
      state && selected && targetMode === 'MOVE' && hoverTile && movePlan?.ok
        ? cohesionAdvisory(state, selected, hoverTile.x, hoverTile.y)
        : null,
    [state, selected, targetMode, hoverTile?.x, hoverTile?.y, movePlan?.ok]
  );
  const groupPlan = useMemo(
    () =>
      state && targetMode === 'MOVE_GROUP' && hoverTile && groupIds.length
        ? planGroupMove(state, groupIds, hoverTile.x, hoverTile.y)
        : null,
    [state, targetMode, hoverTile?.x, hoverTile?.y, groupIds]
  );

  const toggleGroupMember = useCallback(
    (f: Formation) => {
      setGroupIds((ids) => (ids.includes(f.id) ? ids.filter((i) => i !== f.id) : [...ids, f.id]));
    },
    []
  );

  const centreOn = useCallback((f: { x: number; y: number }) => {
    setCamera((c) => ({ ...c, x: f.x, y: f.y }));
  }, []);

  const selectFormation = useCallback(
    (f: Formation, centre = false) => {
      setSelectedId(f.id);
      setTargetMode(null);
      if (centre) centreOn(f);
    },
    [centreOn]
  );

  const runAction = useCallback(
    (a: ActionAvailability) => {
      if (!selected || !state) return;
      if (!a.enabled) {
        flash(a.reason);
        return;
      }
      if (a.mode) {
        setTargetMode((m) => (m === a.mode ? null : a.mode));
        return;
      }
      switch (a.id) {
        case 'RECON':
          net.sendAction({ type: 'RECON', formationId: selected.id });
          break;
        case 'FORTIFY':
          net.sendAction({ type: 'FORTIFY', formationId: selected.id });
          break;
        case 'RESUPPLY':
          net.sendAction({ type: 'RESUPPLY', formationId: selected.id });
          break;
        default:
          break;
      }
      setTargetMode(null);
    },
    [selected, state, net, flash]
  );

  const nextReady = useCallback(() => {
    if (!readyFormations.length) {
      flash('No formation has orders left — press E to end the turn.');
      return;
    }
    const idx = readyFormations.findIndex((f) => f.id === selectedId);
    const next = readyFormations[(idx + 1) % readyFormations.length];
    selectFormation(next, true);
  }, [readyFormations, selectedId, selectFormation, flash]);

  const doEndTurn = useCallback(() => {
    if (!state || !you) return;
    const ap = state.players[you].ap;
    const meaningful = ap >= AP_COSTS.MOVE && readyFormations.length > 0;
    if (meaningful && !endTurnWarn) {
      setEndTurnWarn(true);
      return;
    }
    setEndTurnWarn(false);
    net.endTurn();
  }, [state, you, readyFormations, endTurnWarn, net]);

  // ---- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a text field (the room-code input in particular).
      if (isTypingTarget(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;

      // Shift+M — Move Formation (the grouped order). Plain M is unchanged.
      if (e.shiftKey && k.toUpperCase() === 'M') {
        e.preventDefault();
        if (groupIds.length < 2) {
          flash('Shift-click two or more of your formations first, then press Shift+M to move them together.');
          return;
        }
        setTargetMode((m) => (m === 'MOVE_GROUP' ? null : 'MOVE_GROUP'));
        return;
      }

      if (k === 'Escape') {
        if (targetMode) setTargetMode(null);
        else if (groupIds.length) setGroupIds([]);
        else if (legendOpen) setLegendOpen(false);
        else if (helpOpen) setHelpOpen(false);
        else if (endTurnWarn) setEndTurnWarn(false);
        else setSelectedId(null);
        e.preventDefault();
        return;
      }
      if (k === '?' || k === '/') {
        setHelpOpen((v) => !v);
        e.preventDefault();
        return;
      }
      const up = k.toUpperCase();
      if (up === 'L') {
        setLegendOpen((v) => !v);
        e.preventDefault();
        return;
      }
      if (up === 'H') {
        setHelpOpen((v) => !v);
        e.preventDefault();
        return;
      }
      if (k === 'Tab') {
        nextReady();
        e.preventDefault();
        return;
      }
      if (up === 'Z' || k === ' ') {
        if (selected) centreOn(selected);
        e.preventDefault();
        return;
      }
      if (up === 'E') {
        if (myTurn) doEndTurn();
        e.preventDefault();
        return;
      }
      if (k === '+' || k === '=') {
        setCamera((c) => ({ ...c, scale: Math.min(34, c.scale * 1.25) }));
        e.preventDefault();
        return;
      }
      if (k === '-' || k === '_') {
        setCamera((c) => ({ ...c, scale: Math.max(3.5, c.scale / 1.25) }));
        e.preventDefault();
        return;
      }
      if (k.startsWith('Arrow')) {
        const step = 6;
        setCamera((c) => ({
          ...c,
          x: c.x + (k === 'ArrowRight' ? step : k === 'ArrowLeft' ? -step : 0),
          y: c.y + (k === 'ArrowDown' ? step : k === 'ArrowUp' ? -step : 0),
        }));
        e.preventDefault();
        return;
      }
      const spec = ACTION_BY_SHORTCUT[up];
      if (spec) {
        e.preventDefault();
        if (!selected) {
          flash('Select a formation first — click one on the map or in the roster.');
          return;
        }
        const a = actions.find((x) => x.id === spec.id);
        if (!a || !a.applicable) {
          flash(`${selected.shortName} cannot perform ${spec.label}.`);
          return;
        }
        runAction(a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [targetMode, legendOpen, helpOpen, endTurnWarn, selected, actions, runAction, nextReady, centreOn, doEndTurn, myTurn, flash, groupIds]);

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

  const clearMode = () => setTargetMode(null);

  const handleFormationClick = (f: Formation, mods: { shift: boolean } = { shift: false }) => {
    if (mods.shift) {
      if (f.owner !== you) {
        flash('Only your own formations can be grouped for a formation move.');
        return;
      }
      toggleGroupMember(f);
      return;
    }
    if (targetMode === 'ATTACK' && selected && f.owner !== selected.owner) {
      net.sendAction({ type: 'ATTACK', attackerId: selected.id, targetId: f.id });
      clearMode();
      return;
    }
    if (targetMode === 'AIR_TARGET' && f.owner !== you) {
      net.sendAction({ type: 'AIR', x: f.x, y: f.y });
      clearMode();
      return;
    }
    if (targetMode === 'ARTILLERY' && selected && f.owner !== selected.owner) {
      net.sendAction({ type: 'ARTILLERY', formationId: selected.id, x: f.x, y: f.y });
      clearMode();
      return;
    }
    if (f.owner === you) selectFormation(f);
  };

  const handleTileClick = (x: number, y: number) => {
    if (targetMode === 'MOVE_GROUP') {
      const plan = planGroupMove(state, groupIds, x, y);
      if (!plan.ok) {
        flash(plan.reason);
        return;
      }
      net.sendAction({ type: 'MOVE_GROUP', formationIds: plan.members.filter((m) => m.ok).map((m) => m.id), x, y });
      clearMode();
      return;
    }
    if (!selected) return;
    switch (targetMode) {
      case 'MOVE': {
        // Never silently refuse: if the destination is illegal, say why and
        // stay in move mode so the player can pick another tile.
        const plan = planMove(state, selected, x, y);
        if (!plan.ok) {
          flash(plan.reason);
          return;
        }
        net.sendAction({ type: 'MOVE', formationId: selected.id, x, y });
        clearMode();
        break;
      }
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
      default:
        break;
    }
  };

  const objectivesHeld = state.objectives.filter((o) => o.controlledBy === you).length;
  const report = showReportId && state.lastBattleReport?.id === showReportId ? state.lastBattleReport : null;
  const flashTiles = report
    ? [
        { x: report.attackerX, y: report.attackerY },
        { x: report.defenderX, y: report.defenderY },
      ]
    : undefined;

  return (
    <div className="app-root">
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
        flashTiles={flashTiles}
        groupIds={groupIds}
        pathPreview={targetMode === 'MOVE' ? movePlan?.path : undefined}
        pathInvalid={targetMode === 'MOVE' ? movePlan?.ok === false : false}
        onHoverTile={setHoverTile}
      />

      <TopBar state={state} you={you} objectivesHeld={objectivesHeld} objectivesTotal={state.objectives.length} />
      <OverlayToggles
        overlays={overlays}
        setOverlays={setOverlays}
        legendOpen={legendOpen}
        helpOpen={helpOpen}
        onLegend={() => setLegendOpen((v) => !v)}
        onHelp={() => setHelpOpen((v) => !v)}
      />

      {net.status === 'opponent_disconnected' && (
        <div className="reconnect-banner">
          <span className="pulse-dot" /> Opponent disconnected &mdash; waiting for them to reconnect&hellip;
        </div>
      )}

      <FormationList
        state={state}
        viewer={you}
        selectedId={selectedId}
        collapsed={rosterCollapsed}
        onToggle={() => setRosterCollapsed((v) => !v)}
        onSelect={(f) => selectFormation(f, true)}
        onToggleGroup={toggleGroupMember}
        groupIds={groupIds}
      />

      {selected && (
        <UnitDetailPanel state={state} formation={selected} onCentre={() => centreOn(selected)} onClose={() => setSelectedId(null)} />
      )}

      {(targetMode === 'MOVE' || targetMode === 'MOVE_GROUP') && (
        <div className="move-preview-wrap">
          {targetMode === 'MOVE_GROUP' ? (
            <GroupMovePreview plan={groupPlan} count={groupFormations.length} />
          ) : (
            selected && <MovementPreview unitName={selected.shortName} plan={movePlan} advisory={moveAdvisory} />
          )}
        </div>
      )}

      {groupFormations.length > 0 && (
        <div className="group-bar" data-testid="group-bar">
          <span className="group-title">FORMATION GROUP</span>
          {groupFormations.map((f) => (
            <button
              key={f.id}
              className="group-chip"
              title="Remove from the group"
              onClick={() => toggleGroupMember(f)}
              data-testid="group-chip"
            >
              {f.shortName} <span className="group-x">×</span>
            </button>
          ))}
          <button
            className="btn-primary small"
            data-testid="move-formation-btn"
            disabled={groupFormations.length < 2 || !myTurn}
            onClick={() => setTargetMode((m) => (m === 'MOVE_GROUP' ? null : 'MOVE_GROUP'))}
          >
            Move Formation <kbd>⇧M</kbd>
          </button>
          <button className="btn-ghost small" onClick={() => setGroupIds([])}>
            Clear
          </button>
        </div>
      )}

      {selected ? (
        <ActionBar
          formation={selected}
          actions={actions}
          targetMode={targetMode}
          onAction={runAction}
          onCancel={clearMode}
          hint={targetMode ? TARGET_HINTS[targetMode] ?? null : null}
        />
      ) : (
        <div className="action-bar empty-bar">
          <span>
            Select a formation — click one on the map or in the roster, or press <kbd>Tab</kbd> to jump to the next one with
            orders left.
          </span>
        </div>
      )}

      <div className="hud-bottom-right">
        {endTurnWarn && (
          <div className="end-turn-warn" data-testid="end-turn-warn">
            <b>You still have {state.players[you].ap} AP</b> and {readyFormations.length} formation
            {readyFormations.length === 1 ? '' : 's'} with orders available.
            <div className="warn-btns">
              <button className="btn-ghost small" onClick={() => setEndTurnWarn(false)}>
                Keep playing
              </button>
              <button className="btn-primary small" onClick={doEndTurn}>
                End turn anyway
              </button>
            </div>
          </div>
        )}
        <button className="end-turn-btn" onClick={doEndTurn} disabled={!myTurn} data-testid="end-turn">
          {myTurn ? (
            <>
              End Turn <kbd>E</kbd>
            </>
          ) : (
            `${state.activePlayer} moving…`
          )}
        </button>
      </div>

      {toast && <div className="toast">{toast}</div>}
      {legendOpen && <Legend onClose={() => setLegendOpen(false)} />}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
      {report && (
        <BattleReportModal
          report={report}
          onClose={() => setShowReportId(null)}
          onFocus={() => centreOn({ x: report.defenderX, y: report.defenderY })}
        />
      )}
      {state.phase === 'GAME_OVER' && <EndGameScreen state={state} you={you} onRestart={net.leaveToLobby} />}
    </div>
  );
}
