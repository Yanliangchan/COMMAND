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
  `SABRE`/`VANGUARD` assigned **randomly** per room (not "creator is always
  SABRE") — the server flips a coin once per room in `makeSeats()`.
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
    true designation, strength, morale, ammunition, readiness, dug-in state,
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
- **Faction colors** (Sabre/Vanguard on the map and in chips) were nudged
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
   two depot objectives, an A*-routed road network with bridges at the river
   crossings, and ~22 capture objectives spread across the map (urban
   districts, ports, airfields, bridges, hills, depots and three open-sea
   anchorages). Generated **once, server-side**, when a room is created, and
   **validated before it is served** (see "Map generation" below).
2. Pan (drag) and zoom (scroll wheel, continuous 3.5×–28× covering
   strategic/operational/tactical framing) camera over the canvas.
3. **Twelve formations per side** (phase 9 — up from eleven in phase 8, ten in
   phase 5): Infantry ×3, one elite manoeuvre battalion — Commandos for Sabre,
   Guards for Vanguard — two Armoured battalions, Artillery, Combat Engineers,
   **two** C4I/ISR battalions, and two RSN squadrons: one surface-combatant,
   one littoral. Each formation carries strength/morale/readiness/suppression
   stats that all affect combat power or movement (plus an ammunition count on
   the guns and the ships), a **per-round movement-action allowance** (see
   "Movement actions and the AP economy"), a **prepared-defence tier** while
   dug in, and a per-game **vertical-insertion charge count** for the two
   elite manoeuvre battalions (see "Phase 9" below for both).
4. 30 AP/turn (rollover, capped at 38 — see "Movement actions and the AP
   economy" for how this number was arrived at across three roster changes),
   with the documented per-action AP costs. Move, Attack, Recon, Fortify,
   Artillery fire mission, Air strike call-in, Engineer bridge/clear, Special
   Op, Reorganize, Vertical Insertion and UAV Recon are all implemented,
   validated and applied server-side.
5. Click a formation → see its movement range (Dijkstra over terrain cost;
   roads halve cost, climbing a band of elevation costs extra, rivers block
   land units unless bridged, ships are confined to the validated navigable
   water body). Click a reachable tile to send a `MOVE` action for 1 AP —
   and do it again, up to that formation's movement allowance for the round.
6. Click "Attack", then hover an in-range enemy: the **pre-attack odds
   preview** (phase 6) shows the predicted outcome, the strength both sides
   expect to lose, your share of the combat power and every factor for and
   against, before a single AP is spent. Click to send the `ATTACK` action.
   The engagement resolves on the server through the same pure module
   (`src/game/combat.ts`) the preview called — base attack/defence × strength
   × readiness × morale × the arm-vs-arm matchup × terrain × fortification ×
   combined-arms support, one bounded ±12% roll, losses split in proportion to
   each side's share of the combat power. Produces a battle report on **both**
   clients that reads as the preview resolved: same share bar, same factor
   list, same numbers with the roll filled in.
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
   only by warships. Objectives on the **axis of advance** are worth two to
   three times a rear-area objective (see "Map design for engagement"). Each
   side is paid once per **round**, at the end of the OTHER side's turn, for
   what it is *still* holding then — so an objective has to be held through the
   enemy's reply to score, and neither side ever gets the last word on its own
   payout (see "Side balance"). Victory is only adjudicated at a round
   boundary. First to 280 VP (or the higher score after 24 rounds) wins, with
   an end-game screen driven by server-pushed `phase: 'GAME_OVER'`.
9. **There is no supply system** (removed in phase 6 — see "Combat model").
   Depots, ports and airfields are objectives worth VP and nothing more; no
   radius, no isolation penalty, no Resupply order. The one job supply did
   that was worth keeping — stopping the guns and the ships firing every turn
   forever — is done by a visible **ammunition count** on artillery and naval
   formations only: 4 / 4 / 3 ready rounds, one spent per fire mission, one
   regained at the end of any round the formation held its fire. Readiness
   survives supply's removal and now measures only a formation's own state:
   it falls when it fights and recovers when it does not.
10. Real two-client multiplayer via room code or Quick Match (see
    "Multiplayer design" above) — no pass-and-play, no shared browser tab.
11. **Overwatch / reaction fire, Zones of Control and suppression** (phase 7 —
    shipped then, documented here now; see "Phase 7 mechanics" below for the
    full writeup). A formation that ends its turn without spending its major
    action goes on alert and fires one reduced-power reaction shot at an enemy
    that moves into its range and line of sight during the opponent's turn.
    Every land formation except artillery projects a Zone of Control into its
    four adjacent tiles; moving through one (not onto one) stops a bound
    there, and disengaging from one costs a full movement action's worth of
    points. Suppression (0-100, separate from strength/morale) cuts a
    suppressed formation's own attack power and movement, decaying faster in
    cover, never causing casualties by itself.
12. **Reorganize** (phase 7, buffed phase 9 — see "Phase 9" below): stand a
    formation down for the round (2 AP, no prior movement, 3-round cooldown)
    to restore readiness +38 / morale +20 / strength +12. Two adjacent
    friendly formations that both Reorganize the same round get an extra
    mutual bonus.
13. **Vertical / heli insertion, prepared-defence tiers, an exploitation
    bonus and capped UAV recon** (all phase 9 — see "Phase 9" below for the
    full writeup of each).
14. **Match replay**: after `GAME_OVER`, either player can scrub back through
    the operation round by round from the end-game screen — positions,
    objective markers and the operations log for that round (phase 9).

## Real-World Reference vs. Fictional Game Mechanics

Per the design brief, this prototype does **not** reproduce any real SAF
organisational structure, unit counts, order of battle, or
classified/sensitive information.

### The scenario: a force-on-force exercise

COMMAND is framed as a **large-scale SAF force-on-force exercise** —
*Exercise Sabre Vanguard* — fought between two task forces drawn from the same
armed forces over a fictional training area. That framing is deliberate: it is
what makes it coherent for **both** sides to be genuine SAF formations, and it
avoids depicting Singapore fighting an invented enemy. The phase 1–4
placeholder faction naming — a blue force versus a wholly invented opposing
force with made-up battalion designations — has been retired entirely, names
and all.

The two sides are `TASK FORCE SABRE` and `TASK FORCE VANGUARD` (`PlayerId` in
`src/game/types.ts` is now `'SABRE' | 'VANGUARD'`). The existing side colours (steel blue vs
muted rust), counters, markers and legend all still work — only the NAMES were
retired. The legend is now viewer-aware, so it labels the blue swatch
`Friendly formation (TF SABRE)` or `(TF VANGUARD)` depending on which seat you
hold, rather than asserting that blue always means friendly.

### Orders of battle

| TASK FORCE SABRE | Designation | Echelon | Arm |
| --- | --- | --- | --- |
| 1st Battalion, Singapore Infantry Regiment | 1 SIR | Battalion | Infantry |
| 2nd Battalion, Singapore Infantry Regiment | 2 SIR | Battalion | Infantry |
| 5th Battalion, Singapore Infantry Regiment | 5 SIR | Battalion | Infantry |
| 1st Commando Battalion | 1 CDO BN | Battalion | Commandos |
| 40th Battalion, Singapore Armoured Regiment | 40 SAR | Battalion | Armour |
| 48th Battalion, Singapore Armoured Regiment | 48 SAR | Battalion | Armour |
| 21st Battalion, Singapore Artillery | 21 SA | Battalion | Artillery |
| 35th Battalion, Singapore Combat Engineers | 35 SCE | Battalion | Combat Engineers |
| 10th Command, Control, Communications, Computers and Intelligence Battalion | 10 C4I Bn | Battalion | C4I / Signals & ISR |
| 12th Command, Control, Communications, Computers and Intelligence Battalion | 12 C4I Bn | Battalion | C4I / Signals & ISR |
| 185 Squadron, Republic of Singapore Navy | 185 SQN | Squadron | RSN |
| 188 Squadron, Republic of Singapore Navy | 188 SQN | Squadron | RSN |

| TASK FORCE VANGUARD | Designation | Echelon | Arm |
| --- | --- | --- | --- |
| 3rd Battalion, Singapore Infantry Regiment | 3 SIR | Battalion | Infantry |
| 8th Battalion, Singapore Infantry Regiment | 8 SIR | Battalion | Infantry |
| 9th Battalion, Singapore Infantry Regiment | 9 SIR | Battalion | Infantry |
| 1st Battalion, Singapore Guards | 1 GDS | Battalion | Guards |
| 41st Battalion, Singapore Armoured Regiment | 41 SAR | Battalion | Armour |
| 42nd Battalion, Singapore Armoured Regiment | 42 SAR | Battalion | Armour |
| 20th Battalion, Singapore Artillery | 20 SA | Battalion | Artillery |
| 30th Battalion, Singapore Combat Engineers | 30 SCE | Battalion | Combat Engineers |
| 11th Command, Control, Communications, Computers and Intelligence Battalion | 11 C4I Bn | Battalion | C4I / Signals & ISR |
| 16th Command, Control, Communications, Computers and Intelligence Battalion | 16 C4I Bn | Battalion | C4I / Signals & ISR |
| 191 Squadron, Republic of Singapore Navy | 191 SQN | Squadron | RSN |
| 189 Squadron, Republic of Singapore Navy | 189 SQN | Squadron | RSN |

The two ORBATs are deliberately **equivalent in weight**: three rifle
battalions, one elite manoeuvre battalion, two armoured battalions, one
artillery battalion, one combat-engineer battalion, **two** C4I battalions and
two RSN squadrons each — **twelve** formations a side (phase 9).

**Phase 8** added the second armoured battalion to each side: 48 SAR to SABRE
and 42 SAR to VANGUARD. Both are real, publicly documented SAF armour
battalions (the SAF fields four active armour battalions — 40, 41, 42 and
48 SAR — so all four now appear in the game, two per task force), verified by
search before being added; see "Formation naming — what was checked" below.
Which of the two goes to which task force, like every other ORBAT slotting
here, is a fictional exercise arrangement. Adding an eleventh formation a side
meant re-checking everything that assumed exactly ten: the AP budget, the
deployment-zone capacity on the 72×72 map, and the side-balance simulation —
see "Movement actions and the AP economy" and the balance-sim notes below.

**Phase 9** added a second C4I battalion to each side: **12 C4I Bn** to SABRE
and **16 C4I Bn** to VANGUARD, bringing both sides to twelve formations. Both
designations are real, publicly documented SAF C4I battalions, distinct from
10/11 C4I Bn already in the roster — 12 C4I Bn is referenced in connection
with HQ 4 SAB, and 16 C4I Bn appears by name in MINDEF's *Exercise Wallaby
2024* fact sheet as a supporting unit; both also appear in Singapore Armed
Forces Best Unit Competition records (alongside 10 and 17 C4I). Verified by
search before being added, the same way 42/48 SAR were in phase 8; see
"Formation naming — what was checked" below. As with every other ORBAT
slotting in this document, which battalion goes to which task force is a
fictional exercise arrangement, not a claim about a real grouping. Adding a
twelfth formation a side meant re-checking, once again, everything that
assumed a fixed roster size: the AP budget, the deployment-zone capacity on
the 72×72 map, and the side-balance simulation, run with the SAME
paired-comparison methodology phase 8 used — see "Movement actions and the AP
economy" and "Side balance re-verified at twelve formations a side (phase 9)"
below.

### Formation naming — what was checked

- The **convention** is `<ordinal> Battalion, <Regiment/Corps name>`,
  abbreviated `<number> <initials>` — e.g. "40th Battalion, Singapore Armoured
  Regiment (40 SAR)". Note the corps names differ in form: it is the
  Singapore Infantry **Regiment** and the Singapore Armoured **Regiment**, but
  the **Singapore Artillery** and the **Singapore Combat Engineers** (so the
  correct form is "21st Battalion, Singapore Artillery / 21 SA", *not*
  "21st Battalions Singapore Artillery Regiment"). This distinction was
  established in phase 1 and is unchanged.
- The Commandos use a **battalion** designation ("1st Commando Battalion",
  1 CDO BN), not a company or squadron one.
- The **Guards** are a Singapore Army formation specialising in air-assault,
  expeditionary and amphibious operations; guardsmen are publicly described as
  proficient in heliborne and underslung operations, hover-jumping,
  heli-rappelling and fast-roping, working with Light Strike Vehicles.
  **1st Battalion Singapore Guards (1 Guards)** is publicly documented as
  having been raised from the SAF Guards Unit in 1977. That real character —
  elite, highly mobile, heliborne infantry — is what the in-game `GUARDS`
  formation type models.
- The intelligence/recon formations are **C4I battalions**; the SAF publicly
  formed C4I battalions out of earlier Signal battalions. **10 C4I Bn** was
  named explicitly in the brief and replaces the fictional "24 C4I" used in
  phases 1–4. **11 C4I Bn** follows the same convention on the other side.
  **12 C4I Bn** and **16 C4I Bn** (phase 9) are two further real, publicly
  documented C4I battalions, added as each side's second C4I formation —
  distinct unit numbers from 10/11 C4I Bn, not a renumbering of them.
- The RSN organises ships into numbered **squadrons**, not battalions. The
  squadron numbers used here are all publicly attested:
  - **185 SQN** — Formidable-class frigates.
  - **188 SQN** — Victory-class corvettes / multi-role combat vessels.
  - **191 SQN** — Endurance-class landing platform docks (3rd Flotilla). Its
    real role is amphibious, **not** air defence; the game slots it as
    VANGUARD's heavy surface group because it is the comparable-weight
    major-surface-combatant squadron. That slotting is an exercise
    arrangement, not a claim about the squadron's task.
  - **189 SQN** — Fearless-class patrol vessels, publicly described as armed
    for anti-submarine work. It fills VANGUARD's littoral slot opposite
    188 SQN.
  No squadron number here was invented.
- **42 SAR** and **48 SAR** (phase 8) are both real, publicly documented
  active battalions of the Singapore Armoured Regiment, alongside 40 and
  41 SAR already in the roster — the SAF names four active armour battalions
  in total (40th, 41st, 42nd and 48th), so this roster now fields all four,
  two per task force. 42 SAR (formed 1971, Sungei Gedong Camp) is an
  armoured-infantry battalion; 48 SAR (formed 2008) is a tank battalion
  fielding the Leopard 2SG, matching the equipment flavour already used for
  40/41 SAR. Checked by web search against public sources before being added.

> **Which battalion or squadron is assigned to which exercise task force is a
> FICTIONAL gameplay arrangement**, as are all stats, costs, AP values, VP
> values and morale numbers. The exercise ORBAT above is **not** a real SAF
> organisation and must not be read as one. Only the formation names, their
> designations, their arm of service and the general character of each arm are
> drawn from public sources.

### The two elite manoeuvre battalions

Each task force fields exactly one. They are **differently flavoured but
comparably strong**, and neither is a strict upgrade of the other:

| | 1 CDO BN (`COMMANDO`) | 1 GDS (`GUARDS`) |
| --- | --- | --- |
| Attack / Defence | 7 / 4 | 7 / 6 |
| Movement | 6 pts × 3 bounds | 6 pts × 3 bounds |
| Passive / recon sight | 7 / 11 tiles | 5 / 8 tiles |
| Identify factor | 1.20 (best on the board) | 1.00 |
| Special Op reach | 6 tiles | 4 tiles |
| Vertical insertion reach / uses (phase 9) | 14 tiles × 2 per game | 14 tiles × 2 per game |
| Character | raiding and deep reconnaissance; fragile in a stand-up fight | air-assault infantry that fights as formed infantry once on the ground |

Both battalions can also mount a **Vertical Insertion** (phase 9, `I`, 4 AP) —
redeploy up to 14 tiles in one leap, landing anywhere that is not adjacent to
a formation this side has actually detected, bypassing normal movement range,
road bonuses and Zones of Control entirely. It flavours the Commandos'
insertion-behind-lines role and the Guards' real air-assault/heliborne
character (their equipment line already reads "heli-rappelling and
fast-roping"). Capped at 2 uses per formation for the whole operation — see
"Phase 9" below for the full mechanic writeup and why that cap.

### Equipment flavour

- **Real-world reference (flavour only):** platform names — SAR 21, Terrex
  ICV, Bronco, SPIKE-LR ATGM, Leopard 2SG, Hunter AFV, Bionix, SSPH Primus,
  SLWH Pegasus, FH2000, HIMARS, F-15SG, F-16, Heron 1, Hermes 450,
  Formidable-class frigate, Victory-class corvette, Independence-class LMV —
  appear only as descriptive flavour text on formations
  (`ORDERS_OF_BATTLE` in `src/game/data.ts`). They do not imply any real
  organisational structure, unit strength, or capability figure, and no
  platform is attributed to any real unit.
- **Fictional, game-balance data:** every number that affects gameplay —
  base attack/defense, movement range, movement-action allowance,
  attack range, sight/recon radius, AP costs, VP thresholds, morale
  multipliers, terrain cost/defense bonuses, the arm-vs-arm matchup table,
  ammunition counts, combat roll bounds — is an invented design choice for a playable prototype, not real
  SAF data. These live in `src/game/data.ts`, `src/game/types.ts`
  (`AP_COSTS`, `AP_PER_TURN`, `MOBILITY`, `MORALE_BASELINE`, `VP_WIN_THRESHOLD`, …) and
  `src/game/engine.ts`.
- The map is a **fictional generated landmass**. It is not Singapore and does
  not depict any real terrain, base, installation or coastline.

## Movement actions and the AP economy

The old build gave every formation exactly one "major action" a round, which
made manoeuvre glacial and left players ending turns with unspent AP. That is
replaced by a **two-budget** model:

- **A global AP pool** — 30 AP per turn (26 through phase 7; bumped +2 in
  phase 8 to absorb the eleventh formation's action appetite, then +2 again
  in phase 9 for the twelfth — see the comment on `AP_PER_TURN` in
  `src/game/types.ts`), rolling over up to a 38 AP cap. Each roster bump used
  the same reasoning: keep the pool slightly *under* the new roster's
  appetite so choices still matter, verified against the paired side-balance
  sim each time rather than assumed (see "Side balance re-verified at twelve
  formations a side (phase 9)" below). Action costs: Move 1, Attack 2,
  Recon 1, Fortify 1, Artillery 2, Engineer bridge 2 / clear 1, Special Op 3,
  Air strike 3, Reorganize 2, **Vertical Insertion 4** (phase 9 — a
  deliberately weightier commitment than a normal order), **UAV Recon 3**
  (phase 9 — the same tier as Air strike).
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
| Guards (1 GDS) | 6 | 3 | 0.70 | 8 | 18 (24) | — |
| Armour (40 / 41 SAR) | 5 | 2 | 0.50 | 10 | 10 (20) | ×1.5 |
| Artillery (21 / 20 SA) | 4 | 2 | 0.50 | 8 | 8 (16) | ×1.25 |
| Combat Engineers (35 / 30 SCE) | 4 | 2 | 0.50 | 8 | 8 (16) | ×1.25 |
| C4I / ISR (10 / 11 C4I Bn) | 6 | 3 | 0.50 | 12 | 18 (36) | — |
| Surface combatant squadron (185 / 191 SQN) | 7 | 2 | — | — | 14 | — |
| Littoral squadron (188 / 189 SQN) | 8 | 3 | — | — | 24 | — |

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

Readiness still modulates range, but in one coarse, **named** step
(×0.75 for readiness < 50%) that is printed on the
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
  (−7), being surrounded (−4/round), isolated (−3/round). Upward: taking a
  position by assault (+6), capturing an objective (+8). *(Phase 6 removed the
  two supply shocks and the resupply lift with the supply system; nothing
  replaced them, and morale got strictly more stable as a result — see
  "Combat model".)*
- **Recovery** is gradual and conditional: +6 base, +2 holding
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
quiet rounds beside friendly forces bring it back to 72. Five light
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
| Surface combatant | 8 | 11 | ×1.15 | 15 |
| Commando | 7 | 11 | ×1.20 | 16 |
| Corvette | 7 | 9 | ×1.05 | 18 |
| Guards | 5 | 8 | ×1.00 | 20 |
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

**Correction (this pass):** the paragraph above describing a −40%/−12%
identification damage penalty was true of the phase-4b tree but was removed
in **phase 6** and the text was never updated to match — a real instance of
exactly the doc-drift this pass was asked to fix. The identification rung no
longer changes attack power at all; it changes only how WIDE the pre-attack
prediction's uncertainty band is (see "Combat model, supply removal and the
odds preview (phase 6)" below, and `combatcheck.ts`'s "the identification
penalty is gone" assertion, which fails loudly if it is ever reintroduced by
accident).

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
| Win split, first-moving side / second | 8 / 22 | 7 / 22 / 1 draw |
| Enemy force with any contact, per turn | 54.3% | **59.9%** |
| Enemy force *actionable* (live / Identified+) | 23.2% | **44.0%** |
| Enemy force at Confirmed | — | 18.2% |
| Distinct contacts per game, both sides | 15.8 | 17.0 |
| Recon orders per game, both sides | 28.1 | 40.0 |

Game length is unchanged and the side split is identical to the
baseline on the same seeds — the skew is a pre-existing map/turn-order
artefact, not something this pass introduced. (Phase 5 diagnosed and fixed it;
see "Side balance" below.) What did change is the quality of
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
- **Naval forces are now purely combat assets.** Each side fields a
  surface-combatant squadron (attack range 4 — 185 SQN's Formidable-class
  frigates for Sabre, 191 SQN's Endurance-class LPDs for Vanguard) and a
  littoral combat squadron (attack range 3, faster, 3 movement actions —
  188 SQN's Victory-class corvettes and 189 SQN's Fearless-class patrol
  vessels). They engage coastal targets by
  standoff fire — a standoff engagement damages but never occupies ground —
  and they contest the three open-sea **Anchorage** objectives, which only
  warships can hold.
- **Logistics units are gone.** The `LOGISTICS` formation type was removed
  along with supply-convoy positioning, and phase 6 removed the remaining
  positional supply modifier as well. Readiness survives as a combat/movement
  modifier; ammunition survives on the guns and the ships only.
- The bot (`server/bot.ts`) was updated in step: it no longer reasons about
  removed systems, sails its warships toward maritime objectives and coastal
  targets, uses per-type attack ranges, and — at Medium and Hard — spends its
  formations' **full movement allowance** (Easy deliberately uses only one
  bound per unit per round). It also relaxes its "is this worth doing"
  threshold as unspent AP piles up, so it stops ending turns on a full wallet.

## Combat model, supply removal and the odds preview (phase 6)

Four pieces of player feedback drove this pass, and they interact: supply was
frustrating, naval units felt toothless, the "recon before you attack or take a
penalty" rule was unintuitive, and the damage model was not something a player
could reason about. The result is one new pure module — `src/game/combat.ts` —
that the engine, the client preview and the bot all share.

### Supply is gone

Supply was gated on proximity to a depot, which meant the interesting decision
("where do I push?") was taxed by an uninteresting one ("am I still inside a
14-tile circle?"). Removed entirely: the `supply` stat, `SUPPLY_RADIUS`,
`supplySources` / `isInSupplyRange`, the supply combat and movement penalties,
the two supply morale shocks, the `RESUPPLY` order and its `S` shortcut, and the
Supply map overlay. **Depots, ports and airfields remain as objectives worth
VP** — they simply no longer project anything.

Two things survive, deliberately:

- **Readiness**, because it describes a formation's own state rather than
  logistics geography. It now falls when a formation fights (−10 in a close
  assault, −5 firing from standoff, −8 as the defender of an assault, −6 under
  a fire mission, and −4/round while in contact) and recovers +12 a round when
  it is not, floored at 25%. It still multiplies combat
  power and still gates movement range below 50%.
- **Ammunition**, rebuilt. The one genuinely useful thing supply did was stop
  the guns and the ships firing every single turn forever. That is now a plain
  count of ready rounds on **artillery and naval formations only** — 4 for a
  gun battalion, 4 for a frigate, 3 for a littoral squadron — drawn as pips on
  the unit card. A fire mission spends one; any round a formation does not fire
  returns one. No depot, no radius, no order. Every other formation has
  `maxAmmo: null` and shows no ammunition line at all.

Morale got **more** stable, not less, because the supply shocks were the main
thing dragging it down (see the measurements below).

### Naval standoff reach

Warships are standoff assets and now feel like it. Frigate attack range
**4 → 9 tiles**; littoral squadron **3 → 6**. A frigate therefore out-ranges a
land artillery battalion (7) and a corvette comes just short of one, so a
warship can work a coastline from water nothing ashore can answer. The existing
constraint is untouched: **a standoff engagement damages but never occupies
ground** — only a close assault takes a tile.

Measured over 480 bot-vs-bot games, this is a real capability and not a
dominant one: naval fire is 34–40% of all engagements, deals ~13% strength per
mission at ~1.4% cost to itself, and cannot capture anything. Coastal
objectives still change hands — 25–32% of all engagements were "Position
Captured", all of them by ground formations.

### The identification damage penalty is gone

Attacking a Contact-rung enemy used to cost 40% of your combat power and an
Identified one 12%. That is exactly backwards: if a formation can see a target
well enough to engage it, it does not fight worse for bureaucratic reasons.
**Removed.** `scripts/combatcheck.ts` asserts that attack power is bit-identical
at every rung.

What recon buys instead is **certainty**. Identification quality now sets the
width of the pre-attack prediction:

| Rung | What the preview does |
| --- | --- |
| Confirmed | Predicts from the target's true strength, morale and dug-in state. The band is just the ±12% combat roll — measured 1.6 percentage points wide on defender losses. |
| Identified | The target's strength, morale and fortification are *not* established, so the panel predicts from a stated assumption (80% strength, Steady, not dug in), says so out loud, lists the assumptions, and widens the band by ±30% — measured 6.0 points wide, ~4× the confirmed reading. |
| Contact | Not attackable at all: at that rung `fog.ts` sends no formation object, only a position. |

The **resolution is identical either way** — the server always uses the true
values. Recon buys the plan, not the punch. Help text, legend and tutorial were
rewritten accordingly.

### The formula

Both sides build one effective power as a legible multiplicative chain. Every
link is named, and every link appears in both the preview and the report.

```
ATTACK  = baseAttack
        × strength/100
        × readiness      (0.60 + readiness/100 × 0.40)
        × morale         (Elite 1.25 … Broken 0.40)
        × MATCHUP[attacking arm][defending arm][open | close ground]
        × closeAssaultPenalty     (guns ×0.50, ships ×0.60, support ×0.75)
        × combinedArms   (+7% per adjacent complementary arm, cap +21%)

DEFENCE = baseDefense
        × strength/100
        × readiness
        × morale
        × terrain        (urban +35%, hills +30%, forest +25%, open −10%, beach −15%)
        × defenceAffinity(infantry ×1.20 in close country, armour ×0.85, guns ×0.80 in the open)
        × fortification  (×1.30 dug in)
        × mutualSupport  (+5% per adjacent friendly, cap +15%)
```

One bounded roll of **±12%** is applied to the attacker, and then:

```
share = A' / (A' + D)

defender loses  2 × 13% × share        × 1.15 if it is a close assault
attacker loses  2 × 13% × (1 − share)  × 1.15 if it is a close assault
```

i.e. **losses are proportional to the opponent's share of the combat power.**
An even fight costs both sides 14.9%; a 3:1 fight costs the loser three times
what it costs the winner; there is no free attack. Standoff fire scales the
attacker's own losses to 15% and the defender's to 80%, and cannot capture.
Outcome bands: share ≥ 0.65 with a close assault captures the position, ≥ 0.55
repels the defender, 0.45–0.55 is mutual attrition, below that the attack is
repulsed.

#### The matchup table

Attacker arm (rows) × defender arm (columns), as `open / close` ground. This is
where combined arms comes from — it *is* the maths, not a bonus bolted on.

| | vs infantry | vs armour | vs guns | vs support | vs warships |
| --- | --- | --- | --- | --- | --- |
| **Infantry** | 1.00 / 0.90 | 0.85 / **1.30** | 1.40 / 1.30 | 1.35 / 1.25 | 0.50 |
| **Armour** | **1.45** / 0.70 | 1.20 / 0.75 | 1.75 / 0.95 | 1.70 / 0.90 | 0.40 |
| **Artillery** | **1.50** / 0.80 | 1.10 / **0.65** | 1.80 / 1.00 | 1.80 / 1.00 | 0.70 |
| **Support** (engineers, C4I) | 0.60 / 0.50 | 0.50 / 0.60 | 0.80 / 0.70 | 0.80 / 0.70 | 0.40 |
| **Naval** | 1.30 / 0.70 | 1.00 / 0.60 | 1.50 / 0.85 | 1.50 / 0.85 | 1.20 |

Read out as power shares for a full-strength, Steady attacker against a
full-strength, Steady defender:

| Ground | Armour → infantry | Infantry → armour | Guns → infantry | Armour → dug-in infantry |
| --- | --- | --- | --- | --- |
| Grass | **67%** | 43% | 66% | 61% |
| Hills | 61% | 36% | 60% | 55% |
| Forest | 40% | **55%** | 41% | 34% |
| Urban | 38% | 53% | 39% | **32%** |

Lead with armour in the open, lead with infantry into the town, put the guns
onto whatever is caught in the open — and the numbers say so before you commit.

### Pre-attack odds preview

Arm Attack (`A`) and hover a target. In the same slot the movement preview
uses, a panel gives the likely outcome (and the outcome at the far end of the
band), expected strength loss to **both** sides as a range, a bar showing your
share of the combat power, and the factors for and against you, biggest first —
plus, for an unconfirmed target, an explicit warning and the list of what it is
being forced to assume. It calls `engine.previewAttack`, which is the very
function the server resolves with; the battle report afterwards uses the same
share bar and the same factor filter, so it reads as the prediction resolved.

Verified end to end in Playwright: a previewed `Mutual Attrition (could be
Attack Repulsed) | you 13–20% them 10–17%` resolved to `Attack Repulsed | you
17.7% them 12.2%` — inside the band on both sides — and a previewed
`Defender Repelled | you 2% them 13%` resolved to `you 1.6% them 12.3%`.

### Measured outcomes

480 bot-vs-bot games (120 per difficulty per seed block, two independent seed
blocks) after the change:

| | MEDIUM | HARD |
| --- | --- | --- |
| Engagements sampled | 3,163 | 3,883 |
| Avg attacker strength lost | 7.0% | 8.8% |
| Avg defender strength lost | 17.1% | 15.9% |
| Position Captured | 30.8% | 25.8% |
| Defender Repelled | 47.7% | 39.0% |
| Mutual Attrition | 12.1% | 14.3% |
| Attack Repulsed | 9.4% | 20.8% |
| Close assault: attacker / defender loss | 10.7% / 19.3% | 12.6% / 17.3% |
| Standoff: attacker / defender loss | 1.3% / 13.7% | 1.5% / 13.2% |

Attacking is worth it when you pick the fight — the bots' attack thresholds are
what produce the attacker-favourable average, and the HARD bot, which attacks
on thinner margins, is repulsed twice as often. No arm dominates: armour wins
77–88% of the attacks it chooses, infantry 59–76%, and engineers and the C4I
battalion 12–17%, which is the table doing its job.

Side balance, against phase 5's 47.3%:

| Difficulty | Games | SABRE win rate |
| --- | --- | --- |
| MEDIUM | 240 | **52.5%** |
| HARD | 240 | **52.1%** |

Difficulty ordering is unchanged (40 games each, sides alternated): HARD beats
EASY 78%, MEDIUM beats EASY 75%, HARD beats MEDIUM 57%.

Morale stability, against the phase 4a numbers it must not regress from:

| Metric | Phase 4a | Phase 6 |
| --- | --- | --- |
| Unit-rounds Shaken or Broken | 0.0% | **0.01–0.06%** |
| Band changes per round | 2.2% | **0.26–0.37 per round** (≈0.3–0.4% of unit-rounds) |

### Accessibility pass

Friction removed rather than features added:

- **The supply stat and the Supply overlay are gone** from the unit card and
  the HUD; so is the "Nearby friendly" line (the "Supporting" row already
  carried the cohesion story) and the dead `overlays.terrain` flag, which had a
  field in the type and no effect in the renderer.
- **Ammunition reads as pips and a count** (`3 / 4`) instead of a percentage
  bar, and only appears on the formations that carry it.
- **A formation is auto-selected** the moment it is your turn and nothing is
  selected, so a new player lands on a screen that already shows a unit's
  orders rather than an empty bar telling them to go and click one.
- **A greyed-out order now explains itself.** It is styled unavailable but is
  not an HTML-`disabled` button, because a disabled button swallows the click
  and says nothing; clicking one flashes the exact reason from
  `actions.ts`. Those reasons were re-audited after the rules change ("No ready
  rounds left (0 / 4). Hold fire for a round and one comes back.").
- **Fire Mission now has a real disabled reason** when there is nothing in
  range, instead of silently arming a targeting mode with no legal target.
- Tutorial, field manual and legend were rewritten for everything that changed;
  the manual gained "Matchups", "The pre-attack preview" and "Ammunition"
  topics, and the stale `S` Resupply key and the 24th/9th battalion names left
  over from an earlier phase were removed.

### Test suites added

- `npm run wirecheck` — the wire-redaction assertion suite, recreated. It drives
  real bot games and audits every push, field by field from an **explicit
  contract**, at all four detection rungs (284,908 assertions over 6 games in
  the default run). It fails closed: a field added to `Formation` and not
  classified in the contract is reported rather than quietly shipped, which is
  how the `supply` removal and the `ammo` / `lastFiredRound` additions were
  checked.
- `npm run combatcheck` — deterministic assertions on the combat model's
  promises: the matchup inverts with the ground, terrain and fortification are
  real, both sides bleed, attack power is identical at every detection rung, and
  ammunition depletes and regenerates.
- `npm run check` runs mapcheck, wirecheck and combatcheck together.

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
   airfields on flat inland ground, the three largest river crossings on the
   axis of advance, the three dominant peaks, both depots, and three sea
   anchorages placed deliberately *balanced* — one nearer each side's naval
   spawn plus one contested middle — so neither side gets the maritime VP for
   free.

### Map design for engagement (phase 5)

The phase-3 board (72×72) already brought first contact forward, but the two
forces still spent a third of the game walking, and a lot of objectives could
be picked up without ever meeting the enemy. Phase 5 changes the *design* of
the map rather than its size.

**Mirrored deployment.** The sea mask now cuts in at the same fraction on both
axes (0.62 east / 0.62 south instead of 0.60 / 0.64), which makes the landmass
symmetric under reflection in the leading diagonal. The two homes are placed as
exact mirror images in that diagonal — Sabre at (0.18 N, 0.49 N) in the west,
Vanguard at (0.49 N, 0.18 N) in the north — as are the two port anchors
(0.18/0.82 and 0.82/0.18) and the two airfield anchors. Deployment separation
drops from ~70 to ~44 tiles on the Manhattan metric: close enough that leading
elements are in sensor range on round 2–3, far enough that round 1 is still a
movement turn, not a knife fight.

**A contest axis.** The line between the two homes is the axis of advance and
its midpoint is the centre of the battlefield. `contestScore(x, y)` is 1 there
and falls to 0 in either rear area, and it now drives:

- **where towns are** — settlement siting gets a `contestScore × 4.5` bonus, so
  the biggest objectives on the board grow on the ground both sides have to
  fight through rather than in someone's back yard;
- **which crossings and hills are objectives** — river crossings are ranked by
  `cluster size + contestScore × 14`, peaks by `height + contestScore × 1.6`;
- **what objectives are worth** — every objective has a floor plus a
  contested-ground premium (urban 2 + up to 4, bridges and airfields 2 + up to
  3, hills 1 + up to 3, ports 2, depots 1). A rear-area objective pays 1–2 VP a
  round; the contested middle pays 4–6.

**Chokepoints.** Three changes make crossings scarce and worth fighting for:
trunk rivers are widened at 3× the river threshold instead of 6× (wider
obstacle); a road costs **30** to bridge a river instead of 14, but only 6 to
reuse an existing crossing, so the A\* router detours a long way to share a
bridge rather than building a second one; and the road MST gets **one**
redundancy edge instead of three. Across 120 seeds this takes the map from
~14 bridge tiles and ~239 road tiles to **~4.7 bridge tiles and ~180 road
tiles** — a handful of heavily-used crossings instead of a permeable river
line.

**Discouraging passivity** is handled by two levers and no new mechanics: the
contested-VP weighting above (a force that sits on its own hinterland cannot
reach 280 VP inside 24 rounds), and the scoring rule in
`engine.tickObjectives` (below) which pays you only for objectives you are
*still* holding after the enemy's reply.

`server/bot.ts` was updated to match: it used to walk to the *nearest*
uncontrolled objective, which now means mopping up cheap rear-area ground.
`bestUncontrolledObjective` discounts distance by value — each extra VP/round
counts as 2.5 tiles of shortcut at MEDIUM, 4 at HARD, 0 at EASY.

#### Measured, seeded bot-vs-bot, MEDIUM vs MEDIUM

Before: the phase-4b tree (c8bc10d) checked out and run under the same harness,
2 × 30 games. After: 3 × 40 games on three independent seed bases. Ranges are
the per-batch spread.

| | Before (c8bc10d) | After |
| --- | --- | --- |
| First detection | round 3.8 – 4.0 | **round 2.9 – 3.1** |
| First proximity contact (≤3 tiles) | round 4.1 – 4.2 | **round 3.2 – 3.5** |
| Engagements per game | 7.9 – 9.7 (8.8) | **12.0 – 13.2 (12.6)** |
| Engagements per round | 0.65 – 0.79 (0.72) | **0.90 – 0.97 (0.94)** |
| Objectives changing hands per game | 29.7 – 29.8 | **32.3 – 33.4** |
| Fights within 3 tiles of an objective | 94 – 95% | **96 – 97%** |
| Rounds per game | 12.1 – 12.3 | 13.3 – 13.6 |

Engagements per round are up **~30%** and engagements per game **~43%**,
objectives change hands ~10% more often, first *detection* comes about a full
round sooner and first proximity contact about three-quarters of a round
sooner — in games that are, if anything, slightly *longer*. HARD vs HARD is
sharper still: first proximity contact on round **2.8 – 3.0**, **1.07 – 1.13**
engagements per round, 14.7 – 15.0 engagements per game.

### Side balance (phase 5)

Phase 4b measured an 8/22 win split at MEDIUM over 30 seeded games and
confirmed it was pre-existing. Phase 5 diagnosed it.

**It was the scoring instant, not the map.** Objective control was resolved at
the end of every turn, but VP were paid to *both* sides once per round, at the
end of the **second** player's turn. That handed the second player the last
word on every scoring tick: it could take or retake contested ground and bank
it immediately, while anything the first player captured had to survive a full
enemy turn before it paid out. The proof: flipping only the turn order in the
phase-4b tree (second player becomes first) moved the same 30 seeds from
**8/22 (−25.2 VP)** to **14/16 (−4.1 VP)** — the advantage followed the
scoring slot, not the side.

Two further controls on the phase-5 tree separated the remaining effects:
paying each side at the end of its *own* turn simply mirrors the bug (+36.7 VP
to whoever moves first), and running a mirror ORBAT (both sides given a
commando battalion) left the bias unchanged — so it was never the Guards.

**The fix has two parts.**

1. **Symmetric scoring.** Each side is paid at the end of the **opponent's**
   turn, for what it is still holding once the opponent has replied. Both
   payouts are measured immediately after an enemy turn, so neither side ever
   gets the last word on its own score — and it is also the rule the design
   wants: an objective has to be *held*, not merely touched.
2. **Rolled initiative.** Moving first is still worth something in any
   sequential turn-based game: with symmetric scoring alone it measured at
   roughly **+22 VP a game** to whoever moved first. So initiative is rolled
   from the map seed, murmur3-mixed, exactly the way a wargame rolls for it,
   and `GameState.initiative` drives the round boundary so victory is still
   adjudicated only after the second player's turn. No human player is
   affected either way — the server already assigns seats by a coin flip.
   (With everything else in this pass in place, the initiative holder ends up
   winning **120 / 240** — exactly even. The contested-objective weighting and
   the bot's value-aware objective choice mean both sides now converge on the
   same ground, which is where the initiative advantage went.)

`VP_WIN_THRESHOLD` rose 200 → 280 to absorb the ~40% higher VP rate the
contested-objective weighting produces, so game length is back at ~13.5 rounds.

#### Win splits, before and after

Each "after" cell is 3 × 40 seeded games on three independent seed bases; the
"before" cells are the phase-4b tree run under the same harness.

| | Before (c8bc10d) | After |
| --- | --- | --- |
| MEDIUM vs MEDIUM | 21 / 39 (**35.0%**) over 60 games | **62 / 57 / 1 draw (52.1%)** over 120 games |
| HARD vs HARD | 28 / 32 (46.7%) over 60 games | **51 / 69 (42.5%)** over 120 games |
| Both, combined | 49 / 71 (**40.8%**) over 120 games | **113 / 126 / 1 (47.3%)** over 240 games |
| Mean VP difference | −25.2 / −15.7 / −8.5 / −10.1 (always the same direction) | +15.5 / −24.7 / −11.3 / +21.0 / −7.4 / −53.6 (sign varies by batch) |

The systematic component is gone: before the fix, every single batch at every
difficulty leaned the same way and the VP difference never changed sign. After
it, the per-batch VP difference swings either way, the combined split is
113 / 126 over 240 games (a two-sided binomial p ≈ 0.42 against an even coin),
and the initiative holder wins exactly half its games. The individual HARD
batches are noisier than the MEDIUM ones (17/23, 21/19, 13/27) — 40 games is a
small sample against a ±15% per-batch spread — but they no longer favour a
fixed side.

### Side balance re-verified after the 11th formation (phase 8)

Adding 48 SAR / 42 SAR meant re-running the side-balance check from scratch
rather than assuming it still held. Method: a throwaway bot-vs-bot script
(not committed) calling `decideBotAction` directly against `engine.initGame`,
mirroring exactly how `server/index.ts` actually drives its bot — the real
server hands the bot the **raw, unfiltered** `GameState`, not the
fog-filtered view a human player gets, so this sim reproduces that faithfully
rather than a more "realistic" fogged bot. 120 seeded games per cell, same
seed bases (5000+i MEDIUM, 9000+i HARD) run against both trees so the
comparison isolates the roster/AP change:

| | Before (e89f6b2, 10 formations/side, AP 26/34) | After (phase 8, 11 formations/side, AP 28/36) |
| --- | --- | --- |
| MEDIUM vs MEDIUM | SABRE 60.0% / VANGUARD 40.0% | SABRE 59.2% / VANGUARD 40.8% |
| HARD vs HARD | SABRE 55.8% / VANGUARD 44.2% | **SABRE 49.2% / VANGUARD 50.8%** |
| Avg. rounds / actions per game | 12.8–13.8 rounds, 320–336 actions | 12.9–13.6 rounds, 334–350 actions |

Two things worth being direct about. First, this methodology's own "before"
numbers do not match the ~54/46 MEDIUM, ~47/53 HARD figures quoted from the
phase-7 pass — that earlier soak was a different throwaway script, most
likely one that fed the bot a fog-filtered view rather than raw state, and it
was not committed to the repo, so it could not be re-run bit-for-bit. What
*can* be said cleanly is the paired comparison above, both cells of which
used the identical harness against the identical seeds — that is the
apples-to-apples measurement the task calls for. Second, given that
comparison: the eleventh formation and the AP bump did **not** introduce or
worsen a side lean. HARD balance actually improved (55.8/44.2 → 49.2/50.8,
essentially even). MEDIUM is unchanged within noise (60.0/40.0 → 59.2/40.8)
— a persistent SABRE lean at MEDIUM difficulty that predates phase 8 and
survives it identically, so it is a property of the MEDIUM bot's heuristics
against this map/scenario, not something the roster change caused. Game
length and action volume per game are essentially unchanged, so the larger
rosters have not made games meaningfully longer or slower to resolve.

### Side balance re-verified at twelve formations a side (phase 9)

Adding 12 C4I Bn / 16 C4I Bn meant re-running the same check again, **using
phase 8's own harness and methodology** rather than a fresh ad-hoc script (a
mismatch phase 8 itself flagged as producing numbers that do not compare
cleanly). The "before" tree is an actual `git worktree` checkout of
`5b8e0c9` (the commit this phase started from — 11 formations/side, AP
28/36); the "after" tree is this pass's working tree (12/side, AP 30/38).
Same seed bases (5000+i MEDIUM, 9000+i HARD), same raw-state-to-the-bot
harness. Sample size was reduced from phase 8's 120 games/cell to **25
games/cell** to fit this pass's time budget — smaller, so treat the exact
percentages as indicative rather than as tight as phase 8's — but paired
against the same seeds on the same harness, which is the part that makes the
comparison meaningful at all:

| | Before (5b8e0c9, 11 formations/side, AP 28/36) | After (phase 9, 12 formations/side, AP 30/38) |
| --- | --- | --- |
| MEDIUM vs MEDIUM | SABRE 64.0% / VANGUARD 36.0% | **SABRE 52.0% / VANGUARD 48.0%** |
| HARD vs HARD | SABRE 68.0% / VANGUARD 32.0% | **SABRE 48.0% / VANGUARD 52.0%** |
| Avg. rounds / actions per game | 12.6–13.8 rounds, 352–370 actions | 13.3–13.5 rounds, 392–396 actions |
| Avg. end-of-game formation strength | 70.2–75.5% | 72.7–78.4% |
| Reorganize uses/game | 5.16–7.88 | 5.68–7.56 |

The twelfth formation and the AP bump did **not** introduce a side lean —
if anything both cells are markedly more even than the 25-game "before"
read (which itself skews harder toward SABRE than phase 8's own 120-game
figures for the *same* 11-formation roster, 59.2/40.8 and 49.2/50.8 —
consistent with phase 8's own caution that a few dozen games is a small
sample against a real per-batch spread; it is not evidence the 11-formation
roster itself got less balanced). Game length and action volume per game are
essentially unchanged, so the twelfth formation has not made games
meaningfully longer to resolve. Reorganize usage per game is **not**
noticeably higher despite the buff (7.88→7.56 MEDIUM, 5.16→5.68 HARD) — the
cooldown and no-movement gate, not the restore size, are still what actually
limits how often it fires; see "Reorganize" in the phase 9 section above for
the direct before/after restore-value comparison. UAV recon is being spent
by the bot deliberately, not hoarded or wasted: 6 uses/game in every cell —
exactly the 3 charges/side the game gives out, fully used, never overspent.
Vertical insertion shows 0 uses/game in this sim because **the bot does not
use it** (deferred — see "Deferred" below); this was verified working
correctly through the real client/server instead via the Playwright pass
below. The exploitation bonus fires on roughly a quarter of resolved attacks
(25.2–27.7%) — not on every attack, not never, which is the rate the task
asked to confirm.

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
Sabre's first ship) rather than trusting the generator, and reports a pass
rate plus terrain statistics.

### Wire size

The tile grid is 5,184 tiles (~355 KB of JSON) and changes only when an
engineer throws a bridge, so `road` / `river` / `bridge` / `navigable` are
only serialised when true, the per-tile render noise is derived from a hash of
`(x, y)` in the renderer instead of being carried on the wire, and the server
**elides the grid entirely** from routine `state` pushes (`WireGameState` in
`src/net/protocol.ts`); the client reuses the grid it received at `start`.
A routine per-action broadcast is **7 KB** instead of ~440 KB.

## Phase 7 mechanics — overwatch, Zones of Control, suppression, Reorganize

**Documentation catch-up.** These four mechanics shipped in phase 7 but were
never written up here — a gap this pass was explicitly asked to close before
adding its own new content on top. What follows is what actually ships, read
back out of `src/game/engine.ts`, `movement.ts`, `combat.ts` and `types.ts`.

### Overwatch / reaction fire

A formation that ends its turn **without spending its major action** (it may
still have moved) goes **on alert** for the duration of the opponent's
following turn — no order, no AP; it is the reward for holding rather than
acting (`endTurn` sets `onAlert = !hasActedThisTurn`, artillery excluded — it
is not a direct-fire weapon). While on alert, if an enemy formation moves into
a tile within the alert formation's **weapons range AND its detection range
and line of sight** — the exact model passive spotting uses, so it only
reacts to what it could legitimately have seen — it fires **one** reduced-power
reaction shot (`REACTION_FIRE_POWER_MULT` = 0.55× a normal attack) through the
same combat chain (`attackPower` / `defencePower` / `lossesFromShare`) a
normal attack resolves with, at no AP or movement cost to itself (that cost
was already banked by not acting). One shot per alert formation per opponent
turn (`REACTION_FIRE_MAX_PER_TURN` = 1), checked tile-by-tile along the
mover's path so a long bound cannot walk through an alert formation's arc
without being fired on. The alert clears at the start of the formation's own
next turn, or immediately once it spends its major action.

### Zones of Control (ZOC)

Every **land** formation except artillery projects a Zone of Control into its
four orthogonally adjacent tiles (`zocTilesFor` in `movement.ts`); naval
formations neither project nor are affected by one — it is a land-warfare
concept. An enemy formation **moving through** one of your ZOC tiles has its
bound end there: the pathfinding search (`movement.ts` `search`) refuses to
expand FROM a ZOC tile it did not start in, so it may still enter and stop on
one, it just cannot use it as a step to somewhere further — a move that needs
to pass beyond it is refused with `ZOC_BLOCKED` and an explicit reason, or has
to route around. Leaving a ZOC tile the formation **started** its move
standing in (disengaging from contact) costs a full movement action's worth of
points on the very first step, itemised in the movement preview as
`zocNote` as soon as a destination is hovered.

### Suppression

A battlefield condition **separate from strength, morale and readiness** —
its own 0–100 number (`Formation.suppression`), shown as its own bar, never
folded into another stat. Indirect/standoff fire (artillery fire missions,
naval standoff fire, air strikes) applies a heavy dose
(`SUPPRESSION_HIT_INDIRECT` = 30); a direct assault applies a smaller amount
too (`SUPPRESSION_HIT_DIRECT` = 12) — always a secondary output of the same
engagement that deals damage, never a substitute for it. Suppression cuts the
**suppressed formation's own** attack power and movement range — up to −50% at
maximum suppression (`suppressionMultiplier`) — and never causes strength loss
by itself. It decays `SUPPRESSION_DECAY_BASE` = 25 points a round it is not
refreshed, faster under cover or dug in (`SUPPRESSION_DECAY_COVER_MULT` =
×1.5 — and phase 9 adds a further per-tier multiplier on top, see below),
slower in the open (`SUPPRESSION_DECAY_OPEN_MULT` = ×0.7). Both the pre-attack
preview and the battle report show exactly how much suppression an engagement
will apply, alongside the expected losses.

### Reorganize

A light restorative action distinct from the phase-6-removed supply/depot
system: a formation stands down for the round (`S`, 2 AP) to reconstitute —
readiness and morale recover a real amount immediately, and some strength
comes back too (replacements, at the same %-of-strength abstraction the rest
of the game uses). Gated twice so it cannot flatten out combat losses: it
requires the formation to have made **no movement action this round**
(`f.movesUsed === 0`) as well as spending its major action, and it cannot be
used again for `REORGANIZE_COOLDOWN_ROUNDS` = 3 rounds. **Phase 9 buffed the
restore values and added a mutual bonus for adjacent formations reorganizing
together — see "Phase 9" below.**

## Phase 9 — vertical insertion, fortify tiers, exploitation, UAV recon, mutual Reorganize, Reorganize buff, and the second C4I battalion

This pass's eight items, in the order the brief gave them.

### 1. Vertical / heli insertion (Commandos and Guards)

A new order (`I`, 4 AP — `VERTICAL_INSERT` in `types.ts`/`actions.ts`,
`engine.ts` `verticalInsertAction`), available only to `COMMANDO` and
`GUARDS`-arm formations: redeploy to **any tile within 14 Manhattan tiles**
(`VERTICAL_INSERT_RADIUS`) that is legally occupiable (passable terrain,
unoccupied) and **not adjacent to any formation this side has actually
detected** — checked against the acting side's own `players[owner].contacts`
table, never the true enemy positions, so it respects fog of war exactly the
way every other order does. It bypasses normal movement range, road bonuses
and **Zones of Control entirely** — no path is walked, no overwatch is
triggered along the way, which is the whole point: a vertical envelopment
goes *over* ZOC, not through it. The "cannot land adjacent to a detected
enemy" rule is the one safety valve against it becoming a free kill: you
cannot drop directly on top of a spotted position, only near it.

Capped at **2 uses per formation, for the whole game** (`VERTICAL_INSERT_MAX_USES`,
tracked on `Formation.verticalInsertsUsed`, not a per-round counter) — genuinely
rare, and costed at 4 AP, noticeably more than a normal Move (1) or even a
Special Op (3), so it reads as a real commitment. `actionAvailability` reports
the precise reason it is unavailable — no charges left, or no legal landing
zone anywhere within reach right now (`hasVerticalInsertLandingZone` scans the
radius) — the same disabled-reason discipline every other order gets.
Flavoured by the Guards' real air-assault/heliborne character (their
equipment line already reads "heli-rappelling and fast-roping") and the
Commandos' insertion-behind-lines role.

**Why the cap is tight, not the range.** A 14-tile leap is a genuine "jump the
whole front line" move on a 72×72 board, but it is a manoeuvre tool, not a
win condition: it does not fight (it still has to reach its target and then
spend a further Attack), it cannot land next to what it is trying to
displace, and it costs a full 4 AP out of a 30 AP budget shared with eleven
other formations. The combatcheck suite asserts it is refused once spent, once
adjacent to a detection, and to the wrong formation types; the balance sim
(below) checks it is not being used to trivially win games.

### 2. Prepared-defence tiers on Fortify

Fortify was previously a single flat +30% defence bonus for as long as the
formation stayed dug in. It now **accumulates**: `Hasty` (tier 0, the
unchanged +30%) → `Prepared` (tier 1, +45%) → `Entrenched` (tier 2, +60%) —
`FORTIFY_TIER_DEFENCE_MULT` in `types.ts`. A formation that fortifies starts
at Hasty; each further **consecutive round** it spends fortified, doing
**nothing else at all** (no move, no major action — not even re-issuing
Fortify), climbs one tier, capped at Entrenched. Moving, attacking, or
spending the major action on anything other than continuing to hold — a fire
mission, a Recon sweep, an Engineer order, even Reorganize — throws the tier
back to zero; moving (and attacking, for the attacker) also clears `fortified`
itself, unchanged from before. This is tracked with two fields on `Formation`:
`fortifyTier` (0–2) and a per-round `fortifiedThisRound` flag that
distinguishes "just (re-)dug in this round" from "held, doing nothing, for a
further round" — both leave `hasActedThisTurn` true, which alone cannot tell
the two apart (`engine.ts` `tickFortifyTiers`, run at end-of-round).

Entrenched positions also resist suppression better: an extra decay
multiplier by tier (`FORTIFY_TIER_SUPPRESSION_DECAY_MULT` = ×1.0 / ×1.15 /
×1.3) stacks on top of the existing fortified/cover suppression-decay bonus —
consistent with the terrain-as-multiplier pattern the rest of the suppression
model already uses.

**What it looks like to the player.** The dug-in arc on the unit card and the
map marker gains a small row of amber chevron pips below it — one per tier
above Hasty — and the unit card's "fortified" chip now reads `Hasty`,
`Prepared` or `Entrenched` instead of a flat "fortified". The pre-attack
preview and the battle report both already list every factor that changes the
outcome (phase 6's rule); the tier's defence bonus now appears there labelled
by name — "Dug in — Entrenched", not just "Dug in" — so the player can see
which tier they are attacking into before committing.

### 3. Exploitation bonus after a decisive attack win

When an attack resolves as `Position Captured` (the only outcome that takes
ground) with `None` or `Light` attacker losses — a clean, low-cost
breakthrough, not a costly win — the attacking formation gets an immediate
**1 AP rebate** (`EXPLOITATION_AP_REBATE`) that same turn, clamped to
`AP_CAP` like any other AP credit. **Chosen over a bonus movement action**
because it is a one-line change against the existing shared AP pool, with no
per-formation `movesMax` exception to special-case in the UI, the bot's
`boundsLeft` accounting, or `computeReachable` — a bonus movement action would
have needed a new formation field and touched all three. It cannot
double-trigger: an attack spends the formation's major action, so a
formation can only attack (and therefore only earn this) once per turn.
Surfaced in the battle report as "Breakthrough — clean, low-cost win. Bonus
AP granted this turn." (`BattleReport.breakthroughBonus`), so the player
understands why they suddenly have more AP to spend.

### 4. UAV recon — a capped consumable, not a formation order

Flavoured as Heron 1 / Hermes 450 UAV sorties (the same flavour text already
used on the C4I battalions' equipment line). A **player-level**, not
per-formation, resource: `PlayerState.uavCharges`, starting at
`UAV_CHARGES_PER_GAME` = 3 and never regenerating. Spending a charge
(`UAV_RECON`, 3 AP — the same tier as Air Support, since it is a comparable
rare, off-map strategic asset, not a routine order like Recon's 1 AP) reveals
a 7-tile radius (`UAV_SWEEP_RADIUS`) anywhere the player designates,
independent of any formation's own sight or line of sight — it directly lifts
detection confidence for everything in range to at least
`UAV_SWEEP_CONFIDENCE` = 78 (comfortably past IDENTIFIED at 55, short of
CONFIRMED at 85, so it reliably reveals the arm without solving the whole
board by itself), through the same confidence/ladder machinery
(`detectionLevelFor`) every other sensor uses, then decays afterward at the
same kind of rate a Recon-tracked contact does rather than vanishing on a
hard one-round cutoff.

The HUD shows remaining charges as a small counter next to VP in the top bar
(`TopBar` — `data-testid="uav-btn"`/`"uav-charges"`), deliberately not a full
panel — it is a rare strategic tool, not a routine action. Keyboard shortcut
`U`. Wired into the bot (`server/bot.ts`): MEDIUM/HARD only, and it spends a
charge on the highest-value uncontrolled objective it does **not** already
hold IDENTIFIED-or-better intelligence on within the sweep radius, and only
when it already has formations within striking distance of that ground —
i.e. exactly the "unclear territory it is about to commit to" case the brief
asked for, not a reflexive or wasted spend.

### 5. Match replay / turn-by-turn review

Reachable from the end-game screen ("Review Replay") once `phase ===
'GAME_OVER'`. Built as a read of the existing `log` (now carrying a `round`
number per entry) and a new, deliberately minimal `GameState.replay`: an
array of `{ round, entries: [{ id, owner, type, shortName, x, y, strength }] }`
snapshots taken **once per round** (`engine.ts` `snapshotRound`, called at
game start and at every round boundary in `endTurn`) — positions only, never
a full `GameState` per round. The replay UI (`components/Replay.tsx`) is a
simple scrubber (prev round / next round / play, arrow keys, Escape to close)
over a lightweight canvas redraw of unit dots and objective markers for that
round, plus the log entries filtered to it. It is explicitly **not** a
frame-perfect action replay or a re-simulation — the goal is letting players
review what happened, not proving it byte-for-byte.

**Redaction is still enforced.** `fog.ts` `redactReplay` gates every enemy
entry, in every round of the replay, by the viewer's **final** (end-of-game)
contact rung for that formation id — the same "have you ever legitimately
earned this" rule used everywhere else, just evaluated once at the end rather
than reconstructed per historical round (the engine does not record a
detection-rung history, and re-deriving one was explicitly out of scope for
"keep this lightweight"). A formation the viewer's side never reached
IDENTIFIED on is omitted from every round of the replay it appears in, not
shown with numbers never earned; one only ever IDENTIFIED shows a generic
arm-only stand-in with strength withheld, exactly like a live redacted
formation. `wirecheck.ts`'s `auditReplay` exercises this over the same
bot-vs-bot soak the rest of the suite runs.

### 6. Mutual Reorganize incentive

When two **adjacent** friendly formations both use Reorganize in the **same
round** — in either order — each gets an extra flat bump
(`MUTUAL_REORGANIZE_READINESS_BONUS` = +10 readiness,
`MUTUAL_REORGANIZE_MORALE_BONUS` = +6 morale) on top of its own solo restore
values. Detected by checking, at the moment the SECOND formation reorganizes,
for adjacent friendlies whose `lastReorganizedRound === state.round` — which
is already true for whichever one went first, however the two orders were
issued — and applying the bonus to **both** at that point. **Chosen over
halving the AP cost of the second order** because a flat bonus composes
correctly regardless of ordering with no AP-refund bookkeeping to get
right, and it does not interact with the AP-economy assertions the rest of
the suite already leans on. Logged as "`21 SA` and `40 SAR` reorganize
together — readiness restored more fully."

### 7. Buffed Reorganize restore values

Direct tuning request: readiness +25 → **+38**, morale +12 → **+20**, strength
+6 → **+12** (`REORGANIZE_READINESS` / `_MORALE` / `_STRENGTH` in
`types.ts`) — within the requested 35-40/18-22/10-14 range, on the higher end
because the brief asked not to be timid about it. Verified in simulation
(below) that repeated attacks still matter and the cooldown/no-movement gate,
not the restore size, remain the real constraint: even fully buffed, one use
recovers a formation that lost half its strength to only ~62% (still well
short of full — see the combatcheck "Reorganize alone does not come close to
fully healing heavy losses in one use" assertion), and the 3-round cooldown
means a formation can use it at most ~8 times across a 24-round game even if
it never moves.

### 8. Second C4I battalion each side — 12/16 formations

See "Real-World Reference vs. Fictional Game Mechanics" above for the ORBAT
entries, the WebSearch verification of 12 C4I Bn and 16 C4I Bn, and the AP/
deployment-zone/side-balance re-verification this required — the same rigor
phase 8 applied when it added the second armour battalion.

## Design choices / documented deviations

- **AP rollover cap:** leftover AP carries over uncapped in the brief's base
  rule; this prototype caps the carry at 34 (`AP_CAP`) to avoid runaway
  hoarding turning into a first-turn alpha strike, while still rewarding a
  quiet turn with a stronger follow-up.
- **Movement:** flat 1 AP per Move action regardless of distance travelled
  within range, per the brief; the *range* itself is computed from
  unit-type move points, terrain cost, roads, elevation change, and a
  readiness penalty. The number of Move actions a formation may take
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
  always SABRE" — called out explicitly since the brief left the choice
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
enemy within attack range (1 tiles)", "No ready rounds left (0 / 4). Hold fire
for a round and one comes back.", "Not enough AP — needs 3, you have 2"). Since
phase 6 an unavailable order is *not* an HTML-disabled button: clicking it
flashes that reason, because a disabled button swallows the click and tells a
new player nothing.

| Key | Order | | Key | Action |
|-----|-------|-|-----|--------|
| `M` | Move | | `E` | End turn (warns if AP and orders remain) |
| `A` | Attack | | `Tab` | Next formation with orders left |
| `R` | Recon | | `Z` / `Space` | Centre the camera on the selected unit |
| `F` | Fortify | | `Esc` | Cancel targeting / close panel / deselect |
| | | | `L` | Map legend |
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

- **Turn-order advantage is distributed, not removed.** Moving first is still
  worth roughly +22 VP a game, and the initiative holder wins about 58% of
  bot-vs-bot games. Phase 5 removed the *systematic* part (the scoring instant)
  and made the remaining part a fair coin per operation rather than a permanent
  property of one task force. Genuinely neutralising it — alternating the
  initiative round to round, or a simultaneous-orders turn structure — is a
  turn-structure change and was out of scope for a refinement pass.


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
- **The bot does not use Vertical Insertion.** Item 1 of phase 9 did not
  mandate bot support the way item 4 (UAV recon) explicitly did, and adding
  a sound heuristic for when a 4 AP, twice-a-game leap is actually worth it
  (versus a normal advance) was judged to need more tuning/testing time than
  the pass's budget allowed to do well rather than half-heartedly. The
  balance sim above shows 0 uses/game from the bot as a result; the mechanic
  itself was verified working correctly through the real client/server via
  the Playwright pass (see "Testing performed" below). A future pass should
  give HARD (at least) a scoring heuristic — likely: use it when a
  high-value uncontrolled objective is reachable within 14 tiles but not
  within this round's ordinary movement budget, and no detected enemy sits
  adjacent to the landing tile.
- **Match replay is best-effort, not a re-simulation**, and its per-round
  redaction is gated by the viewer's FINAL detection rung rather than a
  recorded rung-per-round history (see "5. Match replay" above) — a
  formation whose contact aged out entirely by game end will not appear in
  earlier rounds of the replay even though it was legitimately detected at
  the time. Recording a full per-round detection-rung history was judged out
  of scope for "keep this lightweight."

## Testing performed

### Phase 12 (Withdraw, concealment from stasis, priority targets; animated movement, combat effects, objective flip, elevation shadow, strength pips, breadcrumbs, camera sweeps, event flash)

**Group A — gameplay:**

- **Retreat / Withdraw (`W`)**: a new order, distinct from Move, gated on
  `movement.ts` `isThreatened` — adjacent to a formation this side's own
  contact table has actually detected, standing inside an enemy Zone of
  Control, or below a strength/morale floor (35% strength, or Shaken/Broken
  morale). Costs a flat `AP_COSTS.WITHDRAW = 1` for a bound up to
  `WITHDRAW_RANGE_FRACTION` (0.6) of the formation's normal single-action
  range, explicitly skipping the ZOC disengagement surcharge a normal Move
  pays (see `movement.ts` `planWithdraw`'s `noDisengageSurcharge` search
  option) — but it still spends a movement action and still walks its path
  tile-by-tile through the same `triggerOverwatch` a Move uses, so covering
  reaction fire is not dodged. `combatcheck.ts` proves the AP-cost comparison
  directly (an ordinary ZOC-disengaging Move needs 2 AP for the same
  repositioning vs. Withdraw's 1) and proves overwatch still fires against it
  using a long-ranged watcher that outranges the whole withdrawal budget
  regardless of direction chosen. `server/bot.ts` gets a `dangerScore`-gated
  candidate so only a genuinely hurt, threatened formation withdraws (a
  healthy formation standing in a ZOC keeps fighting) — bot-vs-bot sims below
  show ~2.4–3.4% of all bot actions, never zero and never dominant.
- **Priority targets**: `game/threat.ts` `computePriorityTargets` reads
  *only* the fog-filtered `GameState` a client already holds (its own
  `state.formations`, already stripped by `fog.ts` below IDENTIFIED) — it is
  fog-correct by construction, not by a separate check, since an undetected
  enemy formation is never present in its input at all. `combatcheck.ts`
  proves this two ways: a hand-built scenario with one detected and one
  undetected enemy (the undetected one never appears in the output), and a
  400-action bot-vs-bot simulation sampling both sides' views every 15
  actions (0 violations below IDENTIFIED across the run). Shown as a
  dedicated, non-blocking readout under the SITREP banner; clicking an entry
  jumps the camera, matching the phase-10 event notification's affordance.
- **Concealment from stasis**: `stationaryConcealmentMultiplier` in
  `types.ts` cuts a target's detection range by 6% per consecutive round
  spent without a movement action, capped at 4 rounds (24%, floor 0.76) —
  layered into `detection.ts` `detectionRange` as a further multiplier
  alongside terrain and fortified concealment, computed server-side inside
  the same authoritative passive-spotting pass everything else uses (not a
  client-side trick). A deliberate sweep (Recon) only gets half the benefit.
  `combatcheck.ts` proves the multiplier's shape and cap, that it actually
  reduces `detectionRange`'s output, and an end-to-end sim confirming
  `roundsStationary` accumulates across real rounds and resets the instant a
  formation moves. Own-side indicator: a "concealed" chip on the unit card
  and a roster dot once it applies; withheld from the enemy exactly like
  `fortifyTier` (redacted to -1 below CONFIRMED — see `wirecheck.ts`'s
  `TRUE_AT` contract, which now classifies `roundsStationary`).
- **Balance simulation** (bot-vs-bot, real engine + real `decideBotAction`,
  paired before/after on identical seeds): HARD vs HARD, 40 games — before
  SABRE 19 / VANGUARD 21, avg 13.7 rounds, VP diff −8.2; after SABRE 19 /
  VANGUARD 21, avg 13.3 rounds, VP diff −4.6, Withdraw used in 2.43% of
  actions. Win split unchanged, game length essentially unchanged, and the
  side-balance gap actually narrowed. MEDIUM vs MEDIUM, 40 games — before
  SABRE 18 / VANGUARD 22, avg 12.6 rounds, VP diff −4.2; after SABRE 21 /
  VANGUARD 19, avg 12.8 rounds, VP diff +8.8, Withdraw used in 3.43% of
  actions — a real shift at MEDIUM, within the normal batch-to-batch variance
  this project's own prior balance passes already document (e.g. phase 3's
  +4.6 vs phase 5's −4.5 on the same matchup), not a sign of a broken bot: no
  game hit the 4000-action safety guard, and MEDIUM's weaker combined-arms
  reasoning already made it the noisier of the two difficulties before this
  phase.

**Group B — presentation (all client-side rendering; the server resolves
every action instantly and authoritatively exactly as before):**

- **Animated movement**: `MapCanvas.tsx` tracks a short (`MOVE_ANIM_MS` =
  260 ms) glide per formation, recomputed from wherever it is currently
  drawn to its new authoritative position every time `state.formations`
  actually changes — never from a locally predicted position. The player's
  own Move/Withdraw captures the real path from `planMove`/`planWithdraw`
  (the same pure functions the preview uses) and follows it exactly;
  opponent and bot moves (no client-side path available) glide straight-line
  between before/after. A further action arriving mid-glide restarts
  smoothly from the current on-screen point rather than snapping backward.
  **Multiplayer desync test**: two independent Playwright/Chromium browser
  contexts, a real Create-Room + Join round trip, one client issues a real
  `MOVE`, both clients read zero console/page errors throughout, and the
  mover's own unit-grid readout settles on the authoritative destination
  (confirmed identical across two samples 500 ms apart, i.e. the glide had
  actually finished and stopped, not drifted).
- **On-map combat effects**: a new `GameState.combatEvents` array (capped
  short, like `killFeed`), populated by `attackAction`, `artilleryAction`
  and `triggerOverwatch`. `fog.ts` `redactCombatEvent` — always shows the
  viewer's own participant at its true position; the OPPOSING participant's
  position is included only if this viewer's side has actually detected it
  (any contact rung, or ownership), otherwise it is collapsed onto the
  viewer's own tile so the client can still render "engaged here" without
  ever being handed an undetected shooter's or target's true position.
  `wirecheck.ts` gained a dedicated `auditCombatEvents` pass exercised
  across the whole bot-vs-bot fog audit (700k+ assertions, 0 failures).
  Direct fire draws a tracer + muzzle flash; standoff/overwatch fire draws a
  shell-burst; overwatch (which never produces a `BattleReport`) gets its
  own `sound.play('attack')` trigger so it is no longer silent — an ATTACK-
  order engagement is not double-triggered, since its existing
  `lastBattleReport`-driven cue already fires at the same instant.
- **Objective capture animation**: a colour-flip (old owner's colour to the
  new one, timed against `OBJECTIVE_FLASH_LIFETIME_MS` = 1.6 s) plus an
  expanding ring, driven off the same already-fog-safe objective-ownership
  diff the SITREP/event-notification pipeline already computes (objectives
  are never fog-gated).
- **Elevation-aware shadow**: every counter is drawn lifted off its true
  ground screen position by an amount proportional to the tile's continuous
  `height`, with a soft ellipse shadow left at the true ground point — same
  "token floats above its shadow" cue, capped small and applied uniformly in
  `drawFormation`.
- **Strength-cluster pips**: a 4-pip row along the bottom rim of the counter
  disc itself (inside the circle, below the arm silhouette), gated by zoom
  and by the same "strength is actually known to this viewer" rule the
  damage-state overlay already uses — positioned to avoid the fortify-tier
  pips (outside the disc, below the dig-in arc), the on-alert ring/badge
  (top-left, outside), and the detection badge (top-right, outside).
- **Movement breadcrumbs**: a thin, fading dashed line from a formation's
  position at the start of `state.round` (the latest `state.replay` entry,
  already fog-filtered) to its current position, drawn on the live map; the
  same idea reused in the Replay scrubber between consecutive viewed rounds.
- **Opening camera sweep / end-game cinematic**: two independent, one-shot
  effects (briefing dismissal; `state.phase === 'GAME_OVER'`) that set a
  short sequence of `camera` waypoints, reusing `MapCanvas`'s existing
  per-frame eased camera follow rather than a bespoke tween. Both are
  skippable on the first keypress or click. Playwright-verified: sampling
  the eased camera every 80 ms after an immediate `Escape` press during the
  opening sweep shows a single monotonically-decaying convergence to one
  fixed point (deltas 1.84 → 0.96 → 0.50 → … → 0.00, zero late-stage
  increases) — proof no further queued waypoint fired after the skip.
- **Event-location flash**: reuses the exact tile list the phase-10 batched
  notification already computes (fresh/upgraded contacts, kills, objective
  changes — all already fog-audited upstream), rendered as an immediate
  square pulse before the player ever clicks to jump.
- **Frame time** (Playwright/Chromium, 1600×950, same `__COMMAND_FRAME_MS__`
  smoothed readout prior phases used), measured in THIS sandboxed headless
  environment against a same-environment baseline (the phase-11 "~6.3–6.5 ms"
  figure was measured on different hardware, so it is not a valid direct
  comparison — see below): baseline (pre-phase-12 code, same host) **8.79 ms**
  idle; phase-12 code **8.05 ms** idle, **8.60 ms** under active bot combat
  (pings, kills, combat effects and objective flashes all firing). No
  regression — phase 12's numbers are flat-to-better than this
  environment's own baseline.
- **Fog-of-war audits**: `wirecheck.ts`'s `auditCombatEvents` (above) is the
  automated proof; Playwright confirms the visual layer renders without
  console/page errors across a real vs-Bot session (idle, under combat load,
  and across the two-client multiplayer exchange) with `roundsStationary`
  and `combatEvents` both added to the wire-redaction contract.

### Phase 9 (vertical insertion, fortify tiers, exploitation, UAV recon, mutual/buffed Reorganize, 12th/16th C4I Bn)

- `npm run build` (client `tsc -b` + Vite) and
  `npx tsc -p server/tsconfig.json --noEmit` — both clean.
- `npm run check` (mapcheck 60/60 seeds, wirecheck ~530k assertions over 6
  bot-vs-bot games including the new `auditReplay` pass, combatcheck) —
  all three suites pass, extended with dedicated sections for every phase-9
  mechanic: vertical insertion (redeploy, per-formation cap, adjacent-
  detected-enemy refusal, ZOC bypass, formation-type gating), fortify tiers
  (Hasty → Prepared → Entrenched climb, the defence-power difference between
  tiers, reset-on-move and reset-on-other-major-action), the exploitation
  bonus (triggers on a clean win, does not on a costly one, exact AP
  accounting), UAV recon (charge count, AP cost, detection upgrade with no
  LOS requirement, refusal once spent), mutual Reorganize (both orderings,
  non-adjacent formations excluded), the buffed Reorganize values, and the
  12-formation/AP-30/38 roster guard.
- **Balance simulation** — paired before/after at 12 formations/side using
  phase 8's own harness against an actual `git worktree` checkout of the
  pre-phase-9 commit; see "Side balance re-verified at twelve formations a
  side (phase 9)" above for the full table. Summary: MEDIUM 64.0/36.0 →
  52.0/48.0, HARD 68.0/32.0 → 48.0/52.0 — more even, not less.
- **A full HARD-vs-HARD game played out end-to-end** via `engine`/`bot`
  directly (no browser) to confirm the whole chain works through a real
  game rather than only in synthetic scenarios: reached `GAME_OVER` at
  round 11, `state.replay` recorded 11 rounds, `killFeed` had 8 entries, both
  sides fully spent their 3 UAV charges (6 sorties total) by end of game.
- **Playwright** (`/opt/pw-browsers/chromium`) against the combined built
  server (`tsx server/index.ts` serving `dist/`):
  - Landing page loads; Tutorial opens on a fresh load, section nav (click
    and the Next button) changes content, `M`/`A`/`S` pressed while it is
    open do not crash or close it, Escape closes it — see "Tutorial bug fix"
    below for what was actually wrong and the root cause.
  - A bot game starts; the Field Manual opens with `H`; `M` pressed while it
    is open does **not** arm Move mode behind it (no `.order-hint` appears);
    Escape closes the panel.
  - **Vertical insertion**, driven through the existing `window.__COMMAND_DEBUG__`
    QA hook (`net.sendAction`) against a real bot game rather than synthetic
    canvas coordinates: a Commando/Guards formation redeployed to the target
    tile and its `verticalInsertsUsed` counter incremented from 0 to 1.
  - **Fortify tiers**: fortifying set tier 0 immediately; ending our turn
    twice (waiting for the bot's reply each time) with the formation
    untouched climbed the tier to 1, matching the "one further round of pure
    holding" rule.
  - **UAV recon**: firing a sweep decremented `uavCharges` from 3 to 2 and
    the HUD counter (`data-testid="uav-charges"`) updated to match.
  - **Frame time**: 20 samples of `window.__COMMAND_DEBUG__.frameTimeMs`
    during a HARD bot game averaged **6.91 ms** (6.62–7.01 ms) — inside the
    phase 8 baseline of 6.8–8.3 ms.
  - Exploitation bonus and match replay were verified at the data/engine
    level (combatcheck + the full-game run above) rather than additionally
    driven through Playwright to a live decisive win / a live `GAME_OVER` —
    the former is stochastic to trigger on demand through real client play
    and the latter requires playing out a full round-limited or
    VP-threshold game in real time; both were judged adequately covered by
    the automated checks given the pass's time budget. See "Explicitly out
    of scope / deferred" above.
- **Tutorial bug fix — root cause and what was fixed.** The reported "it
  doesn't work" traced to two real issues in `App.tsx`'s single global
  `keydown` listener, both stemming from the same root cause: that listener
  is created unconditionally by a `useEffect` that runs on every render
  regardless of which JSX branch (`Lobby` vs. the live game) actually gets
  returned, since React hooks execute before the component's `if (!state ||
  !you) return <Lobby ... />` early return, not after it.
  1. **On the landing page**, with no game and no `state`/`you`, that same
     listener was still live underneath the Tutorial modal. It did not
     leak into a game (there was none yet), but it meant every keystroke —
     including `Space`, which the listener calls `preventDefault()` on to
     centre the camera — was being intercepted for no reason, and Escape
     was silently absorbed by the game listener's own (irrelevant, since no
     game exists) Escape-handling branches instead of ever reaching the
     Tutorial, so **Escape did not close it**. Fixed by making the listener
     bail out immediately whenever `!state || !you` — it now does nothing
     at all outside an active game.
  2. **In an active game**, the same listener's action-shortcut branch
     (`M`/`A`/`R`/`F`/`G`/`C`/`B`/`O`/`X`/`S`/`I`) had no check for whether
     the Legend or Field Manual overlay was open, so pressing e.g. `M` while
     reading the Field Manual armed Move mode in the background — exactly
     the "shortcuts leak through to the game underneath" failure mode the
     bug report named. Fixed by returning immediately after the panel-
     toggle keys (`Escape`/`?`/`L`/`H`) whenever `legendOpen || helpOpen` is
     true, before any further key is interpreted as a game shortcut.
  3. Additionally, since the Tutorial (and the Field Manual) can be opened
     from the landing page — before the in-game listener would exist even
     after the fix above — both `Tutorial.tsx` and `HelpPanel.tsx` now carry
     their own self-contained, capture-phase `keydown` handler: Escape
     closes them (calling `stopPropagation()`, so even a future change that
     re-introduces an underlying listener cannot see the keystroke), and the
     Tutorial additionally supports Left/Right arrow keys to step between
     sections. This is not just a workaround for issue 1 — it makes both
     panels correct in isolation, independent of whatever the caller does.

### Phase-5 refinement pass (task-force ORBATs, map design for engagement, side balance)

- `npm run build` (client `tsc -b` + Vite) and
  `npx tsc -p server/tsconfig.json --noEmit` — both clean.
- **Map soak** (`npm run mapcheck -- 120`): **120/120 pass (100%)** on 120
  independent seeds at 72×72 — water connectivity (one navigable body reachable
  from every naval spawn, port berth and anchorage, re-derived independently in
  the script by sailing from Sabre's first ship), land reachability of every
  land objective and deployment tile, river continuity, road-network
  connectivity and the speckle bound all hold. ~40 ms and 1.1 attempts per map.
  The chokepoint changes show up here: **~4.7 bridge tiles and ~180 road tiles
  per map, against ~14 and ~239 before**.
- **Wire-redaction re-verification** (re-created suite, 12 games × both
  viewers, all four rungs exercised — 117 Unknown, 96 Identified, 21 Confirmed,
  6 Contact): **1,868 assertions, 0 failures.** UNKNOWN enemies are absent from
  the payload and have no contact record; CONTACT sends a position-only record
  with no arm and no formation object; IDENTIFIED sends `-1` in every numeric
  field with generic identity strings, `fortified: false` and
  `lastOrder: 'Unknown'`; CONFIRMED comes through in full. The enemy's own
  contact table is emptied, the log is audience-filtered, and the *serialised*
  payload is searched for the true title of every below-Confirmed formation —
  none leaks. The ORBAT change did not regress any of this.
- **ORBAT assertions** (same suite): both task forces field exactly 10
  formations with unique designations, the same arm mix (3 infantry, 1 elite
  manoeuvre battalion, 1 armour, 1 artillery, 1 engineer, 1 C4I, 2 RSN
  squadrons), the exact designation lists above, no placeholder text anywhere,
  and total attack+defence within 5% of each other.
- **Playwright / chromium against the combined server** (built client served by
  `server/index.ts` on :8787), 16 checks in the single-player run plus a
  6-check two-client run, **0 failures**: the landing page names
  both task forces and contains none of the retired names; the field manual
  lists both ORBATs including 10/11 C4I Bn and 191/189 SQN; a vs-Bot (Medium)
  game starts with the seat reported as a task force and the initiative rolled;
  the roster lists the seat's ten designations in order and the HUD chip reads
  `TF SABRE`; the game was then played through to `GAME_OVER` — first enemy
  contact on round 5, first engagement on round 6, game over on round 10 — and
  the end-game screen read *"Task Force Vanguard secured the operation."* with
  `Final VP — TF SABRE 9 : TF VANGUARD 292`, matching the server state.
- **Two-client room** (create + join by code, both real WebSocket clients):
  the two seats were assigned to different task forces, both clients agreed on
  the rolled initiative, each client's roster carried exactly its own task
  force's ten designations, and neither client was sent a single undetected
  enemy formation at deployment.
- **Render frame time** re-measured through the existing
  `__COMMAND_FRAME_MS__` hook (smoothed, full redraw every animation frame,
  1600×950) at 4, 5, 9, 16 and 24 px/tile: **3.8 – 5.8 ms**, against the
  phase-4b baseline of 4.9 – 6.6 ms. No regression; the sparser road/bridge
  network is slightly cheaper to draw.
- **Grep**: zero remaining `BLUEFOR` / `REDFOR` / `Northern Union` / `MRB` /
  `SPB` / `TB` / `GRA` / `AEB` / `REB` / `GMF` / `MCF` / `24 C4I` references in
  code, UI text, tutorial, help or README, other than the one line in this
  document that records that `10 C4I Bn` replaced the fictional `24 C4I`.
- **Simulation** — engagement and balance numbers are in "Map design for
  engagement" and "Side balance" above; both were run on the real engine and
  the real `decideBotAction`, with `Math.random` seeded per game so the batches
  are reproducible. 240 games after the change (3 seed bases × 40 at each of
  MEDIUM and HARD) plus 120 games on the phase-4b tree for the before figures,
  and four separate controls to isolate the cause of the skew.


### Phase-3 refinement pass (front page, 72×72 board, map legibility)

- `npm run build` (client `tsc -b` + Vite) and `npx tsc -p
  server/tsconfig.json --noEmit` — both clean.
- **Map soak at the new size** (`npm run mapcheck -- 120`): 120 independent
  seeds on the 72×72 grid, **120/120 pass (100%)** — water connectivity, river
  continuity, road-network connectivity, land reachability and the independent
  "sail from Sabre's first ship to every spawn, berth and anchorage"
  re-derivation all hold. Typical map: ~1,927 water tiles (all one navigable
  body), ~222 river tiles, ~239 road tiles, ~14 bridges, ~994 forest tiles,
  20 objectives; 1.1 attempts and ~45 ms per map (was ~75 ms at 80×80).
- **Bot-vs-bot balance sim** over the real engine + real `decideBotAction`:
  - MEDIUM vs MEDIUM, 30 games: **13.1 rounds** average (8–19), 14 / 14 / 2
    draws, average final VP difference **+4.6** to the first-moving side.
  - HARD vs HARD, 24 games: **12.6 rounds** average (8–15), 11 / 12 / 1 draw,
    average VP difference −4.5.
  - First contact (any two opposing formations within 3 tiles) now happens on
    **round 5.1** on average, against **round 6.0** for the same code at
    80×80 — the size cut does exactly what it was meant to do.
- **Retuning that the size change required, and nothing else:** settlements
  6 → 5 (objectives 22 → ~20, so objective *density* is unchanged),
  named bridge crossings 4 → 3, and the minimum spacings for settlements,
  bridges, hills, airfields, depots and deployment rings scaled with the
  board. Artillery range 8 → 7 tiles keeps
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
  independent re-derivation in the script that sails from Sabre's first ship
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
    21 SA / 35 SCE / 10 C4I Bn / 185 SQN / 188 SQN);
  - **1 SIR performed a 2nd movement action in the same round and was then
    blocked from a 3rd** — after two bounds `computeReachable` returns zero
    tiles and the move is rejected server-side;
  - **185 SQN (frigate) sailed twice across open water** (13,66 → 18,68 →
    25,68) with 43 and then 75 reachable water tiles — no stranding;
  - the bot played four consecutive turns with no client or server errors,
    used its full 3/3 movement allowance on the opposing C4I battalion, and captured both land and
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
    `SABRE`/`VANGUARD` assignments confirmed via each client's own state.
  - **Quick Match flow:** two fresh contexts both hit Quick Match around the
    same time and were auto-paired into a fresh room with correct opposing
    side assignment.
  - **Move + fog-of-war:** drove a real `MOVE` action from Sabre through
    the wire; confirmed the server-applied result reflected back to the
    mover, and confirmed Vanguard's own filtered state exposed **only its own
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
