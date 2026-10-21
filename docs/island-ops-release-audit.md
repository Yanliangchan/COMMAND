# Island Ops — release audit, overhaul and test report

Branch `claude/island-ops-overhaul` (PR #3). Scope: Island Ops (the default
mode); the classic game (`#classic`) and its server were audited for release
and integration only.

## A. Audit report — initial condition

**Architecture.** Vite 5 + React 18 + TypeScript, SVG board, no engine.
`src/island/engine.ts` is a pure rules module (fog view, order validation,
round resolution); `bot.ts` plans from the fogged view only; the UI was one
1,000-line `GameScreen` plus a 2,200-line stylesheet grown in layers (v0.2,
v0.3) with many dead rules. Single player, all client side; only the setup was
persisted. Tests: `islandcheck` (rules + a 300-game bot sim) — no UI tests.

**Player journey.** Title → Deploy → plan (deploy/move/land/sail/strike/air
support/recon) → Ready → bots plan → resolve → step-by-step playback → round
report → … → end screen.

**How it was audited.** Five independent read-only specialist audits, run in
parallel with evidence for each finding (the seven requested roles were merged
into five agents): visual design; gameplay/game design (with simulation
experiments); adversarial QA (engine fuzzing, hostile input, Playwright UI
abuse); architecture + performance + production readiness (measured on
production builds with CPU throttling); UX + accessibility. Each produced a
ranked register with reproduction steps; they were consolidated below.

**Headline weaknesses found.**

- Gameplay: the difficulty selector changed nothing (player win rate flat at
  ~25–29% across levels); the attack picker hid defender bonuses (2.65 attacks
  a game failed only because of unshown bonuses); attacker ties were decided by
  seat order (the human always won them); retreating troops silently vanished;
  playback leaked exact numbers through the fog.
- Flow: an eliminated player was stuck forever; a corrupted saved setup could
  permanently disable Start; no error boundary (a render error blanked the
  page; a bot error soft-locked Ready); a reload lost the match.
- Visual: the phone map was unreadable (whole island 390px wide, 4px labels);
  panels and cards covered the map and the very battle they described; arrows
  vanished on your own territory; dimmed factions merged into mud; installation
  stars jumped onto the numbers (CSS transform overriding the SVG transform);
  ~20 label/badge/landmark collisions; colour was the only faction cue.
- Accessibility: map unplayable by keyboard; no modal focus handling; no mute.
- Performance: a coast-length `stroke-width` animation alone kept the main
  thread 51–90% busy; planning idle at 45–48% busy at 4× CPU throttle.
- Release: render-blocking Google Fonts (blank page on networks that drop the
  CDN); static-server path traversal served compiled server source; missing
  assets returned HTML (white screen after a deploy).

## B. Master defect register

Severity: P0 release blocker · P1 major · P2 important · P3 polish.
Status: **Fixed** (verified by the listed check) · **Accepted** (documented
risk) · **Open**.

### Fixed

| ID | Sev | Defect | Root cause / fix | Verified by |
| --- | --- | --- | --- | --- |
| VIS-01 / UX-04 | P0 | Phone map unreadable | Fixed 930×500 viewBox; camera with zoom/pan/pinch fitted to the free screen area, small screens open zoomed on your ground | e2e "phone: map opens zoomed" (badges 34px); screenshots |
| QA-02 / GD-05 | P1 | Eliminated player stuck forever | `planning` required being alive; "Watch to the end" runs bot-only rounds; dead players see through the fog | e2e "after elimination … end screen" |
| QA-01 | P1 | Corrupt saved setup kills Start | Loose validation (`FACTIONS['__proto__']`), saved before start; field allow-lists | e2e: 6 corrupt values |
| ARC-01 | P1 | No error boundary; bot error soft-locks Ready | Error boundary with Back/Discard; per-bot try/catch fallback | code + e2e corrupt-save checks |
| GD-01 | P1 | Difficulty does nothing | Only an attack margin differed; bot reinforcement handicaps | islandcheck matrix: 52/29/15% and 50/39/19% |
| GD-02 | P1 | Picker understates defence | Engine `defenceEstimate` (Ambush, gunfire, stronghold, possible air) shown with odds | islandcheck: 0 mismatches in 1,562 battles |
| GD-03 | P1 | Attack-everything dominates; defence never pays | Beaten defenders keep half and fall back; picker defaults to "enough to win", not "everything" | islandcheck measurement (adopted on criteria) |
| A11Y-01 | P1 | Map not keyboard-playable | Focusable regions, roving tabindex, arrow keys between neighbours, Enter acts | e2e: a full round by keyboard |
| A11Y-02 | P1 | Modals invisible to keyboard/AT | Shared focus trap, Escape, focus return | e2e help-dialog checks |
| A11Y-03 / RV-10 | P1 | Colour the only faction cue | Per-faction textures, emblems on badges and ships | CVD simulation screenshots |
| VIS-04 | P1 | Playback doesn't show where fights are | Camera focus + gunsight ring + clash mark; cards in the side column | screenshots |
| VIS-05 / RV-05 | P1 | Arrows invisible on own ground; tokens under badges | Casing on routes; tokens on the effects overlay | screenshots |
| VIS-06 | P1 | Dimmed regions muddy | Navy veil instead of saturate/brightness filter | screenshots |
| VIS-07/08, UX-02/09/10 | P1 | Overlays stack, cover the map; orders hidden ≤1100px | Layout zones with measured insets; side panel or bottom sheet | screenshots at 8 sizes |
| UX-03 / ARC-03 / QA-11 | P1 | Reload or Exit loses the match | Autosave on every change; Continue | e2e "reload keeps the match" |
| PERF-01 | P1 | Continuous full-board repaints | Coast/cloud/star/bob loops removed; ambience composited | planning idle 45–48% → 6–7% (4×) |
| REL-01 | P1 | Blank page if font CDN dropped | Self-hosted fonts per mode | browser test with all external hosts blocked: 0.6 s |
| UX-01 / UX-17 | P1 | No tutorial or legend | Encik's hint line coaches the first rounds; field manual with map key | e2e recon hint; screenshots |
| UX-05 / VIS-09 | P1 | Opponents/VP hidden on small screens | Fixed-order compact chips with VP bars | screenshots |
| — (found in rebuild) | P1 | Exit during playback, Continue → replan with the outcome known | Round saved before its playback | e2e "exit mid-playback" |
| RT / RV (found in retest) | P1 | Corrupt saved match crashes every Continue | Deep validation + dry run; malformed draft orders dropped; Discard on the error screen | e2e: 4 corrupt-save cases |
| RV-01/02/03 | P1 | Landscape phone: picker off-screen, cards and report covering the map | Picker bounded between bars; compact cards; bounded band | screenshots 844×390 |
| QA-03 / GD-07 | P2 | Retreating troops vanish | Retreat to any held origin or neighbour, else a "surrendered" report line | islandcheck scenario |
| QA-04 / GD-04 | P2 | Attacker ties go by seat order | Tied attackers bounce; the defender holds | islandcheck: all 6 seat orders |
| GD-06 | P2 | Split columns exploit clashes | Same-road orders merged | islandcheck scenario |
| GD-08 | P2 | Landings silently trimmed | Report line with numbers | islandcheck |
| GD-10 | P2 | Playback leaks fog | `seen` on steps; unseen fights show no numbers; `redactReport` | islandcheck + code |
| ARC-02 / QA-08 | P2 | HUD and engine disagree on legality | Engine `planSummary`/`orderIssues` drive the HUD; broken orders flagged live | islandcheck: 4,716 random plans, 0 disagreements |
| QA-05 / PERF-02 | P2 | Stale timers after Skip; battle steps ran 47% long | Playback director tracks every timer; step clock keyed on index | e2e "no stale banners" |
| QA-06 | P2 | Ready could resolve twice | Guard held until playback ends | e2e "double Ready" |
| QA-07 | P2 | Hostile orders crash the engine | Set-based lookups, kind checks, phase guard | islandcheck: 25 hostile sets + fuzz |
| REL-02 | P2 | Path traversal served server source | Containment check uses `DIST_DIR + sep` | 403 on `/%2e%2e/dist-server/...` |
| REL-03 | P2 | Missing asset → HTML → white screen | 404 for `/assets/*`; client reload screen | 404 verified |
| UX-06 / VIS-18 | P2 | Stars and air markers jump | Position on outer group, animate inner | screenshots |
| VIS-10/11 | P2 | Label/landmark/sector collisions | Measured nudges and label sides; sector labels dropped | geom check: ≤5 u² residual |
| VIS-12 / A11Y-04 | P2 | White on Tiger 2.2:1 | Faction ink colours | contrast check |
| VIS-13 | P2 | Ships indistinguishable | Faction-coloured warships with emblems | screenshots |
| VIS-14 | P2 | Emoji icons | Drawn SVG icon set | screenshots |
| VIS-15/16/17/19/20/21 | P2 | Zero states, dark band, effects under badges, defeat looks like victory, source vs target, sail arcs | Each fixed at its source | screenshots |
| UX-07 / QA-09, UX-08/11/12/13/14/15/16/18 | P2 | Recon/undo, Enter, toast placement, shared sorties, CAS highlight, colour-only report, mute, tap size, wording | Each fixed | e2e + screenshots |
| A11Y-05/06/07 | P2 | aria-pressed, live regions, reduced motion | Fixed | e2e + emulation |
| RV-04/06/07/08/09/11/12/13 | P2/3 | Dock wrapping, tab order, focus ring, end-dialog focus, tablet zoom, card text, spectator copy, touch keycaps | Fixed | screenshots, e2e |
| — (found in visual pass) | P2 | Ready glow animated box-shadow | Opacity on a separate layer | 45% → 13% busy at 4× |
| — (found in visual pass) | P2 | Wave drift re-blended the screen every frame in matches | Drift kept for the title only | playback 47 → 55 fps (1×) |
| — (found in rebuild) | P2 | Responsive rules lost to area stylesheets after the split | `:root:root` prefix on breakpoint rules | screenshots at 844×390 |
| REL-04/05/06 (part) | P3 | `tsx` as a runtime dependency; `.env.example` WS path; unused fonts; meta description | Fixed | build |

### Accepted / open (non-blocking)

| ID | Sev | Item | Why accepted |
| --- | --- | --- | --- |
| DEP-01 | P3 | `npm audit`: esbuild ≤0.24 (via Vite 5) — dev server only | `npm audit --omit=dev` is clean; the fix needs a Vite major upgrade, out of scope |
| REL-04 | P3 | `prestart` rebuilds on every `npm start` | Existing deploy behaviour on Railway may rely on it; changing it can't be verified from here |
| BAL-01 | P3 | Eagle 1.16× and Shark 0.87× of a fair share (inside the 0.8–1.2 gate) | Several retunes tried in simulation overshot; bots barely use the fleet |
| DIF-01 | P3 | Scripted newcomer wins 39% vs Regular (target 28–33%) | Two stand-ins pull in opposite directions; monotonic and ≥8-point steps hold |
| LOG-01 | P3 | The ops log isn't fog-filtered | Single player only; matters only for a future online mode |
| RV-14 | P3 | At 2560px the HUD is small next to the map | A CSS-zoom attempt misplaced measured insets; deferred rather than shipped fragile |
| PERF-03 | P3 | Playback main thread ~70% at 4× throttle (fps 38) | Richer effects; frame rate is above the previous build at both 1× and 4× |

## C. Visual overhaul

**Art direction kept:** bright tabletop diorama, saturated faction colours,
navy chrome, gold primary actions, the cream "paper" voice (Encik, toasts,
reports), Russo One + Nunito.

**Shared rules:** design tokens in `island.css` (palette, type scale 11–40px,
4-pt spacing, radii 8/12/18/999, three shadows, motion durations, 44px touch
target); one drawn icon set; faction colour + ink + texture + emblem.

**Screens redesigned:** title (collectible unit cards, animated lockup,
numbered setup), board (plinth and beach, bannered sea zones, warships, emblem
badges, capture flood, keyboard focus), HUD (zones that never cover the map,
dock with one row, picker with odds, side panel/sheet), playback (effects
overlay, rich cards), end screen (medal, confetti, standings), field manual.

Before/after screenshots were captured at 1366×768, 1920×1080, 1280×720,
1024×768, 768×1024, 390×844, 844×390 and 2560×1440 during the work.

## D. Implementation summary

- Engine: `engine.ts`, `bot.ts`, `types.ts` — rules fixes above; new
  `planSummary`, `orderIssues`, `defenceEstimate`, `redactReport`,
  `LEVEL_HANDICAP`.
- UI rebuilt into owned modules: `MapView` (board + camera), `Effects`,
  `usePlayback` (director), `GameScreen` (match), `Hud`, `Cards`, `EndScreen`,
  `TitleScreen`, `Help`, `Modal` + `useFocusTrap`, `plan.ts`, `save.ts`,
  `settings.ts`, `theme.ts`, `ErrorBoundary`; per-area stylesheets.
- Server: static containment, asset 404s, tighter CSP. `main.tsx`: per-mode
  self-hosted fonts and a load-failure screen.

## E. Test report

| Check | Result |
| --- | --- |
| `npx tsc -b` (client + server) | clean |
| `npm run build` | succeeds (client ~4 s + server tsc) |
| `npm run check` — mapcheck, wirecheck (620,972 assertions), combatcheck, islandcheck | 233 checks, 0 failures |
| islandcheck sim | 1,000 games: 7.5 rounds, 6.5 battles/round, 86% of attacks capture, 100% end on VP, shares 0.87–1.16× |
| islandcheck fuzz | 160 games / 1,117 rounds with random, passive and hostile seats: no exceptions, invariants hold |
| `npm run e2e` (Playwright, Chromium) | all checks pass (journeys + audit regressions) |
| Production server smoke | `/` 200; hashed asset 200; traversal 403; stale asset 404; `/healthz` 200 |
| Offline fonts | title renders in 0.6 s with every external host blocked; fonts load |
| `npm audit --omit=dev` | 0 vulnerabilities |

**Performance** (production builds, headless Chromium with software
rendering, 1366×768; CPU throttle as stated; numbers vary ±10 points run to run):

| Scene | Original | Now |
| --- | --- | --- |
| Title idle, 4× | 24–27% busy | 1–3% (settled) |
| Planning idle, 4× | 45–48% busy | 6–13% |
| Planning, Ready glowing, 4× | — | 13% (was 45% before the fix) |
| Playback, 1× | 47–48 fps | 55–56 fps |
| Playback, 4× | 31–37 fps | 38 fps |
| Bots + resolve per round (node) | median 1.6 ms | unchanged |
| JS heap over a 9-round game | — | no growth trend (no leak) |

**Not run / limits:** no real phones or GPUs — mobile was emulated
(viewport + touch) in Chromium only; no Firefox/Safari run; screen readers
were checked through ARIA structure, not with NVDA/VoiceOver.

## F. Remaining risks

The Accepted/Open table above is the full list. In addition: cross-browser
(Safari, Firefox) and real-device testing were not available in this
environment, and the balance numbers come from bot stand-ins, not human
playtests.

## G. Final release assessment

See the PR description for the verdict and the evidence that supports it.
