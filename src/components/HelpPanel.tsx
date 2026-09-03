import React, { useEffect, useState } from 'react';
import { ACTION_SPECS } from '../game/actions';

interface Topic {
  title: string;
  body: string;
}

const UNITS: Topic[] = [
  {
    title: 'Infantry',
    body: 'The backbone of your force. Tough in defence, especially in towns, forests and on hills. Slower than armour but able to hold ground that armour cannot.',
  },
  {
    title: 'Armour',
    body: 'Tanks. The hardest hitters in open country and the fastest way to cover ground, but they lose much of their edge in forest and built-up areas.',
  },
  {
    title: 'Commandos',
    body: "Task Force Sabre's elite manoeuvre battalion. Light, fast, and able to raid far behind enemy lines with a Special Op. They hit hard, and only the C4I battalion sees further, but they do not survive a stand-up fight.",
  },
  {
    title: 'Guards',
    body: "Task Force Vanguard's elite manoeuvre battalion, and the commandos' counterpart. Air-assault infantry: just as mobile, and they can go in by helicopter with a Special Op, but at shorter reach and with ordinary sensors. In exchange they are markedly tougher once they are on the ground and fight as formed infantry.",
  },
  {
    title: 'Artillery',
    body: 'Guns that strike seven tiles away with a Fire Mission — but only at an enemy you have already spotted, and only while they have rounds left (four, one back per round they hold their fire). Devastating against anything caught in the open, nearly useless against a target under cover, and nearly helpless if the enemy reaches them.',
  },
  {
    title: 'Engineers',
    body: 'Build a bridge across a river so your land units can cross, or clear an enemy position of its dug-in defences. Poor fighters — keep them behind the line.',
  },
  {
    title: 'Recon',
    body: 'The C4I / ISR battalion (10 C4I Bn and 12 C4I Bn for Sabre; 11 C4I Bn and 16 C4I Bn for Vanguard — each side fields two) is your sensor. It spots passively out to about 9 tiles where a rifle battalion manages 5 and a gun battalion 3, it identifies what it sees far faster, and it holds on to a contact for many rounds after everyone else has lost it. Its Recon order sweeps 14 tiles. It fights badly; its value is what it shows you.',
  },
  {
    title: 'Air support',
    body: 'A strike called in from off-map onto any enemy you can see. It costs a sortie, and you only get a couple of sorties per turn, so save them for something that matters.',
  },
  {
    title: 'Naval units',
    body: 'Frigates and littoral squadrons move on navigable water only, and they are standoff assets: a frigate engages out to NINE tiles and a littoral squadron to six, against seven for a land gun battalion, so a warship works a coastline from water nothing ashore can answer. That range works against ANY target within it, land or sea — a frigate can shell well inland, not just the coastline — as long as there is a clear line of sight from the ship: a ridge or high ground between the ship and the target blocks the shot exactly the way it blocks passive spotting. Naval fire damages but never occupies — only a close assault takes ground — and they carry four and three rounds respectively. They are also the only formations that can hold an Anchorage.',
  },
];

const CONCEPTS: Topic[] = [
  {
    title: 'The exercise',
    body: 'COMMAND is a fictional large-scale SAF force-on-force exercise. Two task forces drawn from the same armed forces fight each other over a fictional training area: TASK FORCE SABRE (1 SIR, 2 SIR, 5 SIR, 1 CDO BN, 40 SAR, 48 SAR, 21 SA, 35 SCE, 10 C4I Bn, 12 C4I Bn, 185 SQN, 188 SQN) and TASK FORCE VANGUARD (3 SIR, 8 SIR, 9 SIR, 1 GDS, 41 SAR, 42 SAR, 20 SA, 30 SCE, 11 C4I Bn, 16 C4I Bn, 191 SQN, 189 SQN). Both fight with the same weight of force: three rifle battalions, one elite manoeuvre battalion, two armoured battalions, guns, engineers, two C4I battalions and two RSN squadrons each — twelve formations a side. The formation names and their real-world character are drawn from public sources; which battalion is on which side, and every number in the game, are fictional.',
  },
  {
    title: 'Initiative',
    body: 'One task force moves first each round — which one is rolled at the start of the operation and shown in the log. Moving first is worth something: you reach the contested ground first and make the other side attack into it. Scoring is deliberately blind to it, though: each side is paid for the objectives it still holds once the OTHER side has finished replying, so neither ever gets the last word on its own score.',
  },
  {
    title: 'Terrain',
    body: 'The ground decides fights, twice over: it multiplies the defender\u2019s resistance directly (urban +35%, hills +30%, forest +25%, open −10%, beach −15%) and it selects which column of the arm-vs-arm matchup table applies. Urban, forest and hill tiles make a defender much harder to shift; open ground and beaches leave them exposed. Rivers stop land units until an engineer bridges them. Every tile on the sheet has a grid reference — column letter, row number, e.g. H-42 — and that is the reference used in the movement preview, the order log and the battle report.',
  },
  {
    title: 'Combat — how the numbers work',
    body: 'Both sides build one effective power by multiplying a short, published chain, and nothing is hidden. ATTACK = base attack × strength × readiness × morale × the arm-vs-arm matchup for the ground the defender is standing in × combined-arms support from adjacent friendly arms (+7% each, up to +21%). DEFENCE = base defence × strength × readiness × morale × terrain × how well that arm holds that kind of ground × ×1.30 if dug in × mutual support from adjacent friendlies (+5% each, up to +15%). One bounded roll of ±12% is applied to the attacker, and then the split decides everything: your share of the total combat power is the fraction of the losses the ENEMY takes, and their share is the fraction YOU take. An even fight costs both sides about 13% strength; a 3:1 fight costs the loser three times what it costs the winner. Attacking always costs something. Every single one of those factors appears in the pre-attack preview and again in the battle report — if you can read the preview you can predict the report.',
  },
  {
    title: 'Matchups — why combined arms works',
    body: 'The arm-vs-arm table is where combined arms comes from; it is not a bonus bolted on the side. Armour in open country is devastating against infantry (×1.45) and bogs down in a town or a wood (×0.70). Infantry are the arm that digs armour out of built-up ground (×1.30) and are poor against it in the open (×0.85). Guns are murderous against anything exposed (×1.50 against infantry in the open, ×1.80 against unescorted guns and sensors) and nearly useless against a target under cover (×0.65–0.80) — and halve their power again if they are dragged into a close assault. Warships shell a coastline hard and cannot reach into a city. Engineers and the C4I battalion fight badly against everything. On defence, infantry hold close country ×1.20 better than the terrain bonus alone, armour ×0.85 worse. So: lead with armour in the open, lead with infantry into towns and forests, and put the guns onto whatever is caught in the open.',
  },
  {
    title: 'The pre-attack preview',
    body: 'Press A and hover a target. Before you spend anything, the panel shows the likely outcome, the expected strength loss to BOTH sides as a range, your share of the total combat power as a bar, and the factors for and against you, biggest first. Against a CONFIRMED formation the range is tight — it only has to cover the ±12% combat roll. Against one you have merely IDENTIFIED you do not know its strength, its morale, or whether it is dug in, so the panel says so out loud, lists what it is assuming, and the range opens right out. The battle report afterwards is the same information with the roll filled in.',
  },
  {
    title: 'Ammunition',
    body: 'Only artillery and the two naval squadrons carry ammunition: four ready fire missions for a gun battalion or a frigate, three for a littoral squadron, drawn as pips on the unit card. Firing spends one. Any round in which a formation does not fire, it gets one back. There is no depot, no radius and no resupply order — the only thing ammunition does is stop the guns and the ships firing every single turn forever.',
  },
  {
    title: 'Overwatch & reaction fire',
    body: 'End a formation’s turn WITHOUT spending its major action (it may still have moved) and it goes ON ALERT for the opponent’s following turn — no order, no AP, it is the reward for holding rather than acting. A pulsing red ring and a "!" badge mark it on the map and in its unit card. During the opponent’s turn, if an enemy formation moves into a tile within the alert formation’s weapons range AND its detection range and line of sight — the exact model passive spotting uses, so it only reacts to what it could legitimately see — it fires ONE reduced-power shot (about 55% of a normal attack) through the same combat chain a normal attack uses, at no cost to itself. One alert formation fires at most once per opponent turn, however many enemies pass near it. Artillery never stands overwatch — it is not a direct-fire weapon. The alert clears the moment the formation’s own next turn begins, or the instant it spends its major action.',
  },
  {
    title: 'Zones of Control',
    body: 'Every land formation except artillery projects a Zone of Control into its four adjacent tiles — shown as red hatching automatically while Move is armed. An enemy formation MOVING THROUGH one of your ZOC tiles has its bound end there: it may still enter and stop on the tile, it just cannot use it as a step to somewhere further, so a move that needs to pass beyond it is refused with the reason spelled out, or has to route around. Leaving a ZOC tile your formation STARTED its move standing in — disengaging from contact — costs a full movement action’s worth of points on the spot, itemised in the movement preview as soon as you hover a destination. Naval formations neither project nor are affected by ZOC.',
  },
  {
    title: 'Withdraw (retreat)',
    body: 'Press W with a formation that is genuinely in trouble — adjacent to a detected enemy, standing inside an enemy Zone of Control, or badly hurt (low strength or Shaken/Broken morale) — to disengage automatically, falling back away from the nearest detected threat. It is deliberately cheaper than an ordinary Move that has to pay the ZOC disengagement surcharge: that surcharge alone costs a Move its entire single-action budget on the first step, usually forcing a second action (2 AP) just to actually get clear, where Withdraw is a flat 1 AP for a shorter bound. It still spends one of the formation’s movement actions and it does NOT dodge overwatch — an alert enemy covering the ground it crosses fires exactly as it would on a normal move. A healthy formation with nothing threatening it cannot Withdraw; that is what Move is for.',
  },
  {
    title: 'Suppression',
    body: 'A battlefield condition separate from strength, morale and readiness — shown as its own purple bar on the unit card, never folded into another stat. Artillery, naval standoff fire and air strikes apply a heavy dose (30); a direct assault applies a smaller amount too (12). Suppression cuts the SUPPRESSED formation’s own attack power and movement range, up to -50% at maximum — it never causes strength loss by itself, that is what the damage numbers are for. It decays 25 points a round it is not refreshed, faster in forest, built-up ground or while dug in (cover lets a unit recover its composure), slower in the open (there is nowhere to get out of the beaten zone). The pre-attack preview and the battle report both show how much suppression an engagement will apply, right alongside the expected losses.',
  },
  {
    title: 'Reorganize',
    body: 'Press S with any formation selected to stand it down for the round: readiness +38, morale +20 and strength +12 (buffed this pass — meaningfully more than before, but still well short of a full heal). It is deliberately not a return of the old supply system — no depot, no radius, nothing to manage — but it is gated so it cannot flatten out what combat did: it costs the formation’s major action AND requires it to have made NO movement action this round ("stand down to reorganize"), and it cannot be used again for three rounds. A formation on cooldown says so on its unit card. Two ADJACENT friendly formations that both Reorganize the same round get an extra mutual bonus (+10 readiness, +6 morale each) on top.',
  },
  {
    title: 'Prepared-defence tiers',
    body: 'Fortify now accumulates. A fresh dig-in is Hasty (the same +30% defence bonus Fortify always gave). Hold it — no move, no other major action, nothing at all — for a further round and it becomes Prepared (+45%); hold it one more round and it reaches Entrenched (+60%), also resisting suppression better. Moving, attacking, or spending the major action on anything else (even Reorganize) throws it back to Hasty. The dug-in arc on the map and the unit card show the current tier, and the pre-attack preview and battle report both name it.',
  },
  {
    title: 'Exploitation bonus',
    body: 'A clean, low-cost decisive win — Position Captured with None or Light losses to the attacker — earns an immediate 1 AP rebate that same turn, so a genuine breakthrough leaves you with more to do with that formation right away. The battle report calls it out as "Breakthrough — bonus AP granted".',
  },
  {
    title: 'Vertical insertion',
    body: 'Commandos and Guards only (I, 4 AP). Redeploy up to 14 tiles in one leap, bypassing normal movement, road bonuses and Zones of Control entirely — the point of a vertical envelopment. The landing zone must be clear ground you can occupy and NOT adjacent to any enemy formation your side has actually detected. Capped at 2 uses per formation for the whole operation, so it is a rare tool for the decisive moment, not an extended move.',
  },
  {
    title: 'UAV recon',
    body: 'A player-level asset, not a formation order — 3 sorties for the whole game, shown as a small counter next to VP in the top bar. Spending one (U, 3 AP) reveals a 7-tile radius anywhere you designate for that round, upgrading detection directly with no formation, sight or line-of-sight requirement of its own. Rare and strategic: save it for ground you are about to commit forces to blind.',
  },
  {
    title: 'Match replay',
    body: 'Once the operation ends, "Review Replay" on the end-game screen opens a scrubber over what happened, round by round: positions, objective markers and that round’s log entries. Prev/next/play, or the arrow keys. It is a review tool, not a frame-perfect re-simulation.',
  },
  {
    title: 'Destruction',
    body: 'A formation reduced to 0 strength is destroyed: a brief cross-marker flashes at the spot on the map for a few seconds, on both sides, and a log line names it — "40 SAR destroyed at grid H-42" for the side that owned it. The OTHER side is told only as much as its own detection had actually established: a formation it had CONFIRMED is named in full, one it had only IDENTIFIED is named by arm ("Enemy Infantry destroyed at grid H-42"), and one it never legitimately detected is not mentioned at all — the fog of war applies to a kill exactly the way it applies to everything else.',
  },
  {
    title: 'Morale',
    body: 'Morale is a long-term condition, not a running total. Every formation has a normal level it sits at and drifts back toward. Routine movement and small engagements do not shift it at all. What does: heavy casualties, a major attack repulsed, being driven off a position, losing an objective you held, losing a battalion nearby, or being surrounded or isolated. It recovers several points each round when a formation is out of contact, holding its ground and near friendly forces — and taking an objective lifts it. Elite has to be earned and cannot be farmed. The five bands — Elite, Steady, Stressed, Shaken, Broken — still multiply combat power, so a broken formation is a real liability.',
  },
  {
    title: 'AP (Action Points)',
    body: 'Your whole side shares a pool of Action Points each turn. Every order spends some: moving costs 1, attacking 2, an air strike 3. When the pool runs low you must choose what matters most.',
  },
  {
    title: 'Movement',
    body: 'Every formation publishes two numbers on its unit card: Movement — how many tiles one bound covers over ordinary ground — and Movement Actions — how many bounds it may make per round, e.g. "2 / 2", dropping to "1 / 2" once it has moved. Infantry cover roughly 3.6 tiles a bound, armour and the fast units more, artillery and engineers about the same so the guns and the bridging plant can keep pace with the formations they support. Each bound also costs 1 AP. Arm Move with M and hover a tile: the preview names the grid reference, the distance, how hard the going is, the road bonus and how many movement actions the bound needs, before you commit.',
  },
  {
    title: 'Roads',
    body: 'Roads are a real operational advantage, not a rounding error. A road tile costs a flat, published price instead of its terrain cost: infantry manage roughly 3&ndash;4 tiles cross-country but around 5 along a road, and mechanised formations — armour, artillery, engineers, recce — roughly double their reach on a road. Armour and the heavy support units also pay a surcharge in forest and built-up ground, so tanks are fastest exactly where you would expect: roads and open country.',
  },
  {
    title: 'Move Formation',
    body: 'Shift-click two or more of your own formations (on the map or in the roster) to group them, then press Shift+M and click a destination. The whole group advances together, paced to its SLOWEST member, so an infantry-and-armour or armour-and-engineer pairing arrives as one. Each formation spends its own movement action and 1 AP — the total is shown before you confirm — and any formation that has no movement actions left is named rather than quietly dropped. It is entirely optional: ordinary single-unit movement is unchanged.',
  },
  {
    title: 'Formation cohesion',
    body: 'Artillery and engineers work for a manoeuvre formation. If a move would leave one more than six tiles from the formation it supports, the preview says so — "35 SCE is becoming separated from supported formation". It is advice, never a veto: proceed if you mean to.',
  },
  {
    title: 'Objectives',
    body: 'The marked locations — districts, bridges, ports, airfields, depots, anchorages. Occupy one to take control. An objective is only paid for once your opponent has had their reply and you are STILL holding it, so ground you take and immediately lose scores nothing: objectives have to be held, not merely touched. Objectives are not all worth the same. The ones on the axis between the two deployment areas — the towns, the trunk river crossings, the commanding hills — are worth two to three times a rear-area objective, so a force that stays home cannot reach the threshold in the time available. First to 280 VP, or the higher score after 24 rounds, wins.',
  },
  {
    title: 'Spotting — you do NOT need to Recon to see',
    body: 'Every formation watches its surroundings all the time, for free. If it has line of sight and an enemy comes inside its detection range, you see that enemy — on your turn or in the middle of the opponent\u2019s. Detection range depends on the formation (recon 9 tiles, commandos 7, warships 7-8, infantry and armour 5, engineers 4, artillery 3), on the ground you are standing on, on the ground the enemy is hiding in, and on height. A banner at the top of the screen tells you when something new is spotted and the map pings the tile — click either to jump there.',
  },
  {
    title: 'Line of sight and elevation',
    body: 'Sight is a ray across the map, not a circle. The game walks the height profile between the two tiles: ground higher than the sightline blocks it outright, and forest, housing and industrial fabric both raise that skyline and pile up haze that shortens your effective range. So elevation matters twice over — a battalion on a ridge sees roughly a third further AND sees over the low ground in between, while the same battalion in a valley wood is nearly blind. Open ground and hilltops are good places to watch from (×1.15 and ×1.35); forest and urban districts are bad ones (×0.55 and ×0.50). The same terrain conceals: an enemy sitting in a town is found at about half the distance it would be in the open, and digging in helps it hide too.',
  },
  {
    title: 'Detection states',
    body: 'What you know about an enemy is a four-rung ladder. UNKNOWN — nothing; the game does not even tell your client it exists. CONTACT — a hollow dashed "?" blip: something is at that grid, and that is all, e.g. "CONTACT · Unknown Enemy · Grid F-42 · Confidence 58%". IDENTIFIED — a dashed counter with the arm and a "?" badge: enemy infantry, say, but not which battalion and not how strong. CONFIRMED — a solid counter with a "✓" badge and the real designation. Confidence rises with closer, clearer and repeated observation (once per round), and with recon assets; it decays every round once you lose sight, sliding a Confirmed formation back down to a stale last-known-position marker. Identification does NOT change how hard you hit — if you can see a target well enough to engage it, you fight just as well. What it changes is how well you can PREDICT the engagement before committing to it.',
  },
  {
    title: 'Concealment from stasis',
    body: 'A formation that holds its ground — no movement action for a whole round or more — gets progressively harder to spot, on top of whatever terrain and fortification concealment it already had. It is a real reduction in the enemy’s detection range against it (up to about a quarter shorter after four rounds stationary, capped there — never invisible), computed server-side as part of the same authoritative spotting pass as everything else, so it holds up in multiplayer exactly like any other detection rule. A small "concealed" chip appears on your OWN unit card once it applies; you learn nothing new about how well an ENEMY formation is concealed beyond what your detection of it already tells you. Moving resets the streak to zero immediately.',
  },
  {
    title: 'Priority targets',
    body: 'While it is your turn, a small readout under the SITREP banner names the one or two enemy formations that most threaten your position right now, based only on what your own side has actually detected — an enemy you have merely spotted as a CONTACT blip never appears here, since the readout needs to know the arm to estimate its reach. Click an entry to jump the camera to it, the same as the event notification’s jump-to-tile. It updates live through your turn as your detection picture improves — it is not just a one-shot snapshot at turn start.',
  },
  {
    title: 'Briefing, SITREP and sound',
    body: 'Every match opens on a pre-battle briefing — who you command, the opponent, the victory condition, and both rosters’ arm counts side by side — that dismisses on its own after a few seconds or the moment you click Begin. At the start of each of your own turns a one-line SITREP fades in summarising what changed while it was not your turn (new contacts, objectives that changed hands, losses on either side, artillery that rearmed) — dismissible with a click, never blocking. The amber jump notification, extended from the original contact-detected banner, now covers any decisive, legitimately-detected event — new/upgraded contacts, a kill, an objective changing hands — batched into one clickable banner that centres the camera on it. A small Sound control in the top-right toolbar mutes or sets the volume of the game’s short synthesized cues; the choice is remembered on this device, and sound only ever plays for something your own side has actually detected.',
  },
  {
    title: 'Recon vs normal spotting',
    body: 'Ordinary troops detect nearby enemies. Recon sees further, sooner, and knows what it is looking at — and what that buys you is CERTAINTY, not firepower. Attacking an unconfirmed formation costs you nothing in combat power; it costs you the ability to know what you are walking into, because the preview has to guess at the target\u2019s strength, morale and defences and shows you a wide band instead of a number. Confirm it first and the prediction becomes reliable. The R order is worth its AP because it does five things passive spotting does not: it uses a much longer sensor range (14 tiles for C4I, 11 for commandos, against 9 and 7 passively), it pushes through forest and built-up ground instead of being stopped by it, it adds a flat confidence bonus that jumps contacts up the ladder in one go, it marks what it finds as recon-tracked so those contacts decay far more slowly, and it re-fixes stale contacts you are about to lose. A Special Op by the commandos (6 tiles) or the Guards (4 tiles) can also probe behind the lines and confirm whatever is around the objective it lands on.',
  },
  {
    title: 'Scenarios',
    body: 'Every match — vs-Bot, Quick Match, or a Create Room host who leaves the map on "Random from pool" — draws its 72×72 battlefield from a fixed pool of ten named scenarios: Sarimbun Crossing, Kranji Approaches, The Jurong Line, Bukit Timah Heights, Bukit Chandu, Choa Chu Kang Corridor, Ama Keng Crossroads, Chong Pang Village, Paya Lebar Flats and Toa Payoh Basin. The names are drawn from real Singapore places and history — Battle-of-Singapore ground and cleared kampongs — but the terrain itself is procedurally generated and fictional: it is a themed scenario over the same generator as ever, not a depiction of the real place. The scenario name is shown on the pre-battle briefing, and a Create Room host can pin a specific one instead of a random pick.',
  },
  {
    title: 'Sandbox mode',
    body: 'A free-placement practice screen, reached from the landing page next to Tutorial. No AP limit, no turn structure, no opponent, no win condition — both full rosters are on the board from the start, and every order runs against the real combat/movement rules with AP, moves and ammo replenished after each one, so nothing ever runs dry. Reposition a formation anywhere passable for a clean setup, then Move, Attack, Recon or Fortify to see exactly what beats what. Reset starts over on a fresh curated map; Esc exits to the landing page.',
  },
  {
    title: 'Spectating',
    body: 'A third client can watch an already-started room read-only by entering its room code under "Spectate a match" on the landing page. A spectator sees the FULL, unredacted board — both sides confirmed, no fog of war, since a non-combatant has nothing to hide from — and cannot issue any order; the client blocks it and the server independently refuses any action message from a spectator connection. A clear SPECTATING banner marks the view. Spectating a room that has not started yet, or one that has already finished, is refused with a clear reason.',
  },
  {
    title: 'Custom match rules',
    body: 'Creating a room (not Quick Match, which always uses the defaults) offers "Custom rules…": AP per turn, VP victory threshold, round limit, which of the ten curated scenarios to use (or a random pick from the pool), and who moves first — random, you, or your opponent. The server validates every value against sane bounds and refuses an invalid ruleset with a clear reason rather than silently clamping it. Whatever is chosen is shown to the joining player before the match starts and again on the pre-battle briefing, so both sides always know the rules they are playing under.',
  },
  {
    title: 'Last stand',
    body: 'The first time — and only the first time — a formation’s strength drops below 20%, it fights a last stand: a one-time, temporary bonus to both its attack and defence power for the next few rounds, cornered and hitting back harder rather than just bleeding out. It is marked with a small red-star chip on the unit card and roster row, distinct from fortify, suppression and on-alert, and it appears as a named "Last stand" factor in the pre-attack preview and battle report whenever it applies. It never re-arms once spent, even if the formation recovers strength and later falls below the threshold again.',
  },
  {
    title: 'Shareable replay links',
    body: 'Once a match ends, the end-game screen offers a short "Copy link" next to Review Replay — a `?replay=CODE` URL anyone can open, with no account, room or session of their own, to watch that exact match’s replay standalone. It shows the same fog-of-war caveat a live player’s own replay does (each side’s final detection, not a per-round reconstruction of what was known when) — pick SABRE’s or VANGUARD’s view from the toggle at the top. Saved replays are kept server-side well past a room’s own short cleanup window, but this is still an in-memory prototype server: a restart of the server loses saved replays, same as it loses everything else that is not the file on disk.',
  },
];

export const HelpPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<'units' | 'concepts' | 'keys'>('units');

  // Self-contained Escape-to-close: the Field Manual is reachable from the
  // landing page (before the in-game App-level shortcut handler exists) as
  // well as from an active game, so it cannot rely on the caller for this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="floating-panel help-panel" data-testid="help-panel">
      <div className="floating-head">
        <span>FIELD MANUAL</span>
        <button className="icon-btn" onClick={onClose} title="Close (?)">
          ✕
        </button>
      </div>
      <div className="help-tabs">
        <button className={tab === 'units' ? 'on' : ''} onClick={() => setTab('units')}>
          Units
        </button>
        <button className={tab === 'concepts' ? 'on' : ''} onClick={() => setTab('concepts')}>
          Concepts
        </button>
        <button className={tab === 'keys' ? 'on' : ''} onClick={() => setTab('keys')}>
          Shortcuts
        </button>
      </div>
      <div className="floating-body">
        {tab !== 'keys' &&
          (tab === 'units' ? UNITS : CONCEPTS).map((t) => (
            <div className="help-topic" key={t.title}>
              <b>{t.title}</b>
              <p>{t.body}</p>
            </div>
          ))}
        {tab === 'keys' && (
          <div className="key-grid">
            {ACTION_SPECS.map((a) => (
              <div key={a.id}>
                <kbd>{a.shortcut}</kbd> {a.label}
              </div>
            ))}
            <div>
              <kbd>⇧M</kbd> Move Formation (grouped)
            </div>
            <div>
              <kbd>⇧click</kbd> Add / remove from group
            </div>
            <div>
              <kbd>U</kbd> UAV recon sweep (player-level, capped charges)
            </div>
            <div>
              <kbd>E</kbd> End turn
            </div>
            <div>
              <kbd>Tab</kbd> Next formation with orders
            </div>
            <div>
              <kbd>Z</kbd> Centre on selected unit
            </div>
            <div>
              <kbd>Esc</kbd> Cancel targeting
            </div>
            <div>
              <kbd>L</kbd> Map legend
            </div>
            <div>
              <kbd>?</kbd> This manual
            </div>
            <div>
              <kbd>↑↓←→</kbd> Pan the map
            </div>
            <div>
              <kbd>+ / −</kbd> Zoom in / out
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
