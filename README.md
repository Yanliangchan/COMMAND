# COMMAND — SAF-Inspired Turn-Based Strategy Prototype

A first-playable prototype of a multiplayer turn-based military strategy game
inspired by the Singapore Armed Forces (SAF). Built with **Vite + React +
TypeScript**, rendered on an **HTML5 2D canvas** (no WebGL/3D engine), with
a small **Node + `ws` WebSocket server** as the authoritative multiplayer
host.

This is **real two-client multiplayer**: a lobby (create a room / join a
room code / quick match) pairs two browsers, and a Node process holds the
one true `GameState` per room, validates every move, resolves combat, and
sends each player their own fog-of-war-filtered view. Neither client trusts
the other, and neither client computes combat or fog itself.

## Running it

You need **two processes**: the WebSocket server and the Vite dev server.

```bash
npm install

# one terminal
npm run server     # starts the authoritative WS server on ws://localhost:8787

# another terminal
npm run dev         # starts the Vite client on http://localhost:5173

# or both at once, in one terminal:
npm run dev:all
```

Open `http://localhost:5173` in two separate browser windows/profiles (or
one normal + one incognito) to play both sides. By default the client
connects to `ws://localhost:8787`; override with a `VITE_WS_URL` env var
(copy `.env.example` to `.env.local` and edit it) if the server runs
elsewhere.

```bash
npm run build       # type-check (client + implicitly server via tsc -b) + production build
npm run preview      # preview the production client build
```

Note: `npm run build` type-checks and bundles the **client** only (`tsc -b`
is scoped to `src/`, per `tsconfig.json`'s `include`). The server has its
own `server/tsconfig.json` for editor/type-check support and is run
directly with `tsx` (no separate build step needed for this prototype) —
`npx tsc -p server/tsconfig.json --noEmit` type-checks it standalone.

## Architecture

```
src/
  game/                 Pure game logic — no DOM/canvas/React/Node imports.
    types.ts             Core types: Tile, Formation, GameState, etc.
    data.ts              Terrain & formation definitions (stats, flavor text).
    mapgen.ts             Deterministic battlefield generator (60x60 grid).
    engine.ts             All game rules: movement, combat, fog-of-war refresh,
                           logistics, objectives, turn management.
    fog.ts                 filterStateForPlayer(state, viewer) — redacts a
                           true GameState down to what one player is allowed
                           to see. Imported by BOTH the server (to build each
                           player's outbound state) and nothing else client-side
                           (the client never sees the true state to redact).
  net/                   Wire protocol + browser WebSocket client.
    protocol.ts            Shared ClientMsg/ServerMsg/GameAction types —
                           imported by both src/ and server/.
    client.ts               useMultiplayer() React hook: lobby flow (create/
                           join/quick-match), session persistence
                           (sessionStorage) for refresh-reconnect, and
                           send-action / receive-state plumbing. Contains
                           zero game logic — it only relays.
  render/                Canvas rendering — reads GameState, draws pixels.
    renderMap.ts            Terrain textures, units, overlays, camera math.
    colors.ts                Palette (terrain + faction + UI tokens).
  components/            React UI: Lobby, TopBar, FormationList,
                           UnitDetailPanel, MapCanvas (pan/zoom/click),
                           BattleReportModal, EndGameScreen, OverlayToggles.
  App.tsx                Top-level orchestration: connects useMultiplayer(),
                           renders the Lobby until a game starts, then wires
                           selection/target-mode/canvas clicks to
                           net.sendAction(...) calls.
  styles.css              "Modern tactical ops-room" theme — see below.
server/
  index.ts               Authoritative WebSocket server (Node + `ws`).
                           In-memory `Map<roomCode, Room>` — no database.
                           Room lifecycle: create / join / quick-match queue
                           / reconnect-with-token / disconnect grace period /
                           idle-room sweep. See "Multiplayer design" below.
  tsconfig.json           Type-checking config for the server (Node lib,
                           not included in the client's `tsc -b`).
```

The **game engine is fully decoupled from rendering and from any specific
runtime** — `src/game/*` has zero dependencies on React, canvas, or Node/DOM
APIs and operates purely on plain, serializable data (`GameState` in,
`GameState` out). This is what makes it possible for `server/index.ts` to
`import * as engine from '../src/game/engine'` and run the identical rules
Node-side as the client renders — there is only one implementation of combat,
movement, and fog-of-war in the whole codebase.

## Multiplayer design

- **Lobby.** Three options: **Create Room** (generates a 5-character room
  code from an unambiguous alphabet — no `0/O/1/I/L` — and waits), **Join
  Room** (enter a code), and **Quick Match** (joins a one-slot waiting queue;
  the next Quick Match request pairs with it immediately). A room starts the
  moment its second seat fills.
- **Side assignment.** Whoever fills each of a room's two seats gets
  `BLUEFOR`/`REDFOR` assigned **randomly** per room (not "creator is always
  BLUEFOR") — the server flips a coin once per room in `makeSeats()`.
- **Server authority.** `server/index.ts` holds the one true `GameState` per
  room and is the only place `engine.ts`'s mutating functions
  (`moveFormation`, `attackAction`, `endTurn`, …) are called on that state.
  A client message that isn't legal — wrong turn, illegal move, artillery
  out of range, etc. — either no-ops (the engine functions already
  early-return unchanged state on an illegal call) or is rejected outright
  server-side before dispatch (`applyAction` checks
  `state.activePlayer === playerId` up front, since several engine actions
  like `airStrikeAction` don't check the caller's identity themselves — the
  server closes that gap rather than trusting the client's declared turn).
- **Fog of war, enforced server-side.** After every action the server calls
  `filterStateForPlayer(state, viewer)` (`src/game/fog.ts`) once per seat and
  sends each player only their own redacted view over the wire: their own
  formations in full, plus any enemy formation currently under **live**
  visual contact this exact refresh (`confidence === 100 &&
  lastSeenTurn === state.round`). A decaying/stale "suspected contact" is
  **not** sent as a formation object at all — the client only ever gets the
  contact's last-known `x,y,type,confidence` via the player's own
  `contacts` map (already rendered as the dashed "?" marker), never the
  enemy's true live position or stats. The enemy player's own `contacts`
  map (what *they've* spotted of *you*) is also zeroed before sending, so
  it can't be read as a side-channel. This is why the client's local
  `src/game/store.ts` reducer from the old hotseat build was deleted
  outright rather than kept dormant — a real client that computed fog
  itself would necessarily have held the true, unredacted state in memory.
- **Reconnect.** The client stores `{ code, token }` in `sessionStorage` on
  join/create. On mount it tries a `reconnect` handshake automatically, so a
  page refresh mid-game resumes the same seat rather than losing it. If a
  socket drops, the server tells the other player ("Opponent disconnected —
  waiting…") and holds the room open for a **2-minute grace period**; a
  reconnect within that window resumes silently, and if it lapses the
  remaining player is told the room is gone (`opponent_left`) and the room
  is deleted. Empty rooms nobody has touched in 10 minutes are swept
  periodically. All in-memory — a server restart drops every room, which is
  an accepted prototype-scope limitation (see below).
- **Turn handoff removed.** The old build's `TurnHandoffScreen` ("pass the
  device") is gone entirely, along with the `TURN_HANDOFF` pause it drove —
  the server calls `engine.beginPlayerTurn()` immediately after
  `engine.endTurn()` so turn control just flips between the two live
  sockets. `EndGameScreen` is kept (still relevant — it's now driven by the
  server-pushed `phase: 'GAME_OVER'` state) but its restart button now reads
  "Return to Lobby" and disconnects back to the lobby screen rather than an
  instant shared restart, since coordinating a synchronized rematch between
  two independent sockets was out of scope for this pass.

## Visual redesign — "modern tactical ops-room"

The old palette (dark olive-black `#0c1410` panels, saturated green/cyan/
red accents, a single system-UI font) has been replaced across every
screen — lobby included — with:

- **Base:** dark graphite/slate panels (`--panel #1b2126`, `--panel-2
  #212830`, `--border #37424c` on a `--bg #12161a` ground) instead of the
  old near-black olive — a command-console-at-night feel rather than pure
  black.
- **Accents:** muted olive-green (`--olive #93a35f` / `--olive-bright
  #b4c47f`) for friendly/positive state (strength bars, panel titles,
  "your turn" affordances where positive) and muted amber (`--amber
  #cf9a44` / `--amber-bright #e6b665`) for active/primary actions — the End
  Turn button, room codes, the AP counter, target-mode hints, primary lobby
  buttons. Both are deliberately desaturated, not neon.
- **Typography:** **Rajdhani** (condensed, technical) for all headers,
  labels, stat values, and UI chrome; **Inter** for longer body copy (unit
  flavor text, hints, battle-report factor lines) — loaded via a Google
  Fonts `<link>` in `index.html`.
- **Faction colors** (BLUEFOR/REDFOR on the map and in chips) were nudged
  toward the same muted family (`#6fa8c9` steel blue / `#c17a5f` muted
  rust) rather than the old saturated cyan/coral, for consistency with the
  ops-room tone — the terrain palette in `src/render/colors.ts`
  (`TERRAIN_COLORS`) is intentionally **untouched**, per the brief, since
  it aims for a physical-terrain look that was already reviewed positively.
- Applied consistently to every screen: the new **Lobby** (create/join/quick
  match/waiting states), TopBar, FormationList, UnitDetailPanel,
  OverlayToggles, BattleReportModal, and EndGameScreen.

## What's playable end-to-end

1. A hand-tuned procedurally generated 60×60 battlefield: forest clusters,
   grassland, open terrain, three hill masses (with elevation hachures),
   a winding river with two engineer-buildable bridge crossings, two urban
   districts, an industrial zone, an airfield, two ports (one per side, each
   with its own coastal bay), two supply depots, and eight capture-point
   objectives (bridges, port, airfield, city center, hill, depots) —
   generated **once, server-side**, when a room is created (not per-client).
2. Pan (drag) and zoom (scroll wheel, continuous 3.5×–28× covering
   strategic/operational/tactical framing) camera over the canvas.
3. Nine formation types per side (Infantry ×2, Commando, Armour, Artillery,
   Engineers, Recon, Logistics, Naval Transport, Frigate), each with
   strength/morale/readiness/supply/ammo stats that all affect combat power
   or movement.
4. 15 AP/turn (rollover, capped at 25), with the documented per-action AP
   costs. Move, Attack, Recon, Fortify, Resupply, Artillery fire mission,
   Air strike call-in, Engineer bridge/clear, Commando special ops, and
   amphibious landings are all implemented, validated, and applied
   server-side.
5. Click a formation → see its movement range (Dijkstra over terrain cost,
   roads halve cost, rivers block unless bridged, water blocks land units).
   Click a reachable tile to send a `MOVE` action for 1 AP.
6. Click "Attack", then an adjacent (or in-range, for artillery) enemy to
   send an `ATTACK` action: terrain defense bonus, morale/readiness/supply/
   ammo multipliers, recon-revealed vs. unrevealed penalty, combined-arms
   bonus, artillery/air support bonus, and a bounded ±15% random roll —
   all resolved on the server. Produces a full battle report modal on
   **both** clients: outcome, a bulleted +/- factor list, and
   Light/Moderate/Heavy/Destroyed loss levels for both sides.
7. Fog of war, enforced server-side (see above): enemy formations are
   hidden unless within a friendly unit's sight radius or revealed by a
   Recon/Special-Op action this refresh. Out-of-sight contacts persist as
   "Suspected Contact" markers with a confidence value that decays over
   turns since last seen — a client literally cannot query the server for
   what it isn't allowed to know.
8. Eight objectives generate VP/turn for whoever holds them uncontested;
   first to 150 VP (or the higher score after 20 rounds) wins, with an
   end-game screen driven by server-pushed `phase: 'GAME_OVER'` state.
9. Supply depots project a 10-tile supply range (or adjacency to a friendly
   Logistics formation); formations outside it lose supply/readiness each
   turn and fight/move worse. A Supply overlay toggle highlights
   supplied vs. isolated ground. Resupply action restores a formation.
10. Real two-client multiplayer via room code or Quick Match (see
    "Multiplayer design" above) — no pass-and-play, no shared browser tab.

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
- **Side assignment on room join** is randomized per room, not "creator is
  always BLUEFOR" — called out explicitly since the brief left the choice
  open.
- **Fog-of-war "ghost" formations are omitted, not faked.** Rather than
  sending a synthetic Formation object with placeholder stats for a stale
  contact (which would need inventing fictional-but-plausible values with
  no real basis), the redacted state simply omits it; the existing
  contact-marker overlay already communicates "something was here" without
  a body of fabricated data behind it.
- **Reconnect grace period (2 minutes) and idle-room sweep (10 minutes)**
  are fixed constants (`RECONNECT_GRACE_MS`, `EMPTY_ROOM_TTL_MS` in
  `server/index.ts`) rather than configurable — reasonable prototype
  defaults, not tuned against real usage data.

## Explicitly out of scope / deferred (future work)

- **Production deployment.** The server is designed to run as a single
  long-lived Node process holding in-memory rooms (e.g. on Railway or
  similar) — but no deployment was actually performed in this session, no
  `Procfile`/deploy config was added, and `VITE_WS_URL` still defaults to
  `localhost` for local dev. Wiring this to Railway (or another host),
  picking a production WS URL, and pointing the built client at it is
  future work.
- **Persistence.** Rooms are an in-memory `Map` on one server process — a
  server restart drops every in-progress game. No database, matchmaking
  history, accounts, or rating system.
- **Synchronized "rematch" / new-game handshake.** `EndGameScreen`'s
  "Return to Lobby" disconnects both clients back to the lobby individually
  rather than offering a one-click shared rematch in the same room.
- **Spectators, team modes (2v2+), or ranked matchmaking.**
- **Map editor / force-builder points economy.**
- **DIS/cyber warfare mechanics.**
- **AI opponent** — both seats are human-controlled.

## Testing performed

- `npm run build` — TypeScript project build (client, `tsc -b`, scoped to
  `src/`) + Vite production build, no errors. `npx tsc -p
  server/tsconfig.json --noEmit` — server type-checks clean against its own
  Node-targeted config.
- Ran the real WS server (`npm run server`) and Vite dev server (`npm run
  dev`) together and drove **two independent Chromium browser
  contexts** (Playwright) end-to-end as two real, separate clients:
  - **Room-code flow:** context A creates a room, gets a 5-character code,
    context B joins with it; both reach the in-game screen with opposing
    `BLUEFOR`/`REDFOR` assignments confirmed via each client's own state.
  - **Quick Match flow:** two fresh contexts both hit Quick Match around the
    same time and were auto-paired into a fresh room with correct opposing
    side assignment.
  - **Move + fog-of-war:** drove a real `MOVE` action from BLUEFOR through
    the wire; confirmed the server-applied result reflected back to the
    mover, and confirmed REDFOR's own filtered state exposed **only its own
    10 formations** at that point (not the opponent's true positions) —
    the server-side redaction holds under an actual network round trip, not
    just in isolated unit logic.
  - **End Turn:** drove a real `END_TURN` action and confirmed
    `state.activePlayer` flipped on **both** independent clients with no
    pass-and-play screen anywhere in the flow.
  - **Attack + battle report:** marched two Commando formations toward a
    shared river-bridge rendezvous point over ~18 real alternating turns
    (multiple real `MOVE` + `END_TURN` round trips against the live
    server), reached adjacency, sent a real `ATTACK` action, and confirmed
    an identical, correctly-populated battle report (outcome, attacker/
    defender power, factor list, loss levels) rendered on **both**
    independent clients from the one server-computed result.
  - Screenshotted: the lobby landing screen, the room-code waiting state,
    both players' in-game view side by side (with the redesigned topbar/
    formation list/canvas), the Quick Match "searching" state, and the
    redesigned battle report modal on both clients.
