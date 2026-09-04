import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FACTION_SHORT, FORMATION_DEFS } from './game/data';
import { useMultiplayer } from './net/client';
import { TopBar } from './components/TopBar';
import { FormationList } from './components/FormationList';
import { UnitDetailPanel } from './components/UnitDetailPanel';
import { MapCanvas } from './components/MapCanvas';
import { OverlayToggles } from './components/OverlayToggles';
import { ActionBar } from './components/ActionBar';
import { BattleReportModal } from './components/BattleReportModal';
import { EndGameScreen } from './components/EndGameScreen';
import { Briefing } from './components/Briefing';
import { TurnSummaryBanner } from './components/TurnSummaryBanner';
import { PriorityTargets } from './components/PriorityTargets';
import { computePriorityTargets } from './game/threat';
import { Legend } from './components/Legend';
import { HelpPanel } from './components/HelpPanel';
import { Lobby } from './components/Lobby';
import { Sandbox } from './components/Sandbox';
import { ReplayLinkView } from './components/ReplayLinkView';
import { OpsLog } from './components/OpsLog';
import { GroupMovePreview, MovementPreview } from './components/MovementPreview';
import { AttackPreview } from './components/AttackPreview';
import {
  Camera,
  CombatEffect,
  COMBAT_EFFECT_LIFETIME_MS,
  ContactPing,
  EventFlash,
  EVENT_FLASH_LIFETIME_MS,
  KillMarker,
  ObjectiveFlash,
  OBJECTIVE_FLASH_LIFETIME_MS,
  Overlays,
  PING_LIFETIME_MS,
} from './render/renderMap';
import { TargetMode } from './App.types';
import { useMountTransition } from './hooks/useMountTransition';
import { ActionAvailability, actionAvailability, ACTION_BY_SHORTCUT, formationsWithActions } from './game/actions';
import { computeReachable, formationAt, previewAttack } from './game/engine';
import { cohesionAdvisory, planGroupMove, planMove, planWithdraw } from './game/movement';
import { AP_COSTS, Contact, DetectionLevel, Formation, GameState, GRID_SIZE, PlayerId, gridRef } from './game/types';
import { sound } from './audio/sound';

const TARGET_HINTS: Record<string, string> = {
  MOVE: 'Click a highlighted tile to move there. Shift-click friendly formations to group them for a formation move.',
  MOVE_GROUP: 'Click the objective tile — the whole group advances together at the slowest formation\u2019s pace.',
  ATTACK: 'Hover a red-ringed enemy to see the predicted result, then click to commit.',
  ARTILLERY: 'Click a spotted enemy inside the red range diamond to fire on it.',
  AIR_TARGET: 'Click any spotted enemy formation to call the strike in.',
  ENGINEER_BRIDGE: 'Click an adjacent river tile to bridge it.',
  ENGINEER_CLEAR: 'Click an adjacent tile to clear its obstacles and dug-in defences.',
  SPECIAL_OP: 'Click a tile within this battalion\u2019s insertion reach to raid or probe it.',
  VERTICAL_INSERT: 'Click a landing zone within reach \u2014 not adjacent to any enemy formation you have detected.',
  UAV_RECON: 'Click anywhere on the map to sweep that area with a UAV sortie.',
};

/** Ladder rank, for spotting an upgrade between two state pushes. */
const LEVEL_RANK: Record<DetectionLevel, number> = { UNKNOWN: 0, CONTACT: 1, IDENTIFIED: 2, CONFIRMED: 3 };

/**
 * A batched "something decisive just happened" notification (phase 4b's
 * contact-detected banner, generalised in phase 10 §3 to cover every event
 * the player's side has legitimately detected: new/upgraded contacts, a
 * formation destroyed on either side, and an objective changing hands).
 * Everything that qualifies on ONE state push is collapsed into a single
 * clickable banner rather than one notification per event — the same
 * batching discipline the original contact ping used. Clicking jumps the
 * camera to whichever qualifying event is nearest to the player's own
 * forces; the map also pings/flashes the tiles regardless of whether the
 * banner itself is ever clicked.
 */
interface EventAlert {
  id: number;
  parts: string[];
  nearest: { x: number; y: number } | null;
}

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
  // Phase 11 §6 — a shareable replay link is a query param the app checks on
  // load (no router dependency): ?replay=CODE bypasses the lobby and the live
  // game entirely. Computed once (useMemo, empty deps) so it stays stable for
  // this mount — see the early return near the bottom of this component.
  const replayLinkCode = useMemo(() => new URLSearchParams(window.location.search).get('replay'), []);
  // Phase 11 §2 — Sandbox mode is a separate, self-contained screen (see
  // components/Sandbox.tsx) reached from the landing page; it never touches
  // the multiplayer socket at all.
  const [sandboxMode, setSandboxMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(null);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: GRID_SIZE / 2, y: GRID_SIZE / 2, scale: 11 });
  // Opening camera sweep / end-game cinematic (phase 12 §10) — see the two
  // effects below. `sweeping` gates a skip listener; the timers themselves
  // are cleared on skip so a stray late setCamera can never fight the
  // player's own subsequent panning.
  const [sweeping, setSweeping] = useState(false);
  const sweepTimersRef = useRef<number[]>([]);
  const sweepFinalCamRef = useRef<Camera | null>(null);
  const openingSweepDoneRef = useRef(false);
  const endgameSweepDoneRef = useRef(false);
  const [overlays, setOverlays] = useState<Overlays>({ movement: true, intel: true, objectives: true });
  const [showReportId, setShowReportId] = useState<string | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rosterCollapsed, setRosterCollapsed] = useState(false);
  const [logCollapsed, setLogCollapsed] = useState(true);
  const [endTurnWarn, setEndTurnWarn] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [eventAlert, setEventAlert] = useState<EventAlert | null>(null);
  const [pings, setPings] = useState<ContactPing[]>([]);
  const [killMarkers, setKillMarkers] = useState<KillMarker[]>([]);
  const knownKillIdsRef = useRef<Set<string>>(new Set());
  const knownContactsRef = useRef<Record<string, DetectionLevel> | null>(null);
  const prevObjectivesRef = useRef<Record<string, PlayerId | null> | null>(null);
  // Phase 12 §5/§6/§11 — on-map combat effects, objective-capture flashes and
  // event-location flashes, all derived from the SAME already-fog-audited
  // diff pass as the pings/kills above (state.combatEvents and
  // state.killFeed are fog.ts-redacted per viewer; objectives are never
  // fog-gated) — never a separate, uncoordinated visual system.
  const [combatEffects, setCombatEffects] = useState<CombatEffect[]>([]);
  const [objectiveFlashes, setObjectiveFlashes] = useState<ObjectiveFlash[]>([]);
  const [eventFlashes, setEventFlashes] = useState<EventFlash[]>([]);
  const knownCombatIdsRef = useRef<Set<string>>(new Set());
  // Real per-formation paths captured at the moment Move/Withdraw is issued,
  // for animated movement (phase 12 §4) to follow exactly rather than glide
  // straight-line — see MapCanvas's animation effect, which consumes and
  // clears each entry the instant that formation's position actually changes.
  const moveHintsRef = useRef<Map<string, { x: number; y: number }[]>>(new Map());
  const alertTimer = useRef<number | undefined>(undefined);
  const alertSeq = useRef(0);
  const shownRef = useRef<string | null>(null);
  const lastRoundRef = useRef<number | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // Pre-battle briefing (phase 10 §1/§4).
  const [briefingDismissed, setBriefingDismissed] = useState(false);
  // Turn-start "what changed" summary (phase 10 §2).
  const [turnSummary, setTurnSummary] = useState<{ id: number; text: string } | null>(null);
  const turnSummarySeq = useRef(0);
  const turnPrevActiveRef = useRef<PlayerId | null>(null);
  const turnSnapshotRef = useRef<{
    contacts: Record<string, DetectionLevel>;
    objectives: Record<string, PlayerId | null>;
    ammo: Record<string, number>;
    killIds: Set<string>;
  } | null>(null);

  // Reset the briefing for each fresh match (a new room code) — the hook
  // that owns `net` lives for the whole browser session, so without this a
  // second vs-Bot game in the same tab would never show it again.
  useEffect(() => {
    setBriefingDismissed(false);
    openingSweepDoneRef.current = false;
    endgameSweepDoneRef.current = false;
  }, [net.roomCode]);

  const briefingOpen = !!state && !!you && state.round === 1 && !briefingDismissed;

  // Unlock the (lazily-created) AudioContext from the FIRST genuine user
  // gesture the page sees, whatever it is — a menu click, a keypress. This
  // satisfies the browser autoplay policy for every later, possibly async,
  // sound call (an opponent's move arriving over the wire is not itself a
  // gesture) without ever prompting the player or blocking on page load.
  useEffect(() => {
    const unlock = () => {
      sound.unlock();
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, []);

  const selected = state && selectedId ? state.formations[selectedId] ?? null : null;
  const reportActive = !!(showReportId && state?.lastBattleReport?.id === showReportId);
  // Part 2 §3 — smooth panel transitions for the unit-detail panel and the
  // battle report card (the roster's own expand/collapse gets a CSS-only
  // treatment instead, see FormationList.tsx — it never fully unmounts, so
  // it doesn't need this hook). Called unconditionally, above every early
  // `return` in this component, per the rules of hooks. This only changes
  // how the panel's DOM node animates in/out — it adds no delay whatsoever
  // to the actual gameplay feedback (arming an order, move/attack preview),
  // which is driven by completely separate state.
  const unitPanelT = useMountTransition(!!selected, 150);
  const reportT = useMountTransition(reportActive, 150);

  // Ambient audio layer (Part 2 §4) — runs only while a live match is in
  // progress (not the lobby, not the end screen, not sandbox/replay, which
  // never reach this component with state.phase set). startAmbience() is a
  // no-op until sound.unlock() has actually run from a real user gesture
  // (see the effect above); it self-resumes from there. Stops on unmount,
  // on phase change, and is fully governed by the existing mute/volume
  // control (SoundEngine.syncAmbienceVolume) — nothing new to wire up here.
  useEffect(() => {
    if (state?.phase === 'PLAYING') {
      sound.startAmbience();
      return () => sound.stopAmbience();
    }
    sound.stopAmbience();
  }, [state?.phase]);
  // Keep the last real value around through the exit animation — the trigger
  // (selected / report) goes null/falsy the instant selection is cleared,
  // but the panel needs something to actually render while it fades/slides
  // out over unitPanelT.phase === 'exit'.
  const lastSelectedRef = useRef<typeof selected>(null);
  if (selected) lastSelectedRef.current = selected;
  const lastReportRef = useRef<GameState['lastBattleReport']>(null);
  if (reportActive) lastReportRef.current = state?.lastBattleReport ?? null;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const frameTimeRef = useRef(0);
  const onFrameTime = useCallback((ms: number) => {
    frameTimeRef.current = ms;
  }, []);

  useEffect(() => {
    // Dev/QA hook only — lets automated smoke tests inspect connection + game
    // state without clicking through pixel-exact canvas coordinates. frameTimeMs
    // is the render loop's own smoothed self-measurement (MapCanvas onFrameTime),
    // sampled here so a perf check can read `window.__COMMAND_DEBUG__.frameTimeMs`
    // without adding any UI chrome.
    (window as any).__COMMAND_DEBUG__ = {
      net,
      state,
      you,
      setSelectedId,
      setCamera,
      computeReachable,
      selectedId,
      targetMode,
      get frameTimeMs() {
        return frameTimeRef.current;
      },
    };
  });

  useEffect(() => {
    if (state?.lastBattleReport && state.lastBattleReport.id !== shownRef.current) {
      shownRef.current = state.lastBattleReport.id;
      setShowReportId(state.lastBattleReport.id);
      // A battle report only ever names the viewer's own formation as
      // attacker or defender (there is no third-party spectator report in a
      // 2-player game) — always something this side legitimately witnessed,
      // so the weapons-fire transient is safe regardless of fog.
      sound.play('attack');
    }
  }, [state?.lastBattleReport]);

  // ---- Combined event notification + sound (phase 10 §3, §5) --------------
  // Diffs the contact table, the kill feed and objective ownership on every
  // push and folds whatever is new into ONE clickable banner + ping/marker
  // set + sound cue, rather than one of each per event — the same batching
  // discipline the original phase-4b contact ping used, now generalised to
  // every "something decisive happened that you detected" case named in the
  // spec. Every source read here is already fog-filtered for `you` by the
  // server (contacts, killFeed — see fog.ts) or was never fog-gated in the
  // first place (objectives are terrain-held control points, never redacted).
  useEffect(() => {
    if (!state || !you) return;
    const now = performance.now();

    // Contacts.
    const contacts = state.players[you].contacts as Record<string, Contact>;
    const snapshot: Record<string, DetectionLevel> = {};
    Object.values(contacts).forEach((c) => {
      snapshot[c.formationId] = c.level;
    });
    const prevContacts = knownContactsRef.current;
    knownContactsRef.current = snapshot;
    const freshContacts: Contact[] = [];
    const upgradedContacts: Contact[] = [];
    if (prevContacts) {
      Object.values(contacts).forEach((c) => {
        const before = prevContacts[c.formationId];
        if (before === undefined) freshContacts.push(c);
        else if (LEVEL_RANK[c.level] > LEVEL_RANK[before]) upgradedContacts.push(c);
      });
    }

    // Kills — state.killFeed is already fog-redacted per viewer.
    const freshKills = state.killFeed.filter((k) => !knownKillIdsRef.current.has(k.id));
    freshKills.forEach((k) => knownKillIdsRef.current.add(k.id));

    // Combat effects (phase 12 §5) — state.combatEvents is already
    // fog-redacted per viewer by fog.ts (see `redactCombatEvent`): an
    // undetected participant's position has already been collapsed onto the
    // viewer's own formation before it ever reaches this component, so this
    // diff needs no detection logic of its own, exactly like kills above.
    const freshCombat = state.combatEvents.filter((e) => !knownCombatIdsRef.current.has(e.id));
    freshCombat.forEach((e) => knownCombatIdsRef.current.add(e.id));
    if (freshCombat.length) {
      const added: CombatEffect[] = freshCombat.map((e) => ({
        id: e.id,
        kind: e.kind,
        attackerX: e.attackerX,
        attackerY: e.attackerY,
        defenderX: e.defenderX,
        defenderY: e.defenderY,
        at: now,
      }));
      setCombatEffects((cs) => [...cs.filter((c) => now - c.at < COMBAT_EFFECT_LIFETIME_MS), ...added].slice(-24));
      // Overwatch reaction fire never produces a lastBattleReport (it is not
      // a player-issued order), so it has no sound cue yet — this is the one
      // unambiguous case where combatEvents themselves should raise it. An
      // ATTACK-order engagement (direct or standoff) already gets 'attack'
      // from the lastBattleReport effect below at essentially the same
      // instant, so it is deliberately NOT re-triggered here to avoid a
      // doubled cue.
      if (freshCombat.some((e) => e.kind === 'overwatch')) sound.play('attack');
    }

    // Objectives — never fog-gated, so a straight ownership diff is safe.
    const prevObjectives = prevObjectivesRef.current;
    const objSnapshot: Record<string, PlayerId | null> = {};
    state.objectives.forEach((o) => {
      objSnapshot[o.id] = o.controlledBy;
    });
    prevObjectivesRef.current = objSnapshot;
    const objectiveChanges = prevObjectives
      ? state.objectives.filter((o) => prevObjectives[o.id] !== undefined && prevObjectives[o.id] !== o.controlledBy)
      : [];
    if (objectiveChanges.length) {
      const added: ObjectiveFlash[] = objectiveChanges.map((o) => ({
        id: o.id,
        x: o.x,
        y: o.y,
        fromOwner: prevObjectives![o.id] ?? null,
        toOwner: o.controlledBy,
        at: now,
      }));
      setObjectiveFlashes((fs) => [...fs.filter((f) => now - f.at < OBJECTIVE_FLASH_LIFETIME_MS), ...added].slice(-12));
    }

    // Map-side visuals: pings for contacts, wreck markers for kills.
    if (freshContacts.length || upgradedContacts.length) {
      const added: ContactPing[] = [...freshContacts, ...upgradedContacts].map((c) => ({ x: c.x, y: c.y, at: now, level: c.level }));
      setPings((ps) => [...ps.filter((p) => now - p.at < PING_LIFETIME_MS), ...added].slice(-24));
    }
    if (freshKills.length) {
      const added: KillMarker[] = freshKills.map((k) => ({ id: k.id, x: k.x, y: k.y, at: now, owner: k.owner, type: k.type }));
      setKillMarkers((ks) => [...ks.filter((k) => now - k.at < 8000), ...added].slice(-16));
    }

    // Sound — one cue per category present in this push, never per event.
    if (freshContacts.length || upgradedContacts.length) sound.play('contact');
    if (freshKills.length) sound.play('kill');
    if (objectiveChanges.some((o) => o.controlledBy === you)) sound.play('objective');

    if (!prevContacts) return; // first push (join / reconnect) — nothing is "new" yet

    const parts: string[] = [];
    if (freshContacts.length) parts.push(`${freshContacts.length} new contact${freshContacts.length === 1 ? '' : 's'}`);
    if (upgradedContacts.length) parts.push(`${upgradedContacts.length} contact${upgradedContacts.length === 1 ? '' : 's'} upgraded`);
    if (objectiveChanges.length) parts.push(`${objectiveChanges.length} objective${objectiveChanges.length === 1 ? '' : 's'} changed hands`);
    const enemyKills = freshKills.filter((k) => k.owner !== you).length;
    const ownKills = freshKills.filter((k) => k.owner === you).length;
    if (enemyKills) parts.push(`${enemyKills} enemy formation${enemyKills === 1 ? '' : 's'} destroyed`);
    if (ownKills) parts.push(`${ownKills} of your formations lost`);
    if (!parts.length) return;

    const mine = Object.values(state.formations).filter((f) => f.owner === you);
    const dist = (x: number, y: number) => mine.reduce((best, f) => Math.min(best, Math.abs(f.x - x) + Math.abs(f.y - y)), Infinity);
    const candidates = [
      ...freshKills.map((k) => ({ x: k.x, y: k.y })),
      ...objectiveChanges.map((o) => ({ x: o.x, y: o.y })),
      ...[...freshContacts, ...upgradedContacts].map((c) => ({ x: c.x, y: c.y })),
    ];
    let nearest: EventAlert['nearest'] = null;
    let bestD = Infinity;
    candidates.forEach((c) => {
      const d = dist(c.x, c.y);
      if (d < bestD) {
        bestD = d;
        nearest = { x: c.x, y: c.y };
      }
    });

    // Event-location flash (phase 12 §11) — the same tile coordinates the
    // notification banner's "click to jump" already carries, rendered as an
    // immediate highlight pulse so the eye can catch it before the player
    // even clicks. All of `candidates` (kills, objective changes, fresh/
    // upgraded contacts), not just the nearest one.
    const flashesAdded: EventFlash[] = candidates.map((c) => ({ x: c.x, y: c.y, at: now }));
    if (flashesAdded.length) {
      setEventFlashes((fs) => [...fs.filter((f) => now - f.at < EVENT_FLASH_LIFETIME_MS), ...flashesAdded].slice(-24));
    }

    alertSeq.current += 1;
    setEventAlert({ id: alertSeq.current, parts, nearest });
    window.clearTimeout(alertTimer.current);
    alertTimer.current = window.setTimeout(() => setEventAlert(null), 9000);
  }, [state, you]);

  // ---- Turn-start "what changed" summary (phase 10 §2) ---------------------
  // Fires exactly once per turn boundary — the render where activePlayer
  // flips TO the viewer — comparing a snapshot taken at the START of the
  // viewer's own last turn against one taken now, so it reports everything
  // that happened across the opponent's whole intervening turn (not just the
  // latest push). Every field diffed here is the viewer's own already
  // fog-filtered view, so nothing here can leak information they have not
  // legitimately earned.
  useEffect(() => {
    if (!state || !you) return;
    const prevActive = turnPrevActiveRef.current;
    turnPrevActiveRef.current = state.activePlayer;
    if (state.activePlayer !== you || prevActive === you) return;

    const contacts: Record<string, DetectionLevel> = {};
    Object.values(state.players[you].contacts).forEach((c) => {
      contacts[c.formationId] = c.level;
    });
    const objectives: Record<string, PlayerId | null> = {};
    state.objectives.forEach((o) => {
      objectives[o.id] = o.controlledBy;
    });
    const ammo: Record<string, number> = {};
    Object.values(state.formations).forEach((f) => {
      if (f.owner === you && FORMATION_DEFS[f.type].maxAmmo !== null) ammo[f.id] = f.ammo;
    });
    const killIds = new Set(state.killFeed.map((k) => k.id));
    const snap = { contacts, objectives, ammo, killIds };
    const prevSnap = turnSnapshotRef.current;
    turnSnapshotRef.current = snap;
    if (!prevSnap) return; // first turn this session — nothing to compare against

    const freshContacts = Object.keys(contacts).filter((id) => prevSnap.contacts[id] === undefined).length;
    const objChanges = state.objectives.filter(
      (o) => prevSnap.objectives[o.id] !== undefined && prevSnap.objectives[o.id] !== o.controlledBy
    ).length;
    const reloaded = Object.entries(ammo).filter(([id, v]) => (prevSnap.ammo[id] ?? 0) < v).length;
    const freshKills = state.killFeed.filter((k) => !prevSnap.killIds.has(k.id));
    const enemyKills = freshKills.filter((k) => k.owner !== you).length;
    const ownKills = freshKills.filter((k) => k.owner === you).length;

    const parts: string[] = [];
    if (freshContacts) parts.push(`${freshContacts} new contact${freshContacts === 1 ? '' : 's'}`);
    if (objChanges) parts.push(`${objChanges} objective${objChanges === 1 ? '' : 's'} changed hands`);
    if (enemyKills) parts.push(`${enemyKills} enemy formation${enemyKills === 1 ? '' : 's'} destroyed`);
    if (ownKills) parts.push(`you lost ${ownKills} formation${ownKills === 1 ? '' : 's'}`);
    if (reloaded) parts.push(`${reloaded} formation${reloaded === 1 ? '' : 's'} rearmed`);

    turnSummarySeq.current += 1;
    setTurnSummary({
      id: turnSummarySeq.current,
      text: parts.length ? parts.join(' · ') : 'Nothing significant since your last turn.',
    });
    sound.play('turn');
  }, [state, you]);

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
  }, [state?.round, you]);

  // ---- Opening camera sweep (phase 12 §10) ---------------------------------
  // Fires once, the instant the pre-battle briefing dismisses: a brief pan
  // across the battlefield before settling on the player's own deployment
  // zone, instead of cutting straight to the HUD. Reuses MapCanvas's own
  // per-frame camera easing (it glides toward whatever `camera` is set to)
  // rather than a bespoke tween — each waypoint below just becomes the next
  // easing target. Skippable: any keypress or click cuts straight to the
  // final settle position (see the skip-listener effect below).
  useEffect(() => {
    if (!state || !you) return;
    if (!briefingDismissed || openingSweepDoneRef.current) return;
    openingSweepDoneRef.current = true;
    const mine = Object.values(state.formations).filter((f) => f.owner === you);
    const avgX = mine.length ? mine.reduce((s, f) => s + f.x, 0) / mine.length : GRID_SIZE / 2;
    const avgY = mine.length ? mine.reduce((s, f) => s + f.y, 0) / mine.length : GRID_SIZE / 2;
    const finalCam: Camera = { x: avgX, y: avgY, scale: 11 };
    sweepFinalCamRef.current = finalCam;
    setSweeping(true);
    setCamera({ x: GRID_SIZE / 2, y: GRID_SIZE / 2, scale: 4.5 });
    const t1 = window.setTimeout(() => setCamera({ x: GRID_SIZE - avgX, y: GRID_SIZE - avgY, scale: 6.5 }), 450);
    const t2 = window.setTimeout(() => setCamera(finalCam), 950);
    const t3 = window.setTimeout(() => setSweeping(false), 1500);
    sweepTimersRef.current = [t1, t2, t3];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefingDismissed]);

  // ---- End-game cinematic (phase 12 §10) -----------------------------------
  // Fires once when the match reaches GAME_OVER: a brief pan across the final
  // board, touching a couple of objectives, before settling on a wide
  // overview — alongside the end-game screen, which is already showing the
  // result on top of it. Same skip mechanics as the opening sweep.
  useEffect(() => {
    if (!state || state.phase !== 'GAME_OVER' || endgameSweepDoneRef.current) return;
    endgameSweepDoneRef.current = true;
    const finalCam: Camera = { x: GRID_SIZE / 2, y: GRID_SIZE / 2, scale: 6 };
    sweepFinalCamRef.current = finalCam;
    const objs = state.objectives;
    if (!objs.length) {
      setCamera(finalCam);
      return;
    }
    setSweeping(true);
    const first = objs[Math.floor(objs.length * 0.3)] ?? objs[0];
    const second = objs[Math.floor(objs.length * 0.7)] ?? objs[objs.length - 1];
    setCamera({ x: first.x, y: first.y, scale: 10 });
    const t1 = window.setTimeout(() => setCamera({ x: second.x, y: second.y, scale: 10 }), 500);
    const t2 = window.setTimeout(() => setCamera(finalCam), 1050);
    const t3 = window.setTimeout(() => setSweeping(false), 1600);
    sweepTimersRef.current = [t1, t2, t3];
  }, [state?.phase]);

  // Skip either sweep on the player's first keypress or click while one is
  // running — never force them to sit through it.
  useEffect(() => {
    if (!sweeping) return;
    const skip = () => {
      sweepTimersRef.current.forEach((id) => window.clearTimeout(id));
      sweepTimersRef.current = [];
      setSweeping(false);
      if (sweepFinalCamRef.current) setCamera(sweepFinalCamRef.current);
    };
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [sweeping]);

  useEffect(() => {
    return () => {
      sweepTimersRef.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

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

  // Spectators (phase 11 §3) never "have a turn" regardless of which side
  // net/client.ts arbitrarily labelled `you` for colour purposes — this is
  // the client-side half of "cannot issue actions" (net.sendAction/endTurn
  // already no-op for a spectator; the server independently rejects the
  // wire message too, see server/index.ts).
  const myTurn = !!state && !!you && state.activePlayer === you && !net.spectating;

  const actions: ActionAvailability[] = useMemo(
    () => (state && you && selected ? actionAvailability(state, selected, you) : []),
    [state, you, selected]
  );

  const readyFormations = useMemo(() => (state && you ? formationsWithActions(state, you) : []), [state, you]);

  // Priority targets (phase 12 §2) — recomputed from the viewer's own
  // already-fog-filtered `state`, so it is fog-correct by construction: see
  // game/threat.ts. Live for the whole turn, not just at turn start, so it
  // stays honest as the player's own detection picture improves mid-turn.
  const priorityTargets = useMemo(
    () => (state && you && myTurn ? computePriorityTargets(state, you) : []),
    [state, you, myTurn]
  );

  // The first thing a new player sees should be a unit already selected with
  // its orders on screen, not an empty bar telling them to go and click one.
  // Only ever fills a genuinely empty selection — it never steals one.
  useEffect(() => {
    if (!state || !you || selectedId) return;
    if (state.activePlayer !== you) return;
    const first = readyFormations[0];
    if (first) setSelectedId(first.id);
  }, [state, you, selectedId, readyFormations]);

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
  // ---- Pre-attack odds preview -------------------------------------------
  // Same pure function the server resolves with, run against the fog-filtered
  // state the client holds — so an unconfirmed target is predicted from the
  // very assumptions the player is being asked to make.
  const attackTarget = useMemo(
    () =>
      state && selected && (targetMode === 'ATTACK' || targetMode === 'ARTILLERY') && hoverTile
        ? formationAt(state, hoverTile.x, hoverTile.y) ?? null
        : null,
    [state, selected, targetMode, hoverTile?.x, hoverTile?.y]
  );
  const attackPrediction = useMemo(
    () =>
      state && selected && attackTarget && attackTarget.owner !== selected.owner
        ? previewAttack(state, selected.id, attackTarget.id)
        : null,
    [state, selected, attackTarget]
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
        case 'REORGANIZE':
          net.sendAction({ type: 'REORGANIZE', formationId: selected.id });
          break;
        case 'WITHDRAW':
          // Animated movement (phase 12 §4): same path-capture as Move, from
          // the pure planWithdraw the engine itself resolves with.
          {
            const wPlan = planWithdraw(state, selected);
            if (wPlan.ok) moveHintsRef.current.set(selected.id, wPlan.path);
          }
          net.sendAction({ type: 'WITHDRAW', formationId: selected.id });
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
    sound.play('ui');
    net.endTurn();
  }, [state, you, readyFormations, endTurnWarn, net]);

  // ---- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No active game (landing page / lobby, Tutorial and Field Manual
      // included) — this listener has nothing to do. Bailing out here, rather
      // than falling through the branches below with `selected`/`myTurn` both
      // false, is what stops a keypress on the landing page's Tutorial modal
      // (its own nav buttons, or just typing) from preventDefault-ing browser
      // defaults (e.g. Space activating a focused button) for no reason.
      if (!state || !you) return;
      // The pre-battle briefing (phase 10 §1) is a capture-phase modal with
      // its own self-contained Escape/Enter handling (see Briefing.tsx) —
      // bailing here, the same way legendOpen/helpOpen are handled a few
      // lines down, is what stops a shortcut like M/A/E from ever reaching
      // the board while it is up.
      if (briefingOpen) return;
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
      // The Legend and Field Manual are read-only overlays with no keyboard
      // handling of their own — everything past this point is a GAME
      // shortcut (Tab / Z / E / +- / arrows / the action letters), and none
      // of it should reach the map underneath while one of these is open.
      // Escape (above) and the L/H toggles (just above) still work to close
      // them; this is exactly the leak the phase-9 tutorial bug report
      // named — pressing M/A/R/F/E/S while an overlay is open must not arm
      // an action mode in the background.
      if (legendOpen || helpOpen) return;
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
      if (up === 'U') {
        // UAV recon (phase 9) — a player-level order, not tied to a selected
        // formation, so it is handled here rather than through ACTION_BY_SHORTCUT.
        if (myTurn && state && you && state.players[you].uavCharges > 0) {
          setTargetMode((m) => (m === 'UAV_RECON' ? null : 'UAV_RECON'));
        } else if (myTurn) {
          flash('No UAV sorties left this operation.');
        }
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
  }, [targetMode, legendOpen, helpOpen, endTurnWarn, selected, actions, runAction, nextReady, centreOn, doEndTurn, myTurn, flash, groupIds, state, you, briefingOpen]);

  if (replayLinkCode) {
    return (
      <ReplayLinkView
        code={replayLinkCode}
        fetched={net.fetchedReplay}
        error={net.replayError}
        onFetch={net.getReplay}
        onExit={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete('replay');
          window.location.href = url.toString();
        }}
      />
    );
  }

  if (sandboxMode) {
    return <Sandbox onExit={() => setSandboxMode(false)} />;
  }

  if (!state || !you) {
    return (
      <Lobby
        status={net.status}
        roomCode={net.roomCode}
        roomRules={net.roomRules}
        error={net.error}
        onCreate={net.createRoom}
        onJoin={net.joinRoom}
        onSpectate={net.spectate}
        onQuickMatch={net.quickMatch}
        onVsBot={net.vsBot}
        onSandbox={() => setSandboxMode(true)}
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
      sound.play('move');
      clearMode();
      return;
    }
    if (targetMode === 'UAV_RECON') {
      net.sendAction({ type: 'UAV_RECON', x, y });
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
        // Animated movement (phase 12 §4): capture the real path this exact
        // move will take, from the same pure planMove the preview already
        // used, so the client can glide the icon along it once the server
        // confirms — see MapCanvas's animation effect.
        moveHintsRef.current.set(selected.id, plan.path);
        net.sendAction({ type: 'MOVE', formationId: selected.id, x, y });
        sound.play('move');
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
      case 'VERTICAL_INSERT':
        net.sendAction({ type: 'VERTICAL_INSERT', formationId: selected.id, x, y });
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
        onFrameTime={onFrameTime}
        onHoverTile={setHoverTile}
        pings={pings}
        kills={killMarkers}
        moveHints={moveHintsRef}
        combatEffects={combatEffects}
        objectiveFlashes={objectiveFlashes}
        eventFlashes={eventFlashes}
      />

      <TopBar
        state={state}
        you={you}
        objectivesHeld={objectivesHeld}
        objectivesTotal={state.objectives.length}
        uavArmed={targetMode === 'UAV_RECON'}
        onUav={() => setTargetMode((m) => (m === 'UAV_RECON' ? null : 'UAV_RECON'))}
      />
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

      {net.spectating && (
        <div className="spectating-banner" data-testid="spectating-banner">
          <span className="spectating-dot" /> SPECTATING &mdash; {FACTION_SHORT.SABRE} vs {FACTION_SHORT.VANGUARD}, full visibility, read-only
          <button className="btn-ghost small" onClick={net.leaveToLobby} data-testid="spectating-leave">
            Leave
          </button>
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

      {unitPanelT.mounted && lastSelectedRef.current && (
        <UnitDetailPanel
          state={state}
          formation={lastSelectedRef.current}
          onCentre={() => centreOn(lastSelectedRef.current!)}
          onClose={() => setSelectedId(null)}
          className={`panel-anim panel-anim-${unitPanelT.phase}`}
        />
      )}

      <OpsLog state={state} collapsed={logCollapsed} onToggle={() => setLogCollapsed((v) => !v)} />

      {(targetMode === 'ATTACK' || targetMode === 'ARTILLERY') && attackPrediction && attackTarget && selected && (
        <div className="move-preview-wrap">
          <AttackPreview
            prediction={attackPrediction}
            attackerName={selected.shortName}
            defenderName={attackTarget.shortName}
            defenderX={attackTarget.x}
            defenderY={attackTarget.y}
          />
        </div>
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

      {net.spectating ? (
        <div className="action-bar empty-bar" data-testid="spectator-action-bar">
          <span>Spectating — read-only. No orders can be issued from this view.</span>
        </div>
      ) : selected ? (
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
            `${FACTION_SHORT[state.activePlayer]} moving…`
          )}
        </button>
      </div>

      {eventAlert && (
        <button
          className="contact-alert"
          data-testid="contact-alert"
          onClick={() => {
            if (eventAlert.nearest) centreOn(eventAlert.nearest);
            setEventAlert(null);
          }}
          title="Jump to the nearest event"
        >
          <span className="contact-alert-dot" />
          <span className="contact-alert-body">
            <b>{eventAlert.parts.join(' · ')}</b>
            {eventAlert.nearest && (
              <i>
                grid {gridRef(eventAlert.nearest.x, eventAlert.nearest.y)} — click to jump
              </i>
            )}
          </span>
        </button>
      )}
      {turnSummary && (
        <TurnSummaryBanner id={turnSummary.id} text={turnSummary.text} onDone={() => setTurnSummary(null)} />
      )}
      {myTurn && priorityTargets.length > 0 && (
        <PriorityTargets targets={priorityTargets} onJump={(x, y) => centreOn({ x, y })} />
      )}
      {toast && <div className="toast">{toast}</div>}
      {legendOpen && you && <Legend viewer={you} onClose={() => setLegendOpen(false)} />}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
      {reportT.mounted && lastReportRef.current && (
        <BattleReportModal
          report={lastReportRef.current}
          onClose={() => setShowReportId(null)}
          onFocus={() => centreOn({ x: lastReportRef.current!.defenderX, y: lastReportRef.current!.defenderY })}
          className={`panel-anim panel-anim-${reportT.phase}`}
        />
      )}
      {state.phase === 'GAME_OVER' && (
        <EndGameScreen
          state={state}
          you={you}
          onRestart={net.leaveToLobby}
          fetchedReplay={net.fetchedReplay}
          replayError={net.replayError}
          onFetchReplay={net.getReplay}
        />
      )}
      {briefingOpen && (
        <Briefing
          state={state}
          you={you}
          matchKind={net.matchKind}
          botDifficulty={net.botDifficulty}
          onDismiss={() => setBriefingDismissed(true)}
        />
      )}
    </div>
  );
}
