# COMMAND — Lead the force. Shape the battlefield.

**COMMAND** is a multiplayer turn-based military strategy game inspired by the
Singapore Armed Forces (SAF). Built with **Vite + React +
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
    mapgen.ts             Deterministic TOPOGRAPHIC battlefield generator
                           (72x72 grid): fBm heightfield -> depression fill ->
                           D8 flow routing -> rivers -> moisture/terrain ->
                           settlements -> A* road network -> objectives, with a
                           hard validation + retry loop (see "Map generation").
    actions.ts            Action availability model — the single answer to
                           "what can this formation do right now, and if not,
                           why not", shared by the action bar, the keyboard
                           handler, the roster badges and the end-turn warning.
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
  components/            React UI. Lobby (+ Tutorial / TutorialDiagram),
                           TopBar and OverlayToggles (floating HUD strips),
                           FormationList (roster with per-unit "orders left"
                           badges), UnitDetailPanel (compact selected-unit
                           card), ActionBar (order buttons with shortcuts),
                           Legend, HelpPanel, MapCanvas (pan/zoom/click),
                           BattleReportModal, EndGameScreen.
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

- **Front page / lobby.** A designed landing page (dark graphite, a hero
  backdrop that is a *real generated battlefield* rendered once by the game's
  own canvas renderer, with a static gradient fallback), then three ways in:
  the primary **Play vs Bot** row (Easy / Medium / Hard), then **Create Room**
  (generates a 5-character room
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
- **Fog of war, enforced server-side, redacted BY DETECTION LEVEL.** After
  every action the server calls `filterStateForPlayer(state, viewer)`
  (`src/game/fog.ts`) once per seat and sends each player only their own
  redacted view over the wire. Since phase 4b that redaction is a four-rung
  ladder rather than a visibility flag, and each rung reveals strictly more:
  - **Unknown** — the enemy formation is absent from the payload *entirely*:
    no formation object, no contact record, no id, nothing. The client is not
    told the unit exists.
  - **Contact** — a contact record only: position, confidence, level. No
    `type`, no strength, no designation, no formation object. "Something is at
    F-42" is the whole of what is sent.
  - **Identified** — a *redacted* formation object: id, owner, arm, position,
    a generic title ("Enemy Infantry"), and `-1` in every numeric field. The
    true designation, strength, morale, supply, ammo, readiness, dug-in state,
    equipment and last order never leave the server.
  - **Confirmed** — the real formation object, untouched.

  The redacted object is built from an explicit field list rather than by
  deleting fields off a spread of the real one, so a field added to
  `Formation` later fails *closed* (absent) instead of leaking. The enemy
  player's own `contacts` map (what *they've* spotted of *you*) is zeroed
  before sending, so it can't be read as a side-channel, and the shared
  operations log is filtered by a per-entry `audience` tag so it can no longer
  narrate an enemy move the viewer has not detected. This is why the client's
  local `src/game/store.ts` reducer from the old hotseat build was deleted
  outright rather than kept dormant — a real client that computed fog itself
  would necessarily have held the true, unredacted state in memory.
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

1. A procedurally generated **72×72 topographic battlefield** (5,184 tiles —
   trimmed ~19% from 80×80 in phase 3 so the board reads at a glance and the
   two forces meet sooner): a continuous fractal heightfield with coherent
   ridges and massifs, a coastline derived from sea level, a dendritic river
   network that actually flows downhill to the sea with confluences, large
   continuous forest stands, five settlements grown around water and road
   junctions, industrial ground on coastal fringes, two airfields, two ports,
   two supply depots, an A*-routed road network with bridges at the river
   crossings, and ~22 capture objectives spread across the map (urban
   districts, ports, airfields, bridges, hills, depots and three open-sea
   anchorages). Generated **once, server-side**, when a room is created, and
   **validated before it is served** (see "Map generation" below).
2. Pan (drag) and zoom (scroll wheel, continuous 3.5×–28× covering
   strategic/operational/tactical framing) camera over the canvas.
3. Ten formations per side (Infantry ×3, Commandos, Armour, Artillery,
   Combat Engineers, C4I/ISR, Frigate squadron, Littoral combat squadron),
   each with strength/morale/readiness/supply/ammo stats that all affect
   combat power or movement, and each with a **per-round movement-action
   allowance** (see "Movement actions and the AP economy").
4. 26 AP/turn (rollover, capped at 34), with the documented per-action AP
   costs. Move, Attack, Recon, Fortify, Resupply, Artillery fire mission,
   Air strike call-in, Engineer bridge/clear and Commando special ops are
   implemented, validated and applied server-side.
5. Click a formation → see its movement range (Dijkstra over terrain cost;
   roads halve cost, climbing a band of elevation costs extra, rivers block
   land units unless bridged, ships are confined to the validated navigable
   water body). Click a reachable tile to send a `MOVE` action for 1 AP —
   and do it again, up to that formation's movement allowance for the round.
6. Click "Attack", then an adjacent (or in-range, for artillery) enemy to
   send an `ATTACK` action: terrain defense bonus, morale/readiness/supply/
   ammo multipliers, recon-revealed vs. unrevealed penalty, combined-arms
   bonus, artillery/air support bonus, and a bounded ±15% random roll —
   all resolved on the server. Produces a full battle report modal on
   **both** clients: outcome, a bulleted +/- factor list, and
   Light/Moderate/Heavy/Destroyed loss levels for both sides.
7. Fog of war, enforced server-side (see above). Spotting is **passive and
   continuous**: every formation watches its surroundings for free, and an
   enemy inside its detection range with line of sight is detected without any
   order or AP being spent, on either side's turn. Detection range comes from
   the formation type (`DETECTION` in `src/game/types.ts`) and is modified by
   the observer's terrain, the target's concealment and the height difference
   between them; line of sight is a height-profile ray across the map's
   continuous `Tile.height`, so relief blocks sightlines and a unit on a ridge
   sees over the low ground. What you know is a Contact → Identified →
   Confirmed ladder carried as a 0-100 confidence that rises with closer,
   better and repeated observation (at most once per round) and decays every
   round once sight is lost. The Recon order is an amplifier on top: longer
   sensor range, sees through cover, a flat confidence bonus that jumps
   contacts up the ladder, and slower decay on what it has tracked.
8. ~20 objectives generate VP for whoever holds them uncontested; land
   objectives are held by ground formations, the three open-sea anchorages
   only by warships. VP are paid out once per **round** (at the end of
   REDFOR's turn) to both holders at once, and victory is only adjudicated at
   a round boundary, so the first player does not get half a round of free
   scoring every round. First to 200 VP (or the higher score after 24 rounds)
   wins, with an end-game screen driven by server-pushed `phase: 'GAME_OVER'`.
9. Supply is a **positional modifier, not a logistics mini-game**: a formation
   is in supply within 14 tiles of one of its side's supply sources — its
   depots, or any Port / Airfield / Supply Depot objective it currently holds.
   Outside that it loses supply/readiness each turn and fights and moves
   worse. Warships carry their own stores. A Supply overlay toggle highlights
   supplied vs. isolated ground; the Resupply action restores a formation.
   There are no supply convoys, transports or routes to shepherd.
10. Real two-client multiplayer via room code or Quick Match (see
    "Multiplayer design" above) — no pass-and-play, no shared browser tab.

## Real-World Reference vs. Fictional Game Mechanics

Per the design brief, this prototype does **not** reproduce any real SAF
organisational structure, unit counts, order of battle, or
classified/sensitive information.

### Formation naming

BLUEFOR formations use **real, publicly documented SAF naming conventions**,
verified against public sources before being adopted:

| In-game formation | Designation | Echelon | Arm |
| --- | --- | --- | --- |
| 1st Battalion, Singapore Infantry Regiment | 1 SIR | Battalion | Infantry |
| 2nd Battalion, Singapore Infantry Regiment | 2 SIR | Battalion | Infantry |
| 5th Battalion, Singapore Infantry Regiment | 5 SIR | Battalion | Infantry |
| 1st Commando Battalion | 1 CDO BN | Battalion | Commandos |
| 40th Battalion, Singapore Armoured Regiment | 40 SAR | Battalion | Armour |
| 21st Battalion, Singapore Artillery | 21 SA | Battalion | Artillery |
| 35th Battalion, Singapore Combat Engineers | 35 SCE | Battalion | Combat Engineers |
| 24th C4I Battalion | 24 C4I | Battalion | C4I / Signals & ISR |
| 185 Squadron, Republic of Singapore Navy | 185 SQN | Squadron | RSN |
| 188 Squadron, Republic of Singapore Navy | 188 SQN | Squadron | RSN |

What was checked, and what that means:

- The **convention** is `<ordinal> Battalion, <Regiment/Corps name>`,
  abbreviated `<number> <initials>` — e.g. "40th Battalion, Singapore Armoured
  Regiment (40 SAR)". Note the corps names differ in form: it is the
  Singapore Infantry **Regiment** and the Singapore Armoured **Regiment**, but
  the **Singapore Artillery** and the **Singapore Combat Engineers** (so the
  correct form is "21st Battalion, Singapore Artillery / 21 SA", *not*
  "21st Battalions Singapore Artillery Regiment" — the typo'd form in the
  original brief has been corrected here rather than copied).
- The Commandos use a **battalion** designation ("1st Commando Battalion",
  1 CDO BN), not a company or squadron one.
- The intelligence/recon formation is a **C4I battalion** — the SAF publicly
  formed C4I battalions from earlier Signal battalions, and the convention is
  `<number> C4I Battalion` (e.g. "10 C4I"). The number **24** used in game is
  a fictional assignment; it is not a claim about any real unit.
- The RSN organises ships into numbered **squadrons** (e.g. 185 Squadron for
  the Formidable-class frigates, 188 Squadron for the Victory-class
  corvettes), not battalions.

> **The specific battalion/squadron numbers assigned to in-game formations,
> and the roles, stats and capabilities attached to them, are fictional
> gameplay assignments that merely follow real SAF naming conventions.** They
> are not, and must not be read as, a real SAF order of battle. Where a real
> unit's actual role is not publicly documented, a plausible designation
> following the correct convention and echelon was chosen rather than
> inventing an "organisational fact".

**REDFOR is a wholly fictional opposing force** — the "Northern Union
Forces" — with its own coherent, deliberately non-SAF scheme (3/7/11
Motorised Rifle Battalions, 1st Special Purpose Battalion, 22nd Tank
Battalion, 14th Gun & Rocket Artillery Battalion, 6th Assault Engineer
Battalion, 9th Reconnaissance & EW Battalion, 1st Guided-Missile Frigate
Group, 5th Missile Corvette Flotilla). It is not a mirror of real SAF unit
numbers, and its equipment text names no real platform.

### Equipment flavour

- **Real-world reference (flavour only):** platform names — SAR 21, Terrex
  ICV, Bronco, SPIKE-LR ATGM, Leopard 2SG, Hunter AFV, Bionix, SSPH Primus,
  SLWH Pegasus, FH2000, HIMARS, F-15SG, F-16, Heron 1, Hermes 450,
  Formidable-class frigate, Victory-class corvette, Independence-class LMV —
  appear only as descriptive flavour text on BLUEFOR formations
  (`ORDERS_OF_BATTLE` in `src/game/data.ts`). They do not imply any real
  organisational structure, unit strength, or capability figure, and no
  platform is attributed to any real unit.
- **Fictional, game-balance data:** every number that affects gameplay —
  base attack/defense, movement range, movement-action allowance,
  attack range, sight/recon radius, AP costs, VP thresholds, morale
  multipliers, terrain cost/defense bonuses, supply radius, combat roll
  bounds — is an invented design choice for a playable prototype, not real
  SAF data. These live in `src/game/data.ts`, `src/game/types.ts`
  (`AP_COSTS`, `AP_PER_TURN`, `MOBILITY`, `MORALE_BASELINE`, `VP_WIN_THRESHOLD`, …) and
  `src/game/engine.ts`.
- The map is a **fictional generated landmass**. It is not Singapore and does
  not depict any real terrain, base, installation or coastline.

## Movement actions and the AP economy

The old build gave every formation exactly one "major action" a round, which
made manoeuvre glacial and left players ending turns with unspent AP. That is
replaced by a **two-budget** model:

- **A global AP pool** — 26 AP per turn, rolling over up to a 34 AP cap. Every
  action still costs AP exactly as before (Move 1, Attack 2, Recon 1, Fortify
  1, Resupply 1, Artillery 2, Engineer bridge 2 / clear 1, Special Op 3, Air
  strike 3).
- **A per-unit, per-round movement-action allowance** (`MOBILITY` in
  `src/game/types.ts`), surfaced on every `Formation` as `movesUsed` /
  `movesMax` so the UI can show "Movement Actions: 1 / 2".

Crucially, **movement and the major action are separate budgets**: a formation
may move, fire, and move again in the same round. The counters reset at the end
of that side's turn.

### Mobility table (phase 4a)

Base movement follows the formation's **operational role**, not a
combat/support split. `Movement Range` is the movement points one bound gets
(1 point = one ordinary grass/open tile, so it is quoted in tiles);
`road tiles` is how far the same bound reaches following a road the whole way.

| Formation | Range | Actions / round | Road tile cost | Tiles by road | Tiles / round (road) | Rough going |
| --- | --- | --- | --- | --- | --- | --- |
| Infantry (1/2/5 SIR) | 4 | 2 | 0.65 | 6 | 8 (12) | — |
| Commandos (1 CDO BN) | 6 | 3 | 0.70 | 8 | 18 (24) | — |
| Armour (40 SAR) | 5 | 2 | 0.50 | 10 | 10 (20) | ×1.5 |
| Artillery (21 SA) | 4 | 2 | 0.50 | 8 | 8 (16) | ×1.25 |
| Combat Engineers (35 SCE) | 4 | 2 | 0.50 | 8 | 8 (16) | ×1.25 |
| C4I / ISR (24 C4I) | 6 | 3 | 0.50 | 12 | 18 (36) | — |
| Frigate squadron (185 SQN) | 7 | 2 | — | — | 14 | — |
| Littoral squadron (188 SQN) | 8 | 3 | — | — | 24 | — |

"Rough going" is the surcharge heavy formations pay in forest, urban and
industrial tiles — it is what makes armour specifically fast **on roads and in
the open** rather than fast everywhere, and it is itemised in the movement
preview rather than applied invisibly.

The headline fix is artillery and engineers: **3 range × 1 action = 3 tiles a
round** previously, against armour's 10. They now get **4 × 2 = 8**. Over 12
bot-vs-bot games per configuration (identical seeds before and after) that
drops the average distance from a support element to the nearest friendly
manoeuvre formation, and the share of sampled unit-rounds in which a support
element is stranded more than 8 tiles from any manoeuvre element:

| Cohesion metric | Before | After |
| --- | --- | --- |
| Avg. support → nearest manoeuvre formation, MEDIUM bot | 8.54 tiles | **2.65 tiles** |
| Avg. support → nearest manoeuvre formation, HARD bot | 8.74 tiles | **2.70 tiles** |
| Support stranded > 8 tiles, MEDIUM bot | 36.6% | **6.6%** |
| Support stranded > 8 tiles, HARD bot | 37.6% | **4.9%** |

Readiness and supply still modulate range, but in two coarse, **named** steps
(×0.75 for readiness < 50%, ×0.75 for supply < 30%) that are printed on the
unit card — never a smooth hidden fudge. The same unit on the same ground
always gets the same number.

### Move Formation

An **optional** grouped order. Shift-click two or more friendly formations (map
or roster), press <kbd>Shift</kbd>+<kbd>M</kbd>, click a destination: the group
advances together, **paced to the slowest participant's single-action range**,
with destination tiles resolved around the objective so nothing stacks
illegally. Every participant spends one of its own movement actions and 1 AP —
the total is shown before confirming — and a formation with no movement actions
left is named in the preview rather than silently dropped. Single-unit movement
is completely unchanged.

### Movement preview

`src/game/movement.ts` is the single source of truth: range, per-tile cost,
reachable set, exact path, road bonus, actions required, refusal reasons and
cohesion advisories. The client preview calls the **same pure functions the
server validates with**, so the preview can never promise something the rules
will refuse. Hovering a tile in Move mode reads e.g.

```
MOVE TO GRID H-42 · Distance 6 · Terrain Cost Moderate · Road Bonus +2 · Movement Actions: 1 required · 1 AP
```

An illegal destination is never silently ignored — it is explained ("Too far",
"Terrain impassable — a river crossing. Bring engineers up to bridge it.",
"Enemy-controlled position", "Warships cannot go ashore", "Tile already
occupied by 1 SIR").

### Grid references

There is one map-sheet coordinate scheme (`gridRef` in `src/game/types.ts`):
lettered columns, 1-based numbered rows, e.g. `H-42`. It is used by the
movement preview, the hover label on the map, the order log, contact markers
and the battle report alike.

### Formation cohesion (movement-side)

Artillery and engineers are matched to the nearest friendly manoeuvre formation
(`supportedFormation`). Moving either past `COHESION_RADIUS` (6 tiles) raises an
**advisory** — "35 SCE is becoming separated from supported formation" — as does
moving a manoeuvre element away from a support unit that has nobody else to fall
in with. It is advice, never a veto.

## Morale (phase 4a)

Morale used to be a discrete band that ratcheted **down** on essentially every
engagement and had no route back up: over bot-vs-bot games the average
end-of-game morale of surviving formations was 61.5 out of 100 against a 75
start, with 1.3 band transitions per unit per game and a per-round chance of
Broken. It behaved like a fluctuating resource.

It is now a **long-term battlefield condition**. Each formation carries a
continuous `moraleValue` (0–100) and a per-type `moraleBaseline`
(`MORALE_BASELINE`) that it drifts back toward. The five named bands
(Elite / Steady / Stressed / Shaken / Broken) are derived from that number and
still multiply combat power exactly as before.

- **Casualties have a dead zone.** Anything up to 15 strength lost costs no
  morale at all; beyond that the shock is `(loss − 15) × 0.5`. Indirect fire
  (artillery, air, raids) carries half that weight.
- **Shocks** (`MORALE_SHOCKS`) are the only other thing that moves it: a major
  attack repulsed (−5), being driven off a position (−8), losing an objective
  your side held (−6 to units near it), a friendly battalion destroyed nearby
  (−7), being surrounded (−4/round), isolated (−3/round), supply critical
  (−5/round) or low (−2/round). Upward: taking a position by assault (+6),
  capturing an objective (+8), resupplying and reorganising (+3).
- **Recovery** is gradual and conditional: +3 base, +3 in supply, +2 holding
  position (did not move, or dug in), +2 with a friendly formation inside the
  cohesion radius — halved if the formation is on its own, and zero in the
  round it fought. Recovery only ever pulls **toward** the baseline.
- **Élan above the baseline has diminishing returns** (`MORALE_ELAN_CEILING`)
  and decays 2/round, so Elite must be earned and cannot be farmed off a run of
  easy objective captures.

Measured over 12 bot-vs-bot games per configuration (HARD, same seeds):

| Metric | Before | After |
| --- | --- | --- |
| Average morale (0–100, sampled per formation per round) | 70.4 | **75.2** |
| Unit-rounds Steady | 86.7% | **97.4%** |
| Unit-rounds Shaken or Broken | 4.9% | **0.0%** |
| Band changed between rounds | 5.4% | **2.2%** |
| Band transitions per unit per game (every action sampled) | 1.25 | **0.30** |
| Formations that hit Broken at some point in a game | 27.9% | **0.0%** |
| Formations that hit Shaken or worse at some point | 35.0% | **0.4%** |
| Formations that never left Steady | 46.3% | **87.9%** |
| Average morale of survivors at game end | 61.2 | **74.1** |

It has not lost its teeth: three consecutive heavy maulings (−40 strength each)
plus being driven off its position still walks an infantry battalion
72 → 59.5 → 47 → 34.5 → 26.5, i.e. Steady → Stressed → Shaken → **Broken**; six
quiet rounds in supply beside friendly forces bring it back to 72. Five light
contacts (−12 strength each) move it **not at all**.

## Detection model (phase 4b)

Spotting used to require spending a Recon action, which meant a player could
stand next to an enemy battalion and not see it. It is now **passive and
continuous** — every formation watches its arcs for free, refreshed for both
sides after anything that moves a unit — and the Recon order became an
amplifier rather than a prerequisite. The whole model lives in
`src/game/detection.ts`; the rung-by-rung wire redaction lives in
`src/game/fog.ts`.

### Detection range by formation

Base range is over level, open ground, in tiles (euclidean — sight falls off in
a circle, while movement and attack range stay Manhattan).

| Formation | Passive | Recon sweep (R) | Identify factor | Confidence lost per round once sight is lost |
| --- | --- | --- | --- | --- |
| C4I / ISR (Recon) | 9 | 14 | ×1.40 | 10 |
| Frigate | 8 | 11 | ×1.15 | 15 |
| Commando | 7 | 11 | ×1.20 | 16 |
| Corvette | 7 | 9 | ×1.05 | 18 |
| Infantry | 5 | 8 | ×1.00 | 22 |
| Armour | 5 | 7 | ×0.95 | 24 |
| Engineer | 4 | 6 | ×0.85 | 25 |
| Artillery | 3 | 5 | ×0.80 | 26 |

### Situational modifiers

Effective range = base × observer-terrain × target-concealment × elevation,
clamped to ×0.30 … ×2.40.

| Terrain | Seeing FROM it | Hiding IN it |
| --- | --- | --- |
| High ground (hills) | ×1.35 | ×0.90 |
| Open | ×1.15 | ×1.10 |
| Airfield | ×1.10 | ×1.05 |
| Water | ×1.10 | ×1.15 |
| Beach | ×1.05 | ×1.05 |
| Grass | ×1.00 | ×1.00 |
| Port | ×0.95 | ×0.90 |
| Industrial | ×0.60 | ×0.60 |
| Forest | ×0.55 | ×0.55 |
| Urban | ×0.50 | ×0.50 |

Elevation is taken off the generator's continuous `Tile.height` (0…1):
`1 + clamp(observerHeight − targetHeight, −0.35, +0.60) × 1.1 + observerHeight × 0.30`.
Looking down on someone extends the picture, looking up into higher ground
shortens it, and simply being high is worth something on its own. A dug-in
target is a further ×0.85 to conceal.

### Line of sight

Not a radius test. `lineOfSight()` walks the tiles between observer and target
and compares each one's **skyline** — ground height plus what is built or grown
on it (forest +0.055, urban +0.075, industrial +0.05) — against the height of
the straight ray from the observer's eye (their ground +0.03) to the target's
exposure. Anything above the ray closes the line outright. Surviving tiles
accumulate *obscurance* (forest 1.0, urban 1.3, industrial 0.9 each); 3.2 total
blocks, and whatever is below that shortens the usable range by up to half.
Relief is deliberately **not** counted as obscurance — the height profile
already handles it, and double-counting made a unit on a ridge blind along its
own ridge.

Cost, measured over 30 bot-vs-bot games (39,144 one-sided passes, 3.06M
observer/target pairs): an integer bounding box on the observer's best-case
radius rejects **83%** of pairs, the situational euclidean range another
**12%**, so fewer than one pair in twenty reaches the ray. A full one-sided
pass is **~9 µs**; a complete player turn, including every refresh inside it,
averages **0.037 ms**.

### The four detection states

| State | Confidence | Sent over the wire | Drawn as |
| --- | --- | --- | --- |
| Unknown | — | nothing at all | nothing |
| Contact | 1–54 | position + confidence only | hollow dashed blip, "?", grid ref + % |
| Identified | 55–84 | arm + position, everything else redacted | dashed counter, arm glyph, "?" badge, hatched strength bar |
| Confirmed | 85–100 | the real formation | solid counter, "✓" badge, real designation + % |

Each observation supports a **ceiling** derived from proximity within the
observer's envelope, the observer's identify factor, the target's concealment
and the obscurance along the line. First sighting lands at 80% of that ceiling;
each further **round** of observation closes 70% of the remaining gap — at most
once per round, so it is sustained watching that confirms a formation, not the
number of orders you happen to issue. Losing sight decays confidence by the
observer's per-round figure above, walking a Confirmed formation back down to a
stale last-known-position marker and finally deleting it.

Combat reads the rung directly: attacking a Contact costs **−40%** attack
power, an Identified target **−12%**, a Confirmed target nothing.

### Recon vs passive spotting

| | Passive | Recon order (1 AP) |
| --- | --- | --- |
| Range | base | the much longer sweep range |
| Cover | forest/urban shorten and can block | obscurance halved; only relief still blocks |
| Confidence | ceiling from the observation | ceiling **+22**, and 85% of the gap closed at once |
| Tracking | decay at the observer's rate | marks the contact recon-tracked, so decay stays at the sweeping unit's (much slower) rate |
| Ladder | climbs a rung per round | can jump straight to Confirmed |

### Simulation, 30 games MEDIUM vs MEDIUM, same seeds

| | Phase 4a baseline | Phase 4b |
| --- | --- | --- |
| Rounds per game | 12.1 (10–16) | 12.1 (10–15) |
| Win split BLUEFOR / REDFOR | 8 / 22 | 7 / 22 / 1 draw |
| Enemy force with any contact, per turn | 54.3% | **59.9%** |
| Enemy force *actionable* (live / Identified+) | 23.2% | **44.0%** |
| Enemy force at Confirmed | — | 18.2% |
| Distinct contacts per game, both sides | 15.8 | 17.0 |
| Recon orders per game, both sides | 28.1 | 40.0 |

Game length is unchanged and the BLUEFOR/REDFOR split is identical to the
baseline on the same seeds — the skew is a pre-existing map/first-player
artefact, not something this pass introduced. What did change is the quality of
the picture: the share of the enemy force a side can actually *act on* nearly
doubled, because you no longer have to buy sight with an action.

### What was changed and why

| Change | Before | After | Why |
| --- | --- | --- | --- |
| AP per turn | 15 | **26** | Ten formations × 1–3 bounds + a major action is a ~35–40 AP appetite; 26 keeps the budget a real constraint while making a fully-unspent turn very hard. |
| AP carry cap | 25 | **34** | Scaled with the per-turn figure; still low enough to discourage hoarding for an alpha strike. |
| Moving blocks the unit's action | yes | **no** | The single biggest source of "nothing left worth doing". |
| Engineer "Clear Obstacle" | 2 AP | **1 AP** | It was never worth 2; now it is a genuine AP sink. |
| Sight radii | 2–4 | **3–9 (phase 4b), passive** | The map is much larger, and spotting no longer costs an action — see the detection table below. |
| Artillery range | 6 | **8** | Ditto — gun battalions must still matter at map scale. |
| Spotting | costs a Recon action | **passive, continuous, free** | A player should not have to spend AP to notice a battalion standing next to them. |
| Objective count | 8 | **~22** | Fighting develops in several places at once instead of one blob. |
| VP threshold / rounds | 150 / 20 | **200 / 24** | Rebalanced against the new objective count; games resolve in ~12–15 rounds in simulation. |
| VP payout | per player-turn | **once per round, both sides together** | The first player was banking half a round of free scoring every round. |

Measured over automated bot-vs-bot games (`decideBotAction` driving both
seats), formations now take **~1.9 movement actions per unit per turn** and
games resolve in **12–15 rounds** with final scores within a few percent of
each other.

## Naval and logistics rework

- **Naval transports and the amphibious-ferry flow are gone.** The
  `NAVAL_TRANSPORT` formation type, the `AMPHIBIOUS` action, the `canEmbark`
  / `embarkedOn` machinery and the associated UI target-mode were all
  removed. They existed only to shuttle land units and were a micromanagement
  tax that mostly resulted in a ship sitting in a corner doing nothing.
- **Naval forces are now purely combat assets.** Each side fields a frigate
  squadron (Formidable-class flavour; attack range 4) and a littoral combat
  squadron (Victory-class corvette with Independence-class LMV in company;
  attack range 3, faster, 3 movement actions). They engage coastal targets by
  standoff fire — a standoff engagement damages but never occupies ground —
  and they contest the three open-sea **Anchorage** objectives, which only
  warships can hold.
- **Logistics units are gone.** The `LOGISTICS` formation type was removed
  along with supply-convoy positioning. Supply and readiness survive as
  combat/movement **modifiers** and the Resupply action remains, but supply
  range is now purely positional (14 tiles from a depot or a held
  Port/Airfield/Depot objective). Warships resupply themselves.
- The bot (`server/bot.ts`) was updated in step: it no longer reasons about
  removed systems, sails its warships toward maritime objectives and coastal
  targets, uses per-type attack ranges, and — at Medium and Hard — spends its
  formations' **full movement allowance** (Easy deliberately uses only one
  bound per unit per round). It also relaxes its "is this worth doing"
  threshold as unspent AP piles up, so it stops ending turns on a full wallet.

## Map generation

`src/game/mapgen.ts` builds a 72×72 sheet the way a landscape is built,
rather than by scattering terrain tiles:

1. **Heightfield.** Hand-rolled seeded value-noise fBm (6 octaves, with a
   domain warp and a ridged component) over a mulberry32 PRNG — no new
   dependencies. A south-east sea mask opens the map onto one ocean.
2. **Coastline.** Sea level is a percentile of the heightfield, and the sea
   itself is the below-sea-level region *connected to the map border* — so
   inland basins are simply low ground, never stray lakes.
3. **Hydrology.** Priority-flood depression filling guarantees every land cell
   drains to salt water; D8 flow routing plus flow accumulation then produces
   a dendritic river network with real confluences. Diagonal flow steps have
   their elbow filled so channels are orthogonally continuous (this is what
   keeps rivers from degenerating into disconnected blue speckle), and only
   the largest trunks are widened.
4. **Terrain.** Elevation bands are *quantiles* of the land heights (so high
   ground stays on genuine ridges), and a second noise field plus
   distance-to-water gives moisture. Forest/grass/open/hills fall out of
   (elevation, moisture, slope), producing large continuous stands. Beaches
   are low land on the open sea. A three-pass majority filter removes any
   isolated single-tile speckle.
5. **Settlements.** Sites are scored on flatness, proximity to fresh water or
   coast, and spacing, then grown as blobs; the seaward fringe of coastal
   settlements becomes industrial ground.
6. **Roads.** A minimum spanning tree over settlements, ports, airfields and
   depots, with each edge routed by **A\* over a terrain-and-slope cost
   field** — roads therefore prefer low slope, follow valleys, bundle into
   shared corridors, and cross rivers only where a **bridge** is laid.
7. **Objectives.** Urban districts at settlement centres, ports at berths,
   airfields on flat inland ground, the four largest river crossings, the
   three dominant peaks, both depots, and three sea anchorages placed
   deliberately *balanced* — one nearer each side's naval spawn plus one
   contested middle — so neither side gets the maritime VP for free.

### Validation — a broken map can never reach a room

`generateBattlefield()` generates, **validates, and retries** (up to 24
attempts on decorrelated seeds) before returning; if it cannot produce a valid
map it throws rather than serving a broken one. `validateMap()` asserts:

- all water forms **one** body, and every naval spawn, every maritime
  objective and every port berth is on it (ships can never be stranded);
- every land objective and every deployment tile is on one land component,
  reachable across bridges;
- no orphan river tiles (rivers are continuous);
- no isolated single-tile terrain speckle above a tiny tolerance;
- the road network reaches every settlement, port and depot.

Generation additionally repairs before it rejects: isolated pools are
converted to land, and if two objective-bearing land components are separated
by a river it bridges the crossing that joins them.

Run the soak test yourself:

```bash
npm run mapcheck        # 60 seeds by default
npm run mapcheck -- 200 # more
```

It re-derives the naval-reachability claim independently (sailing from
BLUEFOR's first ship) rather than trusting the generator, and reports a pass
rate plus terrain statistics.

### Wire size

The tile grid is 5,184 tiles (~355 KB of JSON) and changes only when an
engineer throws a bridge, so `road` / `river` / `bridge` / `navigable` are
only serialised when true, the per-tile render noise is derived from a hash of
`(x, y)` in the renderer instead of being carried on the wire, and the server
**elides the grid entirely** from routine `state` pushes (`WireGameState` in
`src/net/protocol.ts`); the client reuses the grid it received at `start`.
A routine per-action broadcast is **7 KB** instead of ~440 KB.

## Design choices / documented deviations

- **AP rollover cap:** leftover AP carries over uncapped in the brief's base
  rule; this prototype caps the carry at 34 (`AP_CAP`) to avoid runaway
  hoarding turning into a first-turn alpha strike, while still rewarding a
  quiet turn with a stronger follow-up.
- **Movement:** flat 1 AP per Move action regardless of distance travelled
  within range, per the brief; the *range* itself is computed from
  unit-type move points, terrain cost, roads, elevation change, and a
  readiness/supply penalty. The number of Move actions a formation may take
  in a round is capped separately (`MOBILITY`) — see "Movement actions
  and the AP economy".
- **Combat resolution on capture:** a "Position Captured" outcome removes
  the defending formation from the board (retreat is not separately
  modeled) and the attacker occupies the tile — a simplification called out
  here rather than left implicit.
- **Standoff fire never takes ground.** Only a range-1 assault by a ground
  formation can produce a "Position Captured" outcome; an artillery fire
  mission or a naval engagement at range damages and can destroy, but the
  firing unit does not advance onto the tile.
- **Maritime objectives are naval-only, land objectives ground-only.** A
  frigate cannot "hold" a bridge and an infantry battalion cannot hold an
  open-sea anchorage.
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

## Phase-2 UI/UX pass (presentation)

Phase 2 was scoped to UI/UX and presentation only — no engine, multiplayer,
bot or mapgen redesign. What it changed:

**Identity.** The product is **COMMAND**, tagline *"Lead the force. Shape the
battlefield."* Every prior operation/product name has been removed from the
page title, lobby, HUD and end-game screen.

**Action system.** `src/game/actions.ts` describes each order once — label,
shortcut, AP cost, target mode, beginner blurb, and a per-formation
`enabled` / `reason` verdict. Selecting a formation immediately shows every
order it could take as a button with the shortcut on its face; orders it
cannot take right now are visibly disabled and say why on hover ("No visible
enemy within attack range (1 tiles)", "Out of supply range — move closer to a
depot or a held port/airfield", "Not enough AP — needs 3, you have 2").

| Key | Order | | Key | Action |
|-----|-------|-|-----|--------|
| `M` | Move | | `E` | End turn (warns if AP and orders remain) |
| `A` | Attack | | `Tab` | Next formation with orders left |
| `R` | Recon | | `Z` / `Space` | Centre the camera on the selected unit |
| `F` | Fortify | | `Esc` | Cancel targeting / close panel / deselect |
| `S` | Resupply | | `L` | Map legend |
| `G` | Fire mission (artillery) | | `?` or `H` | Field manual (help) |
| `C` | Close air support | | `↑ ↓ ← →` | Pan |
| `B` | Build bridge (engineer) | | `+` / `−` | Zoom |
| `O` | Clear obstacle (engineer) | | | |
| `X` | Special op (commando) | | | |

Shortcuts are suppressed whenever the keystroke targets an `INPUT`,
`TEXTAREA`, `SELECT` or a `contenteditable` element, so typing a room code
never fires an order.

**Layout.** The battlefield is now the page: `MapCanvas` fills the viewport and
every panel floats over it as a compact translucent card (HUD strip, tool
chips, collapsible roster, selected-unit card, order bar, end-turn button).
The old fixed 260 px left and right columns and the top/bottom bars are gone,
which returns roughly 520 px of horizontal chrome to the map.

**Camera.** Drag to pan, wheel to zoom about the cursor, eased camera motion on
every recentre, and a fit-to-viewport zoom floor so zooming out can no longer
shrink the sheet into a small square.

**Cartography.** The terrain pass no longer fills one rectangle per tile. The
visible window is rasterised into a small offscreen image (an adaptive 2–6
pixels per tile, budgeted so cost is roughly constant across zoom levels) and
blitted up with smoothing, so terrain colour, hypsometric tint, the wet fringe
at the shore and the hillshade are all bilinearly interpolated and no tile
boundary survives as a hard edge. Contours and the coastline are drawn with
marching squares over a corner-height field — real curves that cut diagonally
through tiles, with an index contour every fifth interval — instead of stepped
tile-edge segments. Rivers and roads are drawn as cased lines, the per-tile
grid only whispers in above 15 px/tile, a 10-tile graticule replaces it below
that, settlement names are lettered onto the sheet from round 6 px/tile, and
off-sheet space is drawn as open sea inside a framed map edge.

**Map legibility (phase 3).** A pass whose only goal was to make units,
objectives and overlays the most legible things on screen, without flattening
the topographic character:

- **The river fringe is gone.** Narrow watercourses are now lifted *out* of the
  smoothed water mask entirely (`terrainFields` marks a river tile with four or
  fewer water neighbours as a `channel`, zeroes its water value and paints it
  with the mean colour of its own banks), so the isotropic blur has no blue to
  smear. Rivers are then drawn purely as cased lines that bend round each tile
  centre with a quadratic curve, so a watercourse meanders instead of climbing
  a staircase of right angles. Estuaries and broad lower reaches keep enough
  water neighbours to stay real water, with a coastline and a depth ramp.
- **Built-up areas are blocks and streets, not a stamped grid.** Each urban or
  industrial tile is one city block: the streets are the block boundaries (so
  they run continuously across a whole settlement and line up with the road
  network), every fourth world line is a wider avenue, and each block's
  interior is split into varied building footprints by a deterministic binary
  subdivision, with a share of blocks left open as yards.
- **Contour labels and spot heights.** Index contours carry a height figure at
  ≥14 px/tile, placed on a coarse lattice and rotated along the line with a
  pale halo standing in for the cartographer's break; the dominant summits
  carry a spot dot and figure at ≥13 px/tile.
- **Less noise, more contrast where it counts.** Per-tile colour jitter halved,
  forest stipple cut to two low-contrast crowns, hillshade softened, minor
  contours faded in from 9 px/tile. Every counter, objective, contact and the
  selection ring now gets a dark casing ring, and the movement wash strokes
  only the *outer boundary* of the reachable set instead of outlining every
  tile in it — that amber grid was the noisiest thing on the old sheet.

**Legend (`L`).** Collapsible pop-up covering terrain (including **beach**) and
markers (including **anchorage**, movement range, attack range, unknown
contact, fortified). Every entry carries both a colour swatch and a symbol.

**Front page (phase 3).** The lobby was rebuilt as a game front page rather
than a stack of form panels: a full-bleed hero, an oversized COMMAND wordmark
with the tagline, then a deliberate menu hierarchy — a primary *Play vs Bot*
row with Easy/Medium/Hard, a multiplayer block (Create Room / Quick Match /
join-by-code), and Tutorial and Field Manual as secondary text entries. The
hero is a **real generated battlefield**: `HeroBackdrop` calls the game's own
`initGame()` and `render()` once, off the first paint (via
`requestIdleCallback`), into a single over-sized canvas that is then darkened,
desaturated and blurred in CSS and drifted by a compositor-only transform
animation — there is no game loop and no per-frame JavaScript. It is skipped on
obviously low-powered devices, honours `prefers-reduced-motion`, and anything
that throws simply leaves the CSS gradient underneath showing, which the page
is designed to look finished without. The room-code, quick-match and
connecting states are designed cards in the same column, and a lobby-phase
server error (bad room code, room full) now returns to the menu with the reason
instead of leaving the connecting card spinning.

**Tutorial.** Reached from the landing page. Seven illustrated sections — the
basic loop, movement, attack, recon (stated plainly as *gathering information
about enemy forces*), fortify, combined arms, and objectives/VP — each with an
SVG battlefield diagram drawn in the game's own palette.

**Help (`?`).** Short, jargon-light entries for Infantry, Armour, Commandos,
Artillery, Engineers, Recon, Air support, Naval units, Terrain, Combat, AP,
Movement actions, Objectives and fog of war, plus a shortcut reference.

**Momentum.** The roster shows a movement pip per remaining movement action and
a star for an unspent major action, counts how many formations are still
"ready", dims spent ones, and `Tab` jumps to the next one. End Turn warns
(never blocks) while AP and orders remain.

**Combat readability.** The battle report is a corner card rather than a
full-screen modal, so the engaged tiles stay visible and are flashed on the
map. It leads with one plain sentence explaining *why* the result went that
way, built from the decisive factors (each now tagged attacker/defender in the
report), then the four factors that mattered, with the full list one click
away.

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

## Testing performed

### Phase-3 refinement pass (front page, 72×72 board, map legibility)

- `npm run build` (client `tsc -b` + Vite) and `npx tsc -p
  server/tsconfig.json --noEmit` — both clean.
- **Map soak at the new size** (`npm run mapcheck -- 120`): 120 independent
  seeds on the 72×72 grid, **120/120 pass (100%)** — water connectivity, river
  continuity, road-network connectivity, land reachability and the independent
  "sail from BLUEFOR's first ship to every spawn, berth and anchorage"
  re-derivation all hold. Typical map: ~1,927 water tiles (all one navigable
  body), ~222 river tiles, ~239 road tiles, ~14 bridges, ~994 forest tiles,
  20 objectives; 1.1 attempts and ~45 ms per map (was ~75 ms at 80×80).
- **Bot-vs-bot balance sim** over the real engine + real `decideBotAction`:
  - MEDIUM vs MEDIUM, 30 games: **13.1 rounds** average (8–19), BLUEFOR 14 /
    REDFOR 14 / 2 draws, average final VP difference **+4.6** to BLUEFOR.
  - HARD vs HARD, 24 games: **12.6 rounds** average (8–15), BLUEFOR 11 /
    REDFOR 12 / 1 draw, average VP difference −4.5.
  - First contact (any two opposing formations within 3 tiles) now happens on
    **round 5.1** on average, against **round 6.0** for the same code at
    80×80 — the size cut does exactly what it was meant to do.
- **Retuning that the size change required, and nothing else:** settlements
  6 → 5 (objectives 22 → ~20, so objective *density* is unchanged),
  named bridge crossings 4 → 3, and the minimum spacings for settlements,
  bridges, hills, airfields, depots and deployment rings scaled with the
  board. Artillery range 8 → 7 tiles and supply radius 16 → 14 tiles keep
  those reaches the same fraction of the battlefield they were tuned against.
  Deployment separation is derived from N, so it scaled on its own.
- **Live app driven with Playwright/Chromium** against the combined server
  (`npm start`, 1600×950):
  - the landing page renders with the hero battlefield behind it
    (`.hero-canvas.is-ready` present), the COMMAND wordmark and the tagline;
  - **Create Room** shows a five-character code (`PCWZW`) in the designed
    room-code card; **Quick Match** shows the searching card; joining `ZZZZZ`
    returns to the menu with "No room with that code." instead of spinning on
    the connecting card forever (a real bug this pass fixed);
  - at 720×900 the page reflows to a single column with **no horizontal
    overflow** (`scrollWidth === clientWidth === 720`);
  - **Play vs Bot → Medium** starts a game on a 72×72 map with 20 objectives;
    a formation selects from the roster, `M` arms MOVE, `Esc` cancels, `Tab`
    cycles to the next formation with orders (`f_21 → f_22`), `L` opens the
    legend, `H` the field manual, arrow keys pan (9,30 → 15,36), and a real
    server-validated MOVE lands the unit at its target with `movesUsed = 1`;
  - **14 rounds** of HARD bot play with scripted advances (every ready
    formation ordered toward a contested objective each turn) produced **no
    page or console errors** and the bot scored 158 VP off objectives.
  - Honest caveat: no two formations ever came within one tile in that run, so
    the `A` → ATTACK arming was only observed *refusing* (correctly, with a
    "cannot perform Attack" toast, since nothing was in range). The attack
    path itself is unchanged this pass and is exercised heavily by the 54
    bot-vs-bot simulation games above, which resolve combat through the same
    `attackAction`.
- **Render frame time re-measured** the same way as phase 2 (smoothed, full
  redraw every animation frame, 1600×950), against the phase-2 baseline of
  4.5–9.0 ms: **7.6 ms** at 7 px/tile, **7.5 ms** at 13, **6.7 ms** at 24 and
  **6.4 ms** at 34 — flat across zoom and slightly *better* at the worst
  point, even though the relief raster budget was raised (46k → 62k subpixels)
  to sharpen close zooms.

### Phase-2 UI/UX pass (identity, actions, layout, cartography)

- `npm run build` and `npx tsc -p server/tsconfig.json --noEmit` — both clean.
- Driven end-to-end with Playwright/chromium against the combined server
  (`npm start`, 1600×950 viewport): landing page shows the COMMAND identity
  and tagline; the tutorial opens and all seven sections render with their
  diagrams; a vs-Bot game starts; selecting a formation immediately shows its
  order buttons with shortcut labels and correct disabled states; `M` + tile
  click moves (movement actions 0→1, AP 26→25); `A` arms attack targeting and
  clicking a ringed enemy produces a battle report with the plain-language
  explanation; `R` performs a recon sweep; `Esc` cancels a pending mode; `L`
  toggles the legend (27 entries); `?` opens the field manual; `Tab` selects a
  formation with orders remaining; End Turn warns while AP remains.
- **Shortcut suppression:** typing `MARFES` into the room-code input leaves the
  field reading `MARFE` (its 5-character cap) and fires no order, opens no
  panel and starts no tutorial.
- **Render frame time** (smoothed, same 1600×950 viewport), against the
  phase-1 baseline of 16–23 ms worst case: **4.5 ms** at the fit-to-viewport
  floor (≈11 px/tile), **8.3 ms** at 11, **9.0 ms** at 16, **8.0 ms** at 22 and
  **8.4 ms** at 30 px/tile — roughly a 2–3× improvement, because the terrain
  pass is now one budgeted raster plus a blit instead of thousands of per-tile
  fills and strokes.

### Phase-1 refinement pass (naming, movement/AP, naval & logistics, mapgen)

- `npm run build` (client `tsc -b` + Vite) and `npx tsc -p
  server/tsconfig.json --noEmit` — both clean.
- **Map soak test** (`npm run mapcheck -- 80`): 80 independent seeds, **80/80
  pass (100%)**. Each map is checked by `validateMap()` *and* by an
  independent re-derivation in the script that sails from BLUEFOR's first ship
  and asserts it can reach every naval spawn, every port berth and every
  anchorage. Typical map: ~2,390 water tiles (all one navigable body), ~280
  river tiles, ~280 road tiles, ~15 bridge tiles, ~1,200 forest tiles, 22
  objectives; ~1.2 generation attempts and ~75 ms per map.
- **Headless bot-vs-bot simulation** over the real engine + real
  `decideBotAction`: games resolve in 12–15 rounds with final scores within a
  few percent, formations take ~1.9 movement actions per unit per turn, and
  neither side wins systematically.
- **Live app driven with Playwright/Chromium** against the combined server
  (`npm start`), vs-Bot on Medium:
  - a game starts on an 80×80 map with 22 objectives and the correct ten
    named formations per side (1 SIR / 2 SIR / 5 SIR / 1 CDO BN / 40 SAR /
    21 SA / 35 SCE / 24 C4I / 185 SQN / 188 SQN);
  - **1 SIR performed a 2nd movement action in the same round and was then
    blocked from a 3rd** — after two bounds `computeReachable` returns zero
    tiles and the move is rejected server-side;
  - **185 SQN (frigate) sailed twice across open water** (13,66 → 18,68 →
    25,68) with 43 and then 75 reachable water tiles — no stranding;
  - the bot played four consecutive turns with no client or server errors,
    used its full 3/3 movement allowance on 9 REB, and captured both land and
    maritime objectives (Bridge 4, Sungei Lanjut District, Anchorage B).
- **Render cost measured in-browser** at the new size, forcing a full React +
  canvas redraw every animation frame (a worst case; normal play redraws only
  on interaction): 16–23 ms per frame across 4, 5, 9, 16 and 24 px/tile —
  roughly 45–60 fps at every zoom level. Batching the contour lines into two
  `Path2D` strokes per frame and raising the sprite-detail threshold took the
  worst zoom level from 36 ms to 20 ms.
- **Wire size measured**: full `start` payload 444 KB (once), routine
  per-action `state` push **7.2 KB**.

### Earlier multiplayer pass

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
