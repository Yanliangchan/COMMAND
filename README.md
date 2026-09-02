# COMMAND — SAF-Inspired Turn-Based Strategy Prototype

A first-playable prototype of a multiplayer turn-based military strategy game
inspired by the Singapore Armed Forces (SAF). Built with **Vite + React +
TypeScript**, rendered on an **HTML5 2D canvas** (no WebGL/3D engine).

This prototype implements **local hotseat 1v1**: two players share one
browser tab, pass the device at "End Turn", and the map redraws from the
active player's perspective with fog of war applied to them only.

## Running it

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build
```

## Architecture

```
src/
  game/                 Pure game logic — no DOM/canvas/React imports.
    types.ts             Core types: Tile, Formation, GameState, etc.
    data.ts              Terrain & formation definitions (stats, flavor text).
    mapgen.ts             Deterministic battlefield generator (60x60 grid).
    engine.ts             All game rules: movement, combat, fog of war,
                           logistics, objectives, turn management.
    store.ts               React glue: a useReducer store wrapping engine.ts.
  render/                Canvas rendering — reads GameState, draws pixels.
    renderMap.ts            Terrain textures, units, overlays, camera math.
    colors.ts                Palette (terrain + faction + UI tokens).
  components/            React UI: TopBar, FormationList, UnitDetailPanel,
                           MapCanvas (pan/zoom/click), BattleReportModal,
                           TurnHandoffScreen, EndGameScreen, OverlayToggles.
  App.tsx                Top-level orchestration: selection, target modes,
                           action dispatch, camera recentering per turn.
```

The **game engine is fully decoupled from rendering** — `src/game/*` has zero
dependencies on React or canvas and operates purely on plain data
(`GameState` in, `GameState` out). It could back a real multiplayer server
with no changes; the `store.ts` reducer is the only place that wires it to
React state.

## What's playable end-to-end

1. A hand-tuned procedurally generated 60×60 battlefield: forest clusters,
   grassland, open terrain, three hill masses (with elevation hachures),
   a winding river with two engineer-buildable bridge crossings, two urban
   districts, an industrial zone, an airfield, two ports (one per side, each
   with its own coastal bay), two supply depots, and eight capture-point
   objectives (bridges, port, airfield, city center, hill, depots).
2. Pan (drag) and zoom (scroll wheel, continuous 3.5×–28× covering
   strategic/operational/tactical framing) camera over the canvas.
3. Nine formation types per side (Infantry ×2, Commando, Armour, Artillery,
   Engineers, Recon, Logistics, Naval Transport, Frigate), each with
   strength/morale/readiness/supply/ammo stats that all affect combat power
   or movement.
4. 15 AP/turn (rollover, capped at 25), with the documented per-action AP
   costs. Move, Attack, Recon, Fortify, Resupply, Artillery fire mission,
   Air strike call-in, Engineer bridge/clear, Commando special ops, and
   amphibious landings are all implemented and spend AP.
5. Click a formation → see its movement range (Dijkstra over terrain cost,
   roads halve cost, rivers block unless bridged, water blocks land units).
   Click a reachable tile to move for 1 AP.
6. Click "Attack", then an adjacent (or in-range, for artillery) enemy to
   resolve combat: terrain defense bonus, morale/readiness/supply/ammo
   multipliers, recon-revealed vs. unrevealed penalty, combined-arms bonus,
   artillery/air support bonus, and a bounded ±15% random roll. Produces a
   full battle report modal: outcome, a bulleted +/- factor list, and
   Light/Moderate/Heavy/Destroyed loss levels for both sides.
7. Fog of war: enemy formations are hidden unless within a friendly unit's
   sight radius or revealed by a Recon/Special-Op action. Out-of-sight
   contacts persist as "Suspected Contact" markers with a confidence value
   that decays over turns since last seen.
8. Eight objectives generate VP/turn for whoever holds them uncontested;
   first to 150 VP (or the higher score after 20 rounds) wins, with an
   end-game screen.
9. Supply depots project a 10-tile supply range (or adjacency to a friendly
   Logistics formation); formations outside it lose supply/readiness each
   turn and fight/move worse. A Supply overlay toggle highlights
   supplied vs. isolated ground. Resupply action restores a formation.
10. End Turn → "Pass the Device" hand-off screen → the map, formation list,
    and fog of war redraw for the other player.

## Real-World Reference vs. Fictional Game Mechanics

Per the design brief, this prototype does **not** reproduce any real SAF
organisational structure, unit counts, or classified/sensitive information.

- **Real-world reference (flavor only):** platform names — SAR 21, Terrex
  ICV, SPIKE-LR ATGM, M110, Leopard 2SG, Hunter AFV, Bionix, SSPH Primus,
  SLWH Pegasus, F-15SG, F-16, Heron 1, Hermes 450, Formidable-class frigate,
  Endurance-class landing ship — appear only as descriptive flavor text on
  each formation type (see `FORMATION_DEFS[...].flavor` in
  `src/game/data.ts`). They do not imply any real organisational structure,
  unit strength, or capability figure.
- **Fictional, game-balance data:** every number that affects gameplay —
  base attack/defense, movement range, sight/recon radius, AP costs, VP
  thresholds, morale multipliers, terrain cost/defense bonuses, supply
  radius, combat roll bounds — is an invented design choice for a playable
  prototype, not real SAF data. These live in `src/game/data.ts`,
  `src/game/types.ts` (`AP_COSTS`, `AP_PER_TURN`, `VP_WIN_THRESHOLD`, ...)
  and `src/game/engine.ts`.

## Design choices / documented deviations

- **AP rollover cap:** leftover AP carries over uncapped in the brief's base
  rule; this prototype caps the carry at 25 (`AP_CAP`) to avoid runaway
  hoarding turning into a first-turn alpha strike, while still rewarding a
  quiet turn with a stronger follow-up.
- **Movement:** flat 1 AP per Move action regardless of distance travelled
  within range, per the brief; the *range* itself is computed from
  unit-type move points, terrain cost, and a readiness/supply penalty.
- **Combat resolution on capture:** a "Position Captured" outcome removes
  the defending formation from the board (retreat is not separately
  modeled) and the attacker occupies the tile — a simplification called out
  here rather than left implicit.
- **Amphibious action:** implemented as a single 3-AP action on the Naval
  Transport that ferries an adjacent friendly formation directly to a
  destination tile, rather than a separate embark/disembark pair — kept
  deliberately simple per the brief's "keep this simple" instruction.

## Explicitly out of scope (future work)

- **Networking / matchmaking.** This is local hotseat only. A real backend
  would reuse `src/game/engine.ts` as-is (it's pure, serializable-state
  logic) behind an authoritative server, with the React layer becoming a
  thin client driven by server-pushed `GameState` diffs.
- **Map editor / force-builder points economy.**
- **Team modes (2v2+) or ranked matchmaking.**
- **DIS/cyber warfare mechanics.**
- **AI opponent** — both seats are human-controlled in this prototype.

## Testing performed

- `npm run build` — TypeScript project build + Vite production build, no
  errors.
- Automated smoke test via Playwright (Chromium): loaded the dev server,
  selected a formation from the panel, confirmed the movement-range overlay
  rendered around it, forced an adjacency scenario to drive the Attack
  flow through the real UI (select unit → Attack → click enemy tile),
  confirmed the battle report modal renders outcome/power/factors/losses
  correctly and updates formation strength/morale, clicked End Turn,
  confirmed the "Pass the Device" hand-off screen appears and that the
  next screen shows REDFOR's own formation list, camera recentered on
  REDFOR's forces, and BLUEFOR formations no longer visible (fog of war
  correctly scoped to the new active player).
